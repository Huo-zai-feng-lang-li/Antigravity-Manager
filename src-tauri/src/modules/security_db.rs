//! Security Database Module
//! 安全监控相关的数据库操作

use parking_lot::{Mutex, MutexGuard};
#[cfg(test)]
use parking_lot::{ReentrantMutex, ReentrantMutexGuard};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::OnceLock;

#[cfg(test)]
pub static TEST_SECURITY_MUTEX: ReentrantMutex<()> = ReentrantMutex::new(());

#[cfg(test)]
pub fn lock_security_test() -> ReentrantMutexGuard<'static, ()> {
    TEST_SECURITY_MUTEX.lock()
}

/// IP 访问日志
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpAccessLog {
    pub id: String,
    pub client_ip: String,
    pub timestamp: i64,
    pub method: Option<String>,
    pub path: Option<String>,
    pub user_agent: Option<String>,
    pub status: Option<i32>,
    pub duration: Option<i64>,
    pub api_key_hash: Option<String>,
    pub blocked: bool,
    pub block_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// 在线/本地归属地信息，仅查询响应填充，不入库本表。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub geo: Option<IpGeoInfo>,
}

/// IP 归属地信息（来自 ip_geo 缓存表）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IpGeoInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub city: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isp: Option<String>,
}

/// IP 黑名单条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpBlacklistEntry {
    pub id: String,
    pub ip_pattern: String,
    pub reason: Option<String>,
    pub created_at: i64,
    pub expires_at: Option<i64>,
    pub created_by: String,
    pub hit_count: i64,
}

/// IP 白名单条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpWhitelistEntry {
    pub id: String,
    pub ip_pattern: String,
    pub description: Option<String>,
    pub created_at: i64,
}

/// IP 统计概览
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpStats {
    pub total_requests: u64,
    pub unique_ips: u64,
    pub blocked_count: u64,
    pub today_requests: u64,
    pub blacklist_count: u64,
    pub whitelist_count: u64,
}

/// IP 访问排行
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpRanking {
    pub client_ip: String,
    pub request_count: u64,
    pub last_seen: i64,
    pub is_blocked: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub geo: Option<IpGeoInfo>,
}

/// 获取安全数据库路径
pub fn get_security_db_path() -> Result<PathBuf, String> {
    let data_dir = crate::modules::account::get_data_dir()?;
    Ok(data_dir.join("security.db"))
}

static SECURITY_DB: OnceLock<Result<Mutex<Connection>, String>> = OnceLock::new();

/// 打开并配置安全数据库连接。
fn open_db() -> Result<Connection, String> {
    let db_path = get_security_db_path()?;
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    // Enable WAL mode for better concurrency
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;

    // Set busy timeout
    conn.pragma_update(None, "busy_timeout", 5000)
        .map_err(|e| e.to_string())?;

    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| e.to_string())?;

    Ok(conn)
}

/// 复用进程内连接，避免每次请求重复打开 SQLite 数据库。
fn connect_db() -> Result<MutexGuard<'static, Connection>, String> {
    match SECURITY_DB.get_or_init(|| open_db().map(Mutex::new)) {
        Ok(connection) => Ok(connection.lock()),
        Err(error) => Err(error.clone()),
    }
}

