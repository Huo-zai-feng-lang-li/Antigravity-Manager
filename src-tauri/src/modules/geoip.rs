//! 在线 GeoIP 归属地批量查询与本地缓存。
//!
//! 设计原则：
//! - 展示路径零网络：查询接口先返回数据，本模块在后台异步补全归属地并落库，
//!   前端稍后重新拉取即可看到；
//! - 只查公网 IP，本机/内网/链路本地直接跳过；
//! - 单飞（single-flight）去重，避免多个页面同时触发打爆免费额度；
//! - 数据源为百度 IP 画像（国内 IPv6/IPv4 准确度高，免鉴权单 IP 查询，串行限流）；
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

const CHUNK_SIZE: usize = 50;

static ENRICH_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

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
struct SecurityRiskItem {
    #[serde(default)]
    label: String,
    #[serde(rename = "subItems", default)]
    sub_items: Vec<String>,
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
    /// 风险等级：高 / 中 / 低 / 极高
    #[serde(default)]
    risk_score: Option<String>,
    /// 命中安全风险
    #[serde(default)]
    security_risks: Option<HashMap<String, Vec<SecurityRiskItem>>>,
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
    let meaningful_scene = data.scene.as_deref().filter(|s| is_meaningful_scene(s));
    let scene = meaningful_scene.map(|s| s.to_string());
    let isp = match (data.isp, meaningful_scene) {
        (Some(isp), Some(s)) => Some(format!("{isp}（{s}）")),
        (Some(isp), None) => Some(isp),
        (None, Some(s)) => Some(s.to_string()),
        (None, None) => None,
    };

    let risk_score = data.risk_score.filter(|s| !s.trim().is_empty());

    let mut risk_labels = Vec::new();
    if let Some(risks) = data.security_risks {
        for (_cat, items) in risks {
            for item in items {
                for sub in item.sub_items {
                    let sub_trimmed = sub.trim();
                    if !sub_trimmed.is_empty()
                        && !risk_labels.iter().any(|l: &String| l == sub_trimmed)
                    {
                        risk_labels.push(sub_trimmed.to_string());
                    }
                }
                let trimmed = item.label.trim();
                if !trimmed.is_empty() && !risk_labels.iter().any(|l: &String| l == trimmed) {
                    risk_labels.push(trimmed.to_string());
                }
            }
        }
    }
    let risk_detail = if risk_labels.is_empty() {
        None
    } else {
        Some(risk_labels.join("、"))
    };

    Ok(Some(IpGeoInfo {
        country: data.country,
        region: data.province,
        city: data.city,
        isp,
        scene,
        risk_score,
        risk_detail,
    }))
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

/// 实时查询单个公网 IP 的归属地与威胁画像（优先查库，缺失时在线查百度并自动入库）。
pub async fn query_single_ip(ip: &str) -> Result<Option<IpGeoInfo>, String> {
    if !classify_ip(ip).needs_geoip() {
        return Ok(None);
    }
    if let Ok(map) = security_db::get_geo_map(&[ip.to_string()]) {
        if let Some(geo) = map.get(ip) {
            return Ok(Some(geo.clone()));
        }
    }
    match query_baidu(ip).await {
        Ok(Some(geo)) => {
            let _ = security_db::upsert_ip_geo(ip, Some(&geo));
            Ok(Some(geo))
        }
        Ok(None) => {
            let _ = security_db::upsert_ip_geo(ip, None);
            Ok(None)
        }
        Err(e) => Err(e),
    }
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

    for chunk in unique.chunks(CHUNK_SIZE) {
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

        // 百度逐个查询（串行限流）
        let mut results: HashMap<String, Option<IpGeoInfo>> = HashMap::new();
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
                }
                Err(error) => {
                    tracing::debug!("GeoIP baidu query failed for {ip}: {error}");
                    results.insert(ip.clone(), None);
                }
            }
        }

        tokio::task::spawn_blocking(move || {
            for ip in &stale {
                // 查无结果或失败的 IP 按 None 写入，限制重试频率
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
        let body = r#"{"code":200,"data":{"country":"中国","province":"新疆维吾尔自治区","city":"乌鲁木齐市","isp":"联通","scene":"基站","risk_score":"低","company":null,"query_ip":"2408:847a:712:6e98:1437:4fff:fedf:4e8f","version":"v6"},"message":"success"}"#;
        let geo = parse_baidu_response(body).unwrap().unwrap();
        assert_eq!(geo.country.as_deref(), Some("中国"));
        assert_eq!(geo.region.as_deref(), Some("新疆维吾尔自治区"));
        assert_eq!(geo.city.as_deref(), Some("乌鲁木齐市"));
        assert_eq!(geo.isp.as_deref(), Some("联通（基站）"));
        assert_eq!(geo.scene.as_deref(), Some("基站"));
        assert_eq!(geo.risk_score.as_deref(), Some("低"));
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
    fn parses_baidu_sub_items_and_risk() {
        let body = r#"{"code":200,"data":{"country":"中国","province":"安徽省","city":"合肥市","isp":"中国电信","scene":"机构专线","risk_score":"高","security_risks":{"行为风险":[{"label":"爬虫IP","subItems":["爬虫"]}]},"query_ip":"60.173.254.75","version":"v4"},"message":"success"}"#;
        let geo = parse_baidu_response(body).unwrap().unwrap();
        assert_eq!(geo.city.as_deref(), Some("合肥市"));
        assert_eq!(geo.risk_score.as_deref(), Some("高"));
        assert_eq!(geo.scene.as_deref(), Some("机构专线"));
        let detail = geo.risk_detail.unwrap();
        assert!(detail.contains("爬虫"));
        assert!(detail.contains("爬虫IP"));
    }

    #[test]
    fn rejects_invalid_json() {
        assert!(parse_baidu_response("not-json").is_err());
    }
}
