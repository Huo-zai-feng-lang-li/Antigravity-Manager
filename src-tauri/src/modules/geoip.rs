//! 在线 GeoIP 归属地批量查询与本地缓存。
//!
//! 设计原则：
//! - 展示路径零网络：查询接口先返回数据，本模块在后台异步补全归属地并落库，
//!   前端稍后重新拉取即可看到；
//! - 只查公网 IP，本机/内网/链路本地直接跳过；
//! - 单飞（single-flight）去重，避免多个页面同时触发打爆免费额度；
//! - 主数据源为百度 IP 画像（国内 IPv6 准确度高，免鉴权单 IP 查询，串行限流），
//!   ip-api.com batch 作为网络失败/查无结果时的降级源；
//! - 任何网络/解析失败都静默降级为"未知"，并写失败记录限制重试频率。

use crate::modules::ip_util::classify_ip;
use crate::modules::security_db::{self, IpGeoInfo};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

/// 百度智能云 IP 画像接口（免鉴权，需带 Referer，单 IP 查询，国内 IPv6 数据准确）。
const BAIDU_URL: &str = "https://qifu.baidu.com/api/v1/ip-portrait/brief-info";
const BAIDU_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
/// 百度为非官方免费接口，串行查询并保守限流，避免触发风控。
const BAIDU_INTERVAL: Duration = Duration::from_millis(120);

/// ip-api.com 免费 batch 接口（单批最多 100 个，免费版仅 HTTP），作为降级源。
const BATCH_URL: &str =
    "http://ip-api.com/batch?fields=status,message,country,regionName,city,isp,query";
const BATCH_SIZE: usize = 100;

static ENRICH_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Deserialize)]
struct BatchItem {
    status: String,
    #[allow(dead_code)]
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    country: Option<String>,
    #[serde(rename = "regionName", default)]
    region_name: Option<String>,
    #[serde(default)]
    city: Option<String>,
    #[serde(default)]
    isp: Option<String>,
    query: String,
}