/// 初始化安全数据库
pub fn init_db() -> Result<(), String> {
    let conn = connect_db()?;

    // IP 访问日志表
    conn.execute(
        "CREATE TABLE IF NOT EXISTS ip_access_logs (
            id TEXT PRIMARY KEY,
            client_ip TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            method TEXT,
            path TEXT,
            user_agent TEXT,
            status INTEGER,
            duration INTEGER,
            api_key_hash TEXT,
            blocked INTEGER DEFAULT 0,
            block_reason TEXT
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    // IP 黑名单表
    conn.execute(
        "CREATE TABLE IF NOT EXISTS ip_blacklist (
            id TEXT PRIMARY KEY,
            ip_pattern TEXT NOT NULL UNIQUE,
            reason TEXT,
            created_at INTEGER NOT NULL,
            expires_at INTEGER,
            created_by TEXT DEFAULT 'manual',
            hit_count INTEGER DEFAULT 0
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    // IP 白名单表
    conn.execute(
        "CREATE TABLE IF NOT EXISTS ip_whitelist (
            id TEXT PRIMARY KEY,
            ip_pattern TEXT NOT NULL UNIQUE,
            description TEXT,
            created_at INTEGER NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    // IP 归属地缓存表（在线查询结果本地缓存，失败也记录以便限流重试）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS ip_geo (
            ip TEXT PRIMARY KEY,
            country TEXT,
            region TEXT,
            city TEXT,
            isp TEXT,
            success INTEGER NOT NULL DEFAULT 1,
            queried_at INTEGER NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    // 创建索引
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_ip_access_ip ON ip_access_logs (client_ip)",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_ip_access_timestamp ON ip_access_logs (timestamp DESC)",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_ip_access_blocked ON ip_access_logs (blocked)",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_blacklist_pattern ON ip_blacklist (ip_pattern)",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_ip_geo_queried ON ip_geo (queried_at)",
        [],
    )
    .map_err(|e| e.to_string())?;

    // Migration: Add username column to ip_access_logs
    let _ = conn.execute("ALTER TABLE ip_access_logs ADD COLUMN username TEXT", []);

    // Migration v1: GeoIP 主数据源切换为百度，旧 ip-api 缓存（国内 IPv6 归属地
    // 可能错误，如把新疆联通基站定位到北京）全部作废，下次访问时自动重新查询。
    let user_version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap_or(0);
    if user_version < 1 {
        let _ = conn.execute("DELETE FROM ip_geo", []);
        let _ = conn.execute("PRAGMA user_version = 1", []);
    }

    Ok(())
}

// ============================================================================
// IP 访问日志操作
// ============================================================================

/// 保存 IP 访问日志
pub fn save_ip_access_log(log: &IpAccessLog) -> Result<(), String> {
    let conn = connect_db()?;

    conn.execute(
        "INSERT INTO ip_access_logs (id, client_ip, timestamp, method, path, user_agent, status, duration, api_key_hash, blocked, block_reason, username)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            log.id,
            log.client_ip,
            log.timestamp,
            log.method,
            log.path,
            log.user_agent,
            log.status,
            log.duration,
            log.api_key_hash,
            log.blocked,
            log.block_reason,
            log.username,
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// 获取 IP 访问日志 (分页)。keyword 在 IP/路径/UA/用户名四个字段中模糊匹配。
pub fn get_ip_access_logs(
    limit: usize,
    offset: usize,
    keyword: Option<&str>,
    blocked_only: bool,
) -> Result<Vec<IpAccessLog>, String> {
    let conn = connect_db()?;
    // 空字符串与 None 同口径（与 get_ip_access_logs_count 保持一致），避免 LIKE '%%' 分支。
    let search = keyword
        .map(str::trim)
        .filter(|kw| !kw.is_empty())
        .map(|kw| format!("%{}%", escape_like(kw)));
    let blocked = i64::from(blocked_only);
    let mut stmt = conn
        .prepare(
            "SELECT id, client_ip, timestamp, method, path, user_agent, status, duration, api_key_hash, blocked, block_reason, username
             FROM ip_access_logs
             WHERE (?1 = 0 OR blocked = 1)
               AND (?2 IS NULL
                    OR client_ip LIKE ?2 ESCAPE '\\'
                    OR path LIKE ?2 ESCAPE '\\'
                    OR user_agent LIKE ?2 ESCAPE '\\'
                    OR username LIKE ?2 ESCAPE '\\')
             ORDER BY timestamp DESC
             LIMIT ?3 OFFSET ?4",
        )
        .map_err(|e| e.to_string())?;

    let logs_iter = stmt
        .query_map(
            params![blocked, search, limit as i64, offset as i64],
            |row| {
                Ok(IpAccessLog {
                    id: row.get(0)?,
                    client_ip: row.get(1)?,
                    timestamp: row.get(2)?,
                    method: row.get(3)?,
                    path: row.get(4)?,
                    user_agent: row.get(5)?,
                    status: row.get(6)?,
                    duration: row.get(7)?,
                    api_key_hash: row.get(8)?,
                    blocked: row.get::<_, i32>(9)? != 0,
                    block_reason: row.get(10)?,
                    username: row.get(11).unwrap_or(None),
                    geo: None,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    let mut logs = Vec::new();
    for log in logs_iter {
        logs.push(log.map_err(|e| e.to_string())?);
    }
    attach_logs_geo(&conn, &mut logs)?;
    Ok(logs)
}

/// 转义 SQLite LIKE 通配符（%、_、\），配合 `ESCAPE '\'` 使用。
fn escape_like(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    for ch in input.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            output.push('\\');
        }
        output.push(ch);
    }
    output
}

/// 获取 IP 统计概览。
///
/// `hours` 为 None 时统计全部日志；为 Some(h)（h>0）时只统计最近 h 小时。
/// 名单条数是"当前状态"，不受时间窗影响，且黑名单只计未过期条目。
pub fn get_ip_stats(hours: Option<i64>) -> Result<IpStats, String> {
    let conn = connect_db()?;
    let now = chrono::Utc::now().timestamp();
    let today_start = chrono::Utc::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
        .timestamp();
    let window_start = hours.filter(|h| *h > 0).map(|h| now - h * 3600);

    // COALESCE：空表上 SUM 返回 NULL，直接映射 u64 会报错。
    let (total_requests, unique_ips, blocked_count, today_requests): (u64, u64, u64, u64) = conn
        .query_row(
            "SELECT
                COUNT(*) as total,
                COUNT(DISTINCT client_ip) as unique_ips,
                COALESCE(SUM(CASE WHEN blocked = 1 THEN 1 ELSE 0 END), 0) as blocked,
                COALESCE(SUM(CASE WHEN timestamp >= ?2 THEN 1 ELSE 0 END), 0) as today
             FROM ip_access_logs
             WHERE (?1 IS NULL OR timestamp >= ?1)",
            params![window_start, today_start],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| e.to_string())?;

    let blacklist_count: u64 = conn
        .query_row(
            "SELECT COUNT(*) FROM ip_blacklist
             WHERE expires_at IS NULL OR expires_at >= ?1",
            [now],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let whitelist_count: u64 = conn
        .query_row("SELECT COUNT(*) FROM ip_whitelist", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;

    Ok(IpStats {
        total_requests,
        unique_ips,
        blocked_count,
        today_requests,
        blacklist_count,
        whitelist_count,
    })
}

/// 获取 TOP N IP 访问排行。`hours <= 0` 表示全部；`is_blocked`/geo 由调用层补齐。
pub fn get_top_ips(limit: usize, hours: i64) -> Result<Vec<IpRanking>, String> {
    let conn = connect_db()?;
    let now = chrono::Utc::now().timestamp();
    let since: Option<i64> = if hours > 0 {
        Some(now - hours * 3600)
    } else {
        None
    };
    let mut stmt = conn
        .prepare(
            "SELECT client_ip, COUNT(*) as cnt, MAX(timestamp) as last_seen
             FROM ip_access_logs
             WHERE (?1 IS NULL OR timestamp >= ?1)
             GROUP BY client_ip
             ORDER BY cnt DESC
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;

    let rankings_iter = stmt
        .query_map(params![since, limit as i64], |row| {
            Ok(IpRanking {
                client_ip: row.get(0)?,
                request_count: row.get(1)?,
                last_seen: row.get(2)?,
                is_blocked: false,
                geo: None,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut rankings = Vec::new();
    for ranking in rankings_iter {
        rankings.push(ranking.map_err(|e| e.to_string())?);
    }
    attach_rankings_geo(&conn, &mut rankings)?;
    Ok(rankings)
}

/// 访问日志条数上限：超过后按时间淘汰最旧记录，防止高流量下无限膨胀。
const IP_LOGS_MAX_ROWS: usize = 20_000;

/// 清理旧的 IP 访问日志：先按保留天数删，再按条数上限裁剪。
pub fn cleanup_old_ip_logs(days: i64) -> Result<usize, String> {
    let conn = connect_db()?;

    let cutoff_timestamp = chrono::Utc::now().timestamp() - (days * 24 * 3600);

    let deleted_by_age = conn
        .execute(
            "DELETE FROM ip_access_logs WHERE timestamp < ?1",
            [cutoff_timestamp],
        )
        .map_err(|e| e.to_string())?;

    let deleted_by_cap = conn
        .execute(
            "DELETE FROM ip_access_logs
             WHERE id NOT IN (
                 SELECT id FROM ip_access_logs
                 ORDER BY timestamp DESC
                 LIMIT ?1
             )",
            [IP_LOGS_MAX_ROWS as i64],
        )
        .map_err(|e| e.to_string())?;

    // 顺带清理过期黑名单与陈旧的失败 GeoIP 记录
    let now = chrono::Utc::now().timestamp();
    let _ = conn.execute(
        "DELETE FROM ip_blacklist WHERE expires_at IS NOT NULL AND expires_at < ?1",
        [now],
    );
    let _ = conn.execute(
        "DELETE FROM ip_geo WHERE success = 0 AND queried_at < ?1",
        [now - 7 * 24 * 3600],
    );

    // VACUUM to reclaim space
    conn.execute("VACUUM", []).map_err(|e| e.to_string())?;

    Ok(deleted_by_age + deleted_by_cap)
}

// ============================================================================
// 黑名单操作
// ============================================================================

/// 添加 IP 到黑名单。规则会先做规范化（去前导零、CIDR 主机位清零等）；
/// 无法解析的 pattern 原样存储以兼容历史数据，但不会参与内存匹配。
pub fn add_to_blacklist(
    ip_pattern: &str,
    reason: Option<&str>,
    expires_at: Option<i64>,
    created_by: &str,
) -> Result<IpBlacklistEntry, String> {
    let conn = connect_db()?;

    let normalized = crate::modules::ip_util::normalize_pattern(ip_pattern)
        .unwrap_or_else(|| ip_pattern.trim().to_string());
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();

    conn.execute(
        "INSERT INTO ip_blacklist (id, ip_pattern, reason, created_at, expires_at, created_by, hit_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
        params![id, normalized, reason, now, expires_at, created_by],
    )
    .map_err(|e| e.to_string())?;

    Ok(IpBlacklistEntry {
        id,
        ip_pattern: normalized,
        reason: reason.map(|s| s.to_string()),
        created_at: now,
        expires_at,
        created_by: created_by.to_string(),
        hit_count: 0,
    })
}

/// 从黑名单移除
pub fn remove_from_blacklist(id: &str) -> Result<(), String> {
    let conn = connect_db()?;

    conn.execute("DELETE FROM ip_blacklist WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// 获取黑名单列表
pub fn get_blacklist() -> Result<Vec<IpBlacklistEntry>, String> {
    let conn = connect_db()?;
    get_blacklist_with_connection(&conn)
}

fn get_blacklist_with_connection(conn: &Connection) -> Result<Vec<IpBlacklistEntry>, String> {
    let now = chrono::Utc::now().timestamp();
    let mut stmt = conn
        .prepare(
            "SELECT id, ip_pattern, reason, created_at, expires_at, created_by, hit_count
             FROM ip_blacklist
             WHERE expires_at IS NULL OR expires_at >= ?1
             ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let entries_iter = stmt
        .query_map(params![now], |row| {
            Ok(IpBlacklistEntry {
                id: row.get(0)?,
                ip_pattern: row.get(1)?,
                reason: row.get(2)?,
                created_at: row.get(3)?,
                expires_at: row.get(4)?,
                created_by: row.get(5)?,
                hit_count: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    for e in entries_iter {
        entries.push(e.map_err(|e| e.to_string())?);
    }
    Ok(entries)
}

/// 检查 IP 是否在黑名单中（基于内存快照，供管理接口低频使用；热路径见 ip_filter）。
pub fn is_ip_in_blacklist(ip: &str) -> Result<bool, String> {
    let rules = crate::proxy::security::ip_rules::IpRuleSet::load()?;
    Ok(rules.match_blacklist(ip).is_some())
}

/// 黑名单命中计数 +1（封禁路径异步调用，与拦截日志合并写入）。
pub fn increment_blacklist_hit(id: &str) -> Result<(), String> {
    let conn = connect_db()?;
    conn.execute(
        "UPDATE ip_blacklist SET hit_count = hit_count + 1 WHERE id = ?1",
        [id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 清空黑名单。
pub fn clear_blacklist() -> Result<(), String> {
    let conn = connect_db()?;
    conn.execute("DELETE FROM ip_blacklist", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================================
// 白名单操作
// ============================================================================

/// 添加 IP 到白名单，规则同样先规范化。
pub fn add_to_whitelist(
    ip_pattern: &str,
    description: Option<&str>,
) -> Result<IpWhitelistEntry, String> {
    let conn = connect_db()?;

    let normalized = crate::modules::ip_util::normalize_pattern(ip_pattern)
        .unwrap_or_else(|| ip_pattern.trim().to_string());
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();

    conn.execute(
        "INSERT INTO ip_whitelist (id, ip_pattern, description, created_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![id, normalized, description, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(IpWhitelistEntry {
        id,
        ip_pattern: normalized,
        description: description.map(|s| s.to_string()),
        created_at: now,
    })
}

/// 从白名单移除
pub fn remove_from_whitelist(id: &str) -> Result<(), String> {
    let conn = connect_db()?;

    conn.execute("DELETE FROM ip_whitelist WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// 获取白名单列表
pub fn get_whitelist() -> Result<Vec<IpWhitelistEntry>, String> {
    let conn = connect_db()?;
    get_whitelist_with_connection(&conn)
}

fn get_whitelist_with_connection(conn: &Connection) -> Result<Vec<IpWhitelistEntry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, ip_pattern, description, created_at
             FROM ip_whitelist
             ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let entries_iter = stmt
        .query_map([], |row| {
            Ok(IpWhitelistEntry {
                id: row.get(0)?,
                ip_pattern: row.get(1)?,
                description: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    for e in entries_iter {
        entries.push(e.map_err(|e| e.to_string())?);
    }
    Ok(entries)
}

/// 检查 IP 是否在白名单中（基于内存快照，供管理接口低频使用；热路径见 ip_filter）。
pub fn is_ip_in_whitelist(ip: &str) -> Result<bool, String> {
    let rules = crate::proxy::security::ip_rules::IpRuleSet::load()?;
    Ok(rules.is_whitelisted(ip))
}

/// 清空白名单。
pub fn clear_whitelist() -> Result<(), String> {
    let conn = connect_db()?;
    conn.execute("DELETE FROM ip_whitelist", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 清空所有 IP 访问日志
pub fn clear_ip_access_logs() -> Result<(), String> {
    let conn = connect_db()?;
    conn.execute("DELETE FROM ip_access_logs", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 获取 IP 访问日志总数（与列表查询相同的四字段搜索口径）。
pub fn get_ip_access_logs_count(keyword: Option<&str>, blocked_only: bool) -> Result<u64, String> {
    let conn = connect_db()?;
    let search = keyword
        .map(|kw| kw.trim())
        .filter(|kw| !kw.is_empty())
        .map(|kw| format!("%{}%", escape_like(kw)));
    let blocked = i64::from(blocked_only);

    let count: u64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM ip_access_logs
             WHERE (?1 = 0 OR blocked = 1)
               AND (?2 IS NULL
                    OR client_ip LIKE ?2 ESCAPE '\\'
                    OR path LIKE ?2 ESCAPE '\\'
                    OR user_agent LIKE ?2 ESCAPE '\\'
                    OR username LIKE ?2 ESCAPE '\\')",
            params![blocked, search],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    Ok(count)
}

// ============================================================================
// IP 归属地缓存
// ============================================================================

/// GeoIP 成功缓存有效期（30 天）。
const GEO_TTL_SECONDS: i64 = 30 * 24 * 3600;
/// GeoIP 失败记录的重试间隔（1 小时）。
const GEO_RETRY_SECONDS: i64 = 3600;

/// 写入一条归属地查询结果；geo 为 None 表示查询失败（记录时间用于限流重试）。
pub fn upsert_ip_geo(ip: &str, geo: Option<&IpGeoInfo>) -> Result<(), String> {
    let conn = connect_db()?;
    let now = chrono::Utc::now().timestamp();
    let (success, country, region, city, isp) = match geo {
        Some(info) => (
            1_i64,
            info.country.clone(),
            info.region.clone(),
            info.city.clone(),
            info.isp.clone(),
        ),
        None => (0, None, None, None, None),
    };
    conn.execute(
        "INSERT INTO ip_geo (ip, country, region, city, isp, success, queried_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(ip) DO UPDATE SET
            country=excluded.country, region=excluded.region, city=excluded.city,
            isp=excluded.isp, success=excluded.success, queried_at=excluded.queried_at",
        params![ip, country, region, city, isp, success, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 取一批 IP 的有效归属地缓存（仅成功且未过 TTL）。
fn get_geo_map_with_connection(
    conn: &Connection,
    ips: &[String],
) -> Result<HashMap<String, IpGeoInfo>, String> {
    let mut result = HashMap::new();
    if ips.is_empty() {
        return Ok(result);
    }
    let fresh_after = chrono::Utc::now().timestamp() - GEO_TTL_SECONDS;
    let placeholders = ips.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT ip, country, region, city, isp FROM ip_geo
         WHERE success = 1 AND queried_at >= ?1 AND ip IN ({})",
        placeholders
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params_iter: Vec<&dyn rusqlite::ToSql> =
        std::iter::once(&fresh_after as &dyn rusqlite::ToSql)
            .chain(ips.iter().map(|ip| ip as &dyn rusqlite::ToSql))
            .collect::<Vec<_>>();
    let rows = stmt
        .query_map(params_iter.as_slice(), |row| {
            Ok((
                row.get::<_, String>(0)?,
                IpGeoInfo {
                    country: row.get(1)?,
                    region: row.get(2)?,
                    city: row.get(3)?,
                    isp: row.get(4)?,
                },
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (ip, info) = row.map_err(|e| e.to_string())?;
        result.insert(ip, info);
    }
    Ok(result)
}

/// 返回需要在线查询的 IP：无任何记录，或失败记录已过重试间隔。
/// 公网/Cloudflare 判定由调用方（geoip 模块）负责。
pub fn get_stale_geo_ips(ips: &[String]) -> Result<Vec<String>, String> {
    let conn = connect_db()?;
    get_stale_geo_ips_with_connection(&conn, ips)
}

fn get_stale_geo_ips_with_connection(
    conn: &Connection,
    ips: &[String],
) -> Result<Vec<String>, String> {
    let unique: Vec<&String> = ips
        .iter()
        .collect::<HashSet<&String>>()
        .into_iter()
        .collect();
    if unique.is_empty() {
        return Ok(Vec::new());
    }

    // 单条 IN 查询取全部缓存状态，避免逐 IP query_row 的 N+1。
    let placeholders = unique.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!("SELECT ip, success, queried_at FROM ip_geo WHERE ip IN ({placeholders})");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let found: HashMap<String, (i64, i64)> = stmt
        .query_map(params_from_iter(unique.iter().copied()), |row| {
            Ok((row.get::<_, String>(0)?, (row.get(1)?, row.get(2)?)))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();

    let retry_after = chrono::Utc::now().timestamp() - GEO_RETRY_SECONDS;
    let mut stale = Vec::new();
    for ip in unique {
        let needs_query = match found.get(ip) {
            None => true,
            Some((1, _)) => false, // 成功记录由 TTL 缓存判定，未过期不查
            Some((0, queried_at)) => *queried_at < retry_after,
            _ => true,
        };
        if needs_query {
            stale.push(ip.clone());
        }
    }
    Ok(stale)
}

/// 为访问日志批量填充归属地。
fn attach_logs_geo(conn: &Connection, logs: &mut [IpAccessLog]) -> Result<(), String> {
    let ips: Vec<String> = logs.iter().map(|log| log.client_ip.clone()).collect();
    let geo_map = get_geo_map_with_connection(conn, &ips)?;
    for log in logs.iter_mut() {
        log.geo = geo_map.get(&log.client_ip).cloned();
    }
    Ok(())
}

/// 为 IP 排行批量填充归属地。
fn attach_rankings_geo(conn: &Connection, rankings: &mut [IpRanking]) -> Result<(), String> {
    let ips: Vec<String> = rankings.iter().map(|r| r.client_ip.clone()).collect();
    let geo_map = get_geo_map_with_connection(conn, &ips)?;
    for ranking in rankings.iter_mut() {
        ranking.geo = geo_map.get(&ranking.client_ip).cloned();
    }
    Ok(())
}

/// 为任意 IP 列表取有效归属地缓存（供命令层填充 Token 统计等跨库数据）。
pub fn get_geo_map(ips: &[String]) -> Result<HashMap<String, IpGeoInfo>, String> {
    let conn = connect_db()?;
    get_geo_map_with_connection(&conn, ips)
}
