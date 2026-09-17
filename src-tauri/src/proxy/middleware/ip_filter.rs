//! IP 黑白名单过滤中间件
//!
//! 判定全部基于内存快照（[`IpRuleSet`]），热路径零磁盘 IO；
//! 客户端 IP 提取遵循 [`TrustMode`]，直连模式下忽略可伪造的代理头。

use crate::modules::ip_util;
use crate::modules::security_db::{self, IpAccessLog, IpBlacklistEntry};
use crate::proxy::security::ip_rules::IpRuleSet;
use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::{Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use tracing::error;

use crate::proxy::server::AppState;

/// 组装最终封禁消息：自定义文案优先，空值回退默认。
fn blacklist_message(configured: &str, entry: &IpBlacklistEntry) -> String {
    let base = configured.trim();
    let base = if base.is_empty() {
        "Access denied. Reason: IP blocked."
    } else {
        base
    };
    match entry.expires_at {
        Some(_) => format!("{base} (temporary ban)"),
        None => format!("{base} (permanent ban)"),
    }
}

/// IP 过滤中间件
pub async fn ip_filter_middleware(
    State(state): State<AppState>,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let security_config = state.security.read().await.clone();
    let monitor = security_config.security_monitor.clone();

    let ip = ip_util::pick_client_ip(
        request.headers(),
        Some(peer_addr.ip()),
        security_config.trust_mode(),
    )
    .unwrap_or_else(|| peer_addr.ip().to_string());

    // 本机回环始终放行：避免开启白名单后把本机客户端/管理链路锁死。
    if ip_util::is_loopback_ip(&ip) {
        return next.run(request).await;
    }

    let rules: Arc<IpRuleSet> = state.ip_rules.read().clone();

    // 白名单模式：仅白名单 IP 可访问
    if monitor.whitelist.enabled {
        if rules.is_whitelisted(&ip) {
            return next.run(request).await;
        }
        return deny(
            request,
            &ip,
            "Access denied: IP not in whitelist.",
            "IP not whitelisted",
            None,
        )
        .await;
    }

    // 白名单优先：白名单内 IP 跳过黑名单检查
    let whitelisted = monitor.whitelist.whitelist_priority && rules.is_whitelisted(&ip);

    if !whitelisted && monitor.blacklist.enabled {
        if let Some(entry) = rules.match_blacklist(&ip) {
            let message = blacklist_message(&monitor.blacklist.block_message, &entry);
            return deny(
                request,
                &ip,
                &message,
                &entry
                    .reason
                    .clone()
                    .unwrap_or_else(|| "Blacklisted".to_string()),
                Some(entry),
            )
            .await;
        }
    }

    next.run(request).await
}

/// 记录拦截日志并返回 403。命中计数与日志写入合并到一次阻塞任务中。
async fn deny(
    request: Request<Body>,
    ip: &str,
    message: &str,
    reason: &str,
    black_entry: Option<Arc<IpBlacklistEntry>>,
) -> Response {
    let method = request.method().clone();
    let uri = request.uri().clone();

    let log = IpAccessLog {
        id: uuid::Uuid::new_v4().to_string(),
        client_ip: ip.to_string(),
        timestamp: chrono::Utc::now().timestamp(),
        method: Some(method.to_string()),
        path: Some(uri.path().to_string()),
        user_agent: None,
        session_title: None,
        status: Some(403),
        duration: None,
        api_key_hash: None,
        blocked: true,
        block_reason: Some(reason.to_string()),
        username: None,
        geo: None,
    };

    let entry_id = black_entry.as_ref().map(|entry| entry.id.clone());
    let blocking = tokio::task::spawn_blocking(move || {
        if let Some(id) = entry_id {
            if let Err(error) = security_db::increment_blacklist_hit(&id) {
                error!("Failed to increment blacklist hit count: {error}");
            }
        }
        if let Err(error) = security_db::save_ip_access_log(&log) {
            error!("Failed to save IP access log: {error}");
        }
    });
    let _ = blocking.await;

    (
        StatusCode::FORBIDDEN,
        Json(json!({
            "error": {
                "message": message,
                "type": "invalid_request_error",
                "code": "ip_forbidden",
                "param": null
            }
        })),
    )
        .into_response()
}
