use crate::commands::proxy::ProxyServiceState;
use crate::modules::ip_util;
use crate::modules::security_db;
use serde::{Deserialize, Serialize};
use tauri::State;

// ==================== 请求/响应结构 ====================

#[derive(Debug, Serialize, Deserialize)]
pub struct IpAccessLogResponse {
    pub logs: Vec<security_db::IpAccessLog>,
    pub total: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddBlacklistRequest {
    pub ip_pattern: String,
    pub reason: Option<String>,
    pub expires_at: Option<i64>, // Unix timestamp（秒）
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddWhitelistRequest {
    pub ip_pattern: String,
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct IpStatsResponse {
    pub total_requests: usize,
    pub unique_ips: usize,
    pub blocked_requests: usize,
    pub top_ips: Vec<security_db::IpRanking>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhoAmIResponse {
    pub ip: String,
    pub ip_version: String,
    pub class: String,
    pub loopback: bool,
}

// ==================== 辅助 ====================

/// 名单写操作后重新装载运行中实例的内存快照。
async fn reload_rules(app_state: &State<'_, ProxyServiceState>) {
    let instance_lock = app_state.instance.read().await;
    if let Some(instance) = instance_lock.as_ref() {
        if let Err(error) = instance.axum_server.reload_ip_rules() {
            tracing::error!("IP 规则快照热更新失败: {error}");
        }
    }
}

/// 加黑规则后确保黑名单总开关开启并持久化（用户语义：加入黑名单 = 立即生效）。
/// 任何失败只记录日志、不阻断规则写入，避免用户看到"添加成功"却没有规则。
async fn ensure_blacklist_enabled_persisted(app_state: &State<'_, ProxyServiceState>) {
    let mut app_config = match crate::modules::config::load_app_config() {
        Ok(config) => config,
        Err(error) => {
            tracing::error!("加载配置失败，无法自动启用黑名单开关: {error}");
            return;
        }
    };
    if !app_config.proxy.security_monitor.ensure_blacklist_enabled() {
        return;
    }
    if let Err(error) = crate::modules::config::save_app_config(&app_config) {
        tracing::error!("持久化黑名单开关失败: {error}");
        return;
    }
    let mut instance_lock = app_state.instance.write().await;
    if let Some(instance) = instance_lock.as_mut() {
        instance.config.security_monitor = app_config.proxy.security_monitor.clone();
        instance.axum_server.update_security(&instance.config).await;
    }
    tracing::info!("[Security] 黑名单总开关已随新增规则自动启用");
}

/// 读取 GeoIP 开关（运行实例优先，其次磁盘配置）。
async fn geoip_enabled(app_state: &State<'_, ProxyServiceState>) -> bool {
    if let Some(instance) = app_state.instance.read().await.as_ref() {
        return instance.config.security_monitor.geoip_enabled;
    }
    crate::modules::config::load_app_config()
        .map(|config| config.proxy.security_monitor.geoip_enabled)
        .unwrap_or(true)
}

/// 触发后台归属地补全（失败静默，不影响主流程）。
async fn trigger_enrich(ips: Vec<String>, enabled: bool) {
    if !enabled || ips.is_empty() {
        return;
    }
    crate::modules::geoip::spawn_enrich(ips, enabled);
}

// ==================== IP 访问日志命令 ====================

/// 获取 IP 访问日志列表（Tauri 命令使用平铺参数，与项目其他命令一致；
/// HTTP 侧的 Query 结构在 server.rs 独立定义）。
#[tauri::command]
pub async fn get_ip_access_logs(
    page: usize,
    page_size: usize,
    search: Option<String>,
    blocked_only: bool,
    app_state: State<'_, ProxyServiceState>,
) -> Result<IpAccessLogResponse, String> {
    let offset = (page.max(1) - 1) * page_size;

    let logs = security_db::get_ip_access_logs(page_size, offset, search.as_deref(), blocked_only)?;
    let total = security_db::get_ip_access_logs_count(search.as_deref(), blocked_only)? as usize;

    trigger_enrich(
        logs.iter().map(|log| log.client_ip.clone()).collect(),
        geoip_enabled(&app_state).await,
    )
    .await;

    Ok(IpAccessLogResponse { logs, total })
}

/// 获取 IP 统计信息。hours 为 None 或 <=0 时统计全部。
#[tauri::command]
pub async fn get_ip_stats(
    hours: Option<i64>,
    app_state: State<'_, ProxyServiceState>,
) -> Result<IpStatsResponse, String> {
    let stats = security_db::get_ip_stats(hours)?;
    let top_hours = hours.unwrap_or(0);
    let mut top_ips = security_db::get_top_ips(10, top_hours)?;

    // 用运行实例的内存快照标记封禁状态；实例未运行时临时装载快照。
    let instance_lock = app_state.instance.read().await;
    if let Some(instance) = instance_lock.as_ref() {
        for ranking in &mut top_ips {
            ranking.is_blocked = instance
                .axum_server
                .match_blacklist(&ranking.client_ip)
                .is_some();
        }
    } else {
        drop(instance_lock);
        let rules = crate::proxy::security::ip_rules::IpRuleSet::load()?;
        for ranking in &mut top_ips {
            ranking.is_blocked = rules.match_blacklist(&ranking.client_ip).is_some();
        }
    }

    trigger_enrich(
        top_ips.iter().map(|r| r.client_ip.clone()).collect(),
        geoip_enabled(&app_state).await,
    )
    .await;

    Ok(IpStatsResponse {
        total_requests: stats.total_requests as usize,
        unique_ips: stats.unique_ips as usize,
        blocked_requests: stats.blocked_count as usize,
        top_ips,
    })
}

/// 清空 IP 访问日志
#[tauri::command]
pub async fn clear_ip_access_logs() -> Result<(), String> {
    security_db::clear_ip_access_logs()
}

/// 实时查询单个 IP 的归属地及威胁画像（优先读库，缺失时查百度并落库 SQLite）
#[tauri::command]
pub async fn query_ip_geo(ip: String) -> Result<Option<security_db::IpGeoInfo>, String> {
    crate::modules::geoip::query_single_ip(&ip).await
}

/// 查询调用方（本机/当前浏览器）在服务端视角的 IP，用于白名单防自锁。
#[tauri::command]
pub async fn get_my_ip() -> Result<WhoAmIResponse, String> {
    // Tauri IPC 不走 HTTP，调用方即本机；Web 模式走 /api/security/whoami，
    // 该 HTTP handler 会基于真实 TCP 对端/可信代理头返回。
    let ip = "127.0.0.1".to_string();
    Ok(build_whoami(&ip))
}

pub(crate) fn build_whoami(ip: &str) -> WhoAmIResponse {
    let class = ip_util::classify_ip(ip);
    WhoAmIResponse {
        ip: ip_util::display_ip(ip),
        ip_version: if ip
            .parse::<std::net::IpAddr>()
            .map_or(false, |a| a.is_ipv6())
        {
            "IPv6".to_string()
        } else {
            "IPv4".to_string()
        },
        class: format!("{class:?}").to_lowercase(),
        loopback: matches!(class, ip_util::IpClass::Loopback),
    }
}

// ==================== IP 黑名单命令 ====================

/// 获取 IP 黑名单列表
#[tauri::command]
pub async fn get_ip_blacklist() -> Result<Vec<security_db::IpBlacklistEntry>, String> {
    security_db::get_blacklist()
}

/// 添加 IP 到黑名单
#[tauri::command]
pub async fn add_ip_to_blacklist(
    request: AddBlacklistRequest,
    app_state: State<'_, ProxyServiceState>,
) -> Result<(), String> {
    validate_pattern(&request.ip_pattern)?;
    security_db::add_to_blacklist(
        &request.ip_pattern,
        request.reason.as_deref(),
        request.expires_at,
        "manual",
    )?;
    ensure_blacklist_enabled_persisted(&app_state).await;
    reload_rules(&app_state).await;
    Ok(())
}

/// 从黑名单移除 IP
#[tauri::command]
pub async fn remove_ip_from_blacklist(
    ip_pattern: String,
    app_state: State<'_, ProxyServiceState>,
) -> Result<(), String> {
    let entries = security_db::get_blacklist()?;
    let entry = entries.iter().find(|e| e.ip_pattern == ip_pattern);
    match entry {
        Some(entry) => {
            let id = entry.id.clone();
            security_db::remove_from_blacklist(&id)?;
            reload_rules(&app_state).await;
            Ok(())
        }
        None => Err(format!("IP pattern {ip_pattern} not found in blacklist")),
    }
}

/// 清空黑名单
#[tauri::command]
pub async fn clear_ip_blacklist(app_state: State<'_, ProxyServiceState>) -> Result<(), String> {
    security_db::clear_blacklist()?;
    reload_rules(&app_state).await;
    Ok(())
}

/// 检查 IP 是否在黑名单中
#[tauri::command]
pub async fn check_ip_in_blacklist(ip: String) -> Result<bool, String> {
    security_db::is_ip_in_blacklist(&ip)
}

// ==================== IP 白名单命令 ====================

/// 获取 IP 白名单列表
#[tauri::command]
pub async fn get_ip_whitelist() -> Result<Vec<security_db::IpWhitelistEntry>, String> {
    security_db::get_whitelist()
}

/// 添加 IP 到白名单
#[tauri::command]
pub async fn add_ip_to_whitelist(
    request: AddWhitelistRequest,
    app_state: State<'_, ProxyServiceState>,
) -> Result<(), String> {
    validate_pattern(&request.ip_pattern)?;
    security_db::add_to_whitelist(&request.ip_pattern, request.description.as_deref())?;
    reload_rules(&app_state).await;
    Ok(())
}

/// 从白名单移除 IP
#[tauri::command]
pub async fn remove_ip_from_whitelist(
    ip_pattern: String,
    app_state: State<'_, ProxyServiceState>,
) -> Result<(), String> {
    let entries = security_db::get_whitelist()?;
    let entry = entries.iter().find(|e| e.ip_pattern == ip_pattern);
    match entry {
        Some(entry) => {
            let id = entry.id.clone();
            security_db::remove_from_whitelist(&id)?;
            reload_rules(&app_state).await;
            Ok(())
        }
        None => Err(format!("IP pattern {ip_pattern} not found in whitelist")),
    }
}

/// 清空白名单
#[tauri::command]
pub async fn clear_ip_whitelist(app_state: State<'_, ProxyServiceState>) -> Result<(), String> {
    security_db::clear_whitelist()?;
    reload_rules(&app_state).await;
    Ok(())
}

/// 检查 IP 是否在白名单中
#[tauri::command]
pub async fn check_ip_in_whitelist(ip: String) -> Result<bool, String> {
    security_db::is_ip_in_whitelist(&ip)
}

// ==================== 安全配置命令 ====================

/// 获取安全监控配置
#[tauri::command]
pub async fn get_security_config(
    app_state: State<'_, ProxyServiceState>,
) -> Result<crate::proxy::config::SecurityMonitorConfig, String> {
    let instance_lock = app_state.instance.read().await;
    if let Some(instance) = instance_lock.as_ref() {
        return Ok(instance.config.security_monitor.clone());
    }
    let app_config = crate::modules::config::load_app_config()
        .map_err(|e| format!("Failed to load config: {e}"))?;
    Ok(app_config.proxy.security_monitor)
}

/// 更新安全监控配置
#[tauri::command]
pub async fn update_security_config(
    config: crate::proxy::config::SecurityMonitorConfig,
    app_state: State<'_, ProxyServiceState>,
) -> Result<(), String> {
    let mut app_config = crate::modules::config::load_app_config()
        .map_err(|e| format!("Failed to load config: {e}"))?;
    app_config.proxy.security_monitor = config.clone();
    crate::modules::config::save_app_config(&app_config)
        .map_err(|e| format!("Failed to save config: {e}"))?;

    {
        let mut instance_lock = app_state.instance.write().await;
        if let Some(instance) = instance_lock.as_mut() {
            instance.config.security_monitor = config.clone();
            instance.axum_server.update_security(&instance.config).await;
            tracing::info!("[Security] Runtime security config hot-reloaded");
        }
    }

    tracing::info!("[Security] Security monitor config updated and saved");
    Ok(())
}

// ==================== 统计分析命令 ====================

/// 获取 IP Token 消耗统计。hours<=0 表示全部。
#[tauri::command]
pub async fn get_ip_token_stats(
    limit: Option<usize>,
    hours: Option<i64>,
    app_state: State<'_, ProxyServiceState>,
) -> Result<Vec<crate::modules::proxy_db::IpTokenStats>, String> {
    let mut stats = crate::modules::proxy_db::get_token_usage_by_ip(
        limit.unwrap_or(100),
        hours.unwrap_or(720),
    )?;

    let geo_map = security_db::get_geo_map(
        &stats
            .iter()
            .map(|s| s.client_ip.clone())
            .collect::<Vec<_>>(),
    )
    .unwrap_or_default();
    for item in &mut stats {
        item.geo = geo_map.get(&item.client_ip).cloned();
    }

    trigger_enrich(
        stats.iter().map(|s| s.client_ip.clone()).collect(),
        geoip_enabled(&app_state).await,
    )
    .await;

    Ok(stats)
}

// ==================== 校验 ====================

/// 校验单 IP / CIDR（IPv4 与 IPv6），非法时返回用户可读错误。
pub(crate) fn validate_pattern(pattern: &str) -> Result<(), String> {
    if ip_util::is_valid_ip_pattern(pattern) {
        Ok(())
    } else {
        Err(
            "Invalid IP pattern. Use an IPv4/IPv6 address or CIDR (e.g., 192.168.1.0/24, 240e::/32)"
                .to_string(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_ip_patterns() {
        assert!(ip_util::is_valid_ip_pattern("192.168.1.1"));
        assert!(ip_util::is_valid_ip_pattern("10.0.0.0/8"));
        assert!(ip_util::is_valid_ip_pattern("8.8.8.8/32"));
        assert!(ip_util::is_valid_ip_pattern("::1"));
        assert!(ip_util::is_valid_ip_pattern("2400:cb00::/32"));
    }

    #[test]
    fn test_invalid_ip_patterns() {
        assert!(!ip_util::is_valid_ip_pattern("256.1.1.1"));
        assert!(!ip_util::is_valid_ip_pattern("192.168.1"));
        assert!(!ip_util::is_valid_ip_pattern("192.168.1.1/33"));
        assert!(!ip_util::is_valid_ip_pattern("invalid"));
        assert!(validate_pattern("not-an-ip").is_err());
    }

    #[test]
    fn test_whoami_loopback() {
        let response = build_whoami("127.0.0.1");
        assert!(response.loopback);
        assert_eq!(response.class, "loopback");
    }
}