#[derive(Debug, Deserialize)]
struct BaiduResponse {
    code: i64,
    #[serde(default)]
    data: Option<BaiduData>,
    #[allow(dead_code)]
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BaiduData {
    #[serde(default)]
    country: Option<String>,
    #[serde(default)]
    province: Option<String>,
    #[serde(default)]
    city: Option<String>,
    #[serde(default)]
    isp: Option<String>,
    /// 应用场景：基站 / IDC / 普通宽带 等
    #[serde(default)]
    scene: Option<String>,
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// 判断百度 scene（应用场景）字段是否有展示价值。
/// 空串、"普通"、"未知"、"--" 等占位值一律视为无意义。
fn is_meaningful_scene(scene: &str) -> bool {
    let s = scene.trim();
    !s.is_empty() && s != "普通" && s != "未知" && s != "--" && s != "-"
}

/// 解析百度 IP 画像响应。
///
/// `Ok(None)` 表示接口正常但查不到该 IP（如保留地址）；`Err` 表示网络/协议失败，
/// 调用方应降级到 ip-api。
pub fn parse_baidu_response(body: &str) -> Result<Option<IpGeoInfo>, String> {
    let parsed: BaiduResponse = serde_json::from_str(body).map_err(|e| e.to_string())?;
    if parsed.code != 200 {
        return Ok(None);
    }
    let Some(data) = parsed.data else {
        return Ok(None);
    };
    if data.country.is_none()
        && data.province.is_none()
        && data.city.is_none()
        && data.isp.is_none()
    {
        return Ok(None);
    }

    // scene（基站/IDC 等）拼入运营商，帮助用户判断 IP 类型；空值/无意义值跳过。
    // 百度对非浏览器 TLS 指纹会概率性把 scene 降级返回为"未知"，这类值拼进去
    // 只会误导用户（实测归属地本身仍准确），故与"普通"一样忽略。
    let scene = data.scene.filter(|s| is_meaningful_scene(s));
    let isp = match (data.isp, scene) {
        (Some(isp), Some(scene)) => Some(format!("{isp}（{scene}）")),
        (Some(isp), None) => Some(isp),
        (None, Some(scene)) => Some(scene),
        (None, None) => None,
    };

    Ok(Some(IpGeoInfo {
        country: data.country,
        region: data.province,
        city: data.city,
        isp,
    }))
}

/// 解析 ip-api batch 响应。
///
/// success 项映射为 `Some(IpGeoInfo)`，fail 项（如 private range）映射为 `None`，
/// 调用方据此写失败缓存，避免重复查询。
pub fn parse_batch_response(body: &str) -> Result<Vec<(String, Option<IpGeoInfo>)>, String> {
    let items: Vec<BatchItem> = serde_json::from_str(body).map_err(|e| e.to_string())?;
    Ok(items
        .into_iter()
        .filter(|item| !item.query.is_empty())
        .map(|item| {
            let geo = if item.status == "success" {
                Some(IpGeoInfo {
                    country: item.country,
                    region: item.region_name,
                    city: item.city,
                    isp: item.isp,
                })
            } else {
                None
            };
            (item.query, geo)
        })
        .collect())
}

/// 查询单个 IP 的百度归属地。
async fn query_baidu(ip: &str) -> Result<Option<IpGeoInfo>, String> {
    let url =
        reqwest::Url::parse_with_params(BAIDU_URL, &[("ip", ip)]).map_err(|e| e.to_string())?;
    let body = http_client()
        .get(url)
        .header("Referer", "https://qifu.baidu.com/")
        .header("User-Agent", BAIDU_UA)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    parse_baidu_response(&body)
}

/// 批量查询 ip-api（降级源），返回 ip -> geo 映射。
async fn query_ipapi_batch(ips: &[String]) -> Result<HashMap<String, Option<IpGeoInfo>>, String> {
    let body = http_client()
        .post(BATCH_URL)
        .json(ips)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let parsed = parse_batch_response(&body)?;
    Ok(parsed.into_iter().collect())
}

/// 触发后台归属地补全（触发即忘）。`enabled=false` 时直接跳过，零外发。
pub fn spawn_enrich(ips: Vec<String>, enabled: bool) {
    if !enabled {
        return;
    }
    let public_ips: Vec<String> = ips
        .into_iter()
        .filter(|ip| classify_ip(ip).needs_geoip())
        .collect();
    if public_ips.is_empty() {
        return;
    }
    if ENRICH_IN_FLIGHT
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    tokio::spawn(async move {
        let _reset = FlightGuard;
        if let Err(error) = enrich_inner(public_ips).await {
            tracing::warn!("GeoIP enrich failed: {error}");
        }
    });
}

/// RAII 守卫，任务结束（含 panic）后释放单飞锁。
struct FlightGuard;
impl Drop for FlightGuard {
    fn drop(&mut self) {
        ENRICH_IN_FLIGHT.store(false, Ordering::SeqCst);
    }
}

async fn enrich_inner(ips: Vec<String>) -> Result<(), String> {
    let unique: Vec<String> = {
        let mut seen = std::collections::HashSet::new();
        ips.into_iter()
            .filter(|ip| seen.insert(ip.clone()))
            .collect()
    };

    for chunk in unique.chunks(BATCH_SIZE) {
        let stale = tokio::task::spawn_blocking({
            let chunk = chunk.to_vec();
            move || security_db::get_stale_geo_ips(&chunk)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e)?;
        if stale.is_empty() {
            continue;
        }

        // 第一轮：百度逐个查询（串行限流）。未出结果的 IP 收集后走 ip-api 降级。
        let mut results: HashMap<String, Option<IpGeoInfo>> = HashMap::new();
        let mut fallback_ips: Vec<String> = Vec::new();
        for (index, ip) in stale.iter().enumerate() {
            if index > 0 {
                tokio::time::sleep(BAIDU_INTERVAL).await;
            }
            match query_baidu(ip).await {
                Ok(Some(geo)) => {
                    results.insert(ip.clone(), Some(geo));
                }
                Ok(None) => {
                    results.insert(ip.clone(), None);
                    fallback_ips.push(ip.clone());
                }
                Err(error) => {
                    tracing::debug!("GeoIP baidu query failed for {ip}: {error}");
                    fallback_ips.push(ip.clone());
                }
            }
        }

        // 第二轮：ip-api batch 降级，仅覆盖百度未给出归属地的 IP。
        if !fallback_ips.is_empty() {
            match query_ipapi_batch(&fallback_ips).await {
                Ok(batch) => {
                    for ip in fallback_ips {
                        if let Some(geo) = batch.get(&ip) {
                            results.insert(ip, geo.clone());
                        }
                    }
                }
                Err(error) => {
                    tracing::warn!("GeoIP ip-api fallback failed: {error}");
                }
            }
        }

        tokio::task::spawn_blocking(move || {
            for ip in &stale {
                // 两轮都没查到的 IP 按 None（失败）写入，限制重试频率
                let geo = results.get(ip).and_then(|g| g.as_ref());
                let _ = security_db::upsert_ip_geo(ip, geo);
            }
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_baidu_china_ipv6() {
        // 真实抓包样本：新疆乌鲁木齐联通基站 IPv6
        let body = r#"{"code":200,"data":{"country":"中国","province":"新疆维吾尔自治区","city":"乌鲁木齐市","isp":"联通","scene":"基站","company":null,"query_ip":"2408:847a:712:6e98:1437:4fff:fedf:4e8f","version":"v6"},"message":"success"}"#;
        let geo = parse_baidu_response(body).unwrap().unwrap();
        assert_eq!(geo.country.as_deref(), Some("中国"));
        assert_eq!(geo.region.as_deref(), Some("新疆维吾尔自治区"));
        assert_eq!(geo.city.as_deref(), Some("乌鲁木齐市"));
        assert_eq!(geo.isp.as_deref(), Some("联通（基站）"));
    }

    #[test]
    fn parses_baidu_overseas_ipv4() {
        let body = r#"{"code":200,"data":{"country":"美国","province":"","city":"","isp":"谷歌公司","scene":"IDC","company":null,"query_ip":"8.8.8.8","version":"v4"},"message":"success"}"#;
        let geo = parse_baidu_response(body).unwrap().unwrap();
        assert_eq!(geo.country.as_deref(), Some("美国"));
        assert_eq!(geo.isp.as_deref(), Some("谷歌公司（IDC）"));
    }

    #[test]
    fn baidu_empty_data_is_none_not_error() {
        let body = r#"{"code":200,"data":null,"message":"success"}"#;
        assert!(parse_baidu_response(body).unwrap().is_none());
    }

    #[test]
    fn parses_successful_batch() {
        let body = r#"[{"status":"success","country":"United States","regionName":"California","city":"Mountain View","isp":"Google LLC","query":"8.8.8.8"}]"#;
        let parsed = parse_batch_response(body).unwrap();
        assert_eq!(parsed.len(), 1);
        let (ip, geo) = &parsed[0];
        assert_eq!(ip, "8.8.8.8");
        let geo = geo.as_ref().unwrap();
        assert_eq!(geo.country.as_deref(), Some("United States"));
        assert_eq!(geo.city.as_deref(), Some("Mountain View"));
        assert_eq!(geo.isp.as_deref(), Some("Google LLC"));
    }

    #[test]
    fn parses_failed_items_as_none() {
        let body = r#"[{"status":"fail","message":"private range","query":"10.0.0.1"}]"#;
        let parsed = parse_batch_response(body).unwrap();
        assert_eq!(parsed[0].0, "10.0.0.1");
        assert!(parsed[0].1.is_none());
    }

    #[test]
    fn baidu_degraded_scene_does_not_pollute_isp() {
        // 百度对非浏览器请求概率性把 scene 降级为"未知"：归属地照用，但 isp
        // 不应拼出"联通（未知）"这种无意义文案。
        let body = r#"{"code":200,"data":{"country":"中国","province":"新疆维吾尔自治区","city":"乌鲁木齐市","isp":"联通","scene":"未知","query_ip":"2408:847a:712:6e98:1437:4fff:fedf:4e8f","version":"v6"},"message":"success"}"#;
        let geo = parse_baidu_response(body).unwrap().unwrap();
        assert_eq!(geo.city.as_deref(), Some("乌鲁木齐市"));
        assert_eq!(geo.isp.as_deref(), Some("联通"));

        // "普通"/"--"/空串同样跳过
        for scene in ["普通", "--", ""] {
            let body = format!(
                r#"{{"code":200,"data":{{"country":"中国","isp":"电信","scene":"{scene}"}}}}"#
            );
            let geo = parse_baidu_response(&body).unwrap().unwrap();
            assert_eq!(geo.isp.as_deref(), Some("电信"), "scene={scene}");
        }
    }

    #[test]
    fn rejects_invalid_json() {
        assert!(parse_batch_response("not-json").is_err());
        assert!(parse_baidu_response("not-json").is_err());
    }
}
