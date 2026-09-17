//! 在线 GeoIP 归属地批量查询与本地缓存。
//!
//! 设计原则：
//! - 展示路径零网络：查询接口先返回数据，本模块在后台异步补全归属地并落库，
//!   前端稍后重新拉取即可看到；
//! - 只查公网 IP，本机/内网/链路本地直接跳过；
//! - 单飞（single-flight）去重，避免多个页面同时触发打爆免费额度；
//! - 任何网络/解析失败都静默降级为"未知"，并写失败记录限制重试频率。

use crate::modules::ip_util::classify_ip;
use crate::modules::security_db::{self, IpGeoInfo};
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

/// ip-api.com 免费 batch 接口（单批最多 100 个，免费版仅 HTTP）。
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

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
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

        let body = http_client()
            .post(BATCH_URL)
            .json(&stale)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .text()
            .await
            .map_err(|e| e.to_string())?;

        let parsed = parse_batch_response(&body)?;
        let answered: std::collections::HashSet<String> =
            parsed.iter().map(|(ip, _)| ip.clone()).collect();
        tokio::task::spawn_blocking(move || {
            for (ip, geo) in &parsed {
                let _ = security_db::upsert_ip_geo(ip, geo.as_ref());
            }
            // 未出现在响应中的 IP 记为失败，防止反复查询
            for ip in stale {
                if !answered.contains(&ip) {
                    let _ = security_db::upsert_ip_geo(&ip, None);
                }
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
    fn rejects_invalid_json() {
        assert!(parse_batch_response("not-json").is_err());
    }
}
