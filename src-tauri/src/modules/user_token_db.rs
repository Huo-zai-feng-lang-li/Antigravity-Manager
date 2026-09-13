//! User Token Database Module
//! UserToken 数据库操作模块

#![allow(dead_code)]
// 用户令牌存储，部分接口留作后续扩展

use chrono::{Datelike, FixedOffset, Timelike, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

/// 单次请求额度预占量（保守默认值，覆盖绝大多数单请求输出）
/// 请求进入时先冻结该量，响应结束后按实际用量多退少补；失败全额回滚。
/// 如需适配大输出场景可调大。
pub const QUOTA_HOLD_AMOUNT: i64 = 8192;

/// 用户令牌结构体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserToken {
    pub id: String,
    pub token: String,
    pub username: String,
    pub description: Option<String>,
    pub enabled: bool,
    pub expires_type: String, // "day", "week", "month", "never"
    pub expires_at: Option<i64>,
    pub max_ips: i32,                 // 0 = unlimited
    pub curfew_start: Option<String>, // "HH:MM" 宵禁开始时间
    pub curfew_end: Option<String>,   // "HH:MM" 宵禁结束时间
    /// 每日 Token 用量上限，0 = 不限
    pub daily_quota: i64,
    /// 每月 Token 用量上限，0 = 不限
    pub monthly_quota: i64,
    /// 当日已用 Token（含在途预占），系统维护，不可通过 update 修改
    pub daily_used: i64,
    /// 当月已用 Token（含在途预占），系统维护
    pub monthly_used: i64,
    /// 当日周期起始时间戳（北京时间当日 00:00 的 UTC 秒），None = 未初始化
    pub daily_anchor: Option<i64>,
    /// 当月周期起始时间戳（北京时间当月 1 日 00:00 的 UTC 秒）
    pub monthly_anchor: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_used_at: Option<i64>,
    pub total_requests: i64,
    pub total_tokens_used: i64,
}

/// 令牌 IP 绑定结构体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenIpBinding {
    pub id: String,
    pub token_id: String,
    pub ip_address: String,
    pub first_seen_at: i64,
    pub last_seen_at: i64,
    pub request_count: i64,
    pub user_agent: Option<String>,
}

/// 令牌使用日志结构体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsageLog {
    pub id: String,
    pub token_id: String,
    pub ip_address: String,
    pub model: String,
    pub input_tokens: i32,
    pub output_tokens: i32,
    pub request_time: i64,
    pub status: u16,
}

/// 获取数据库路径
pub fn get_db_path() -> Result<PathBuf, String> {
    let mut path = crate::modules::account::get_data_dir()?;
    path.push("user_tokens.db");
    Ok(path)
}

/// 连接数据库
pub fn connect_db() -> Result<Connection, String> {
    let path = get_db_path()?;
    let conn = Connection::open(&path).map_err(|e| format!("Failed to open database: {}", e))?;
    // [FIX] 与 proxy_db/security_db/token_stats/artifact_store 对齐：
    // WAL 持久化属性（幂等）；busy_timeout/synchronous 连接级。缺失时并发写会直接 SQLITE_BUSY。
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let _ = conn.pragma_update(None, "busy_timeout", 5000);
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");
    // [FIX] SQLite 默认关闭外键约束，必须逐连接开启，否则建表声明的
    // ON DELETE CASCADE 不生效，删除令牌后 token_ip_bindings/token_usage_logs 会残留。
    let _ = conn.pragma_update(None, "foreign_keys", "ON");
    Ok(conn)
}

/// 初始化数据库（使用传入的连接，便于测试用内存数据库）
pub fn init_db_with_conn(conn: &Connection) -> Result<(), String> {
    // 创建 user_tokens 表
    conn.execute(
        "CREATE TABLE IF NOT EXISTS user_tokens (
            id TEXT PRIMARY KEY,
            token TEXT UNIQUE NOT NULL,
            username TEXT NOT NULL,
            description TEXT,
            enabled BOOLEAN NOT NULL DEFAULT 1,
            expires_type TEXT NOT NULL,
            expires_at INTEGER,
            max_ips INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_used_at INTEGER,
            total_requests INTEGER NOT NULL DEFAULT 0,
            total_tokens_used INTEGER NOT NULL DEFAULT 0,
            curfew_start TEXT,
            curfew_end TEXT,
            daily_quota INTEGER NOT NULL DEFAULT 0,
            monthly_quota INTEGER NOT NULL DEFAULT 0,
            daily_used INTEGER NOT NULL DEFAULT 0,
            monthly_used INTEGER NOT NULL DEFAULT 0,
            daily_anchor INTEGER,
            monthly_anchor INTEGER
        )",
        [],
    )
    .map_err(|e| format!("Failed to create user_tokens table: {}", e))?;

    // 尝试添加新列 (用于旧数据库迁移，忽略已存在的错误)
    let _ = conn.execute("ALTER TABLE user_tokens ADD COLUMN expires_type TEXT", []);
    let _ = conn.execute("ALTER TABLE user_tokens ADD COLUMN expires_at INTEGER", []);
    let _ = conn.execute(
        "ALTER TABLE user_tokens ADD COLUMN max_ips INTEGER DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE user_tokens ADD COLUMN total_requests INTEGER DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE user_tokens ADD COLUMN total_tokens_used INTEGER DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE user_tokens ADD COLUMN last_used_at INTEGER",
        [],
    );
    let _ = conn.execute("ALTER TABLE user_tokens ADD COLUMN curfew_start TEXT", []);
    let _ = conn.execute("ALTER TABLE user_tokens ADD COLUMN curfew_end TEXT", []);
    // 额度限制相关列（方案 B：原子预占 + 事后校正）
    let _ = conn.execute(
        "ALTER TABLE user_tokens ADD COLUMN daily_quota INTEGER DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE user_tokens ADD COLUMN monthly_quota INTEGER DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE user_tokens ADD COLUMN daily_used INTEGER DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE user_tokens ADD COLUMN monthly_used INTEGER DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE user_tokens ADD COLUMN daily_anchor INTEGER",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE user_tokens ADD COLUMN monthly_anchor INTEGER",
        [],
    );

    // 创建 token_ip_bindings 表
    conn.execute(
        "CREATE TABLE IF NOT EXISTS token_ip_bindings (
            id TEXT PRIMARY KEY,
            token_id TEXT NOT NULL,
            ip_address TEXT NOT NULL,
            first_seen_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            request_count INTEGER NOT NULL DEFAULT 0,
            user_agent TEXT,
            FOREIGN KEY(token_id) REFERENCES user_tokens(id) ON DELETE CASCADE,
            UNIQUE(token_id, ip_address)
        )",
        [],
    )
    .map_err(|e| format!("Failed to create token_ip_bindings table: {}", e))?;

    // 创建 token_usage_logs 表
    conn.execute(
        "CREATE TABLE IF NOT EXISTS token_usage_logs (
            id TEXT PRIMARY KEY,
            token_id TEXT NOT NULL,
            ip_address TEXT,
            model TEXT,
            input_tokens INTEGER,
            output_tokens INTEGER,
            request_time INTEGER NOT NULL,
            status INTEGER,
            FOREIGN KEY(token_id) REFERENCES user_tokens(id) ON DELETE CASCADE
        )",
        [],
    )
    .map_err(|e| format!("Failed to create token_usage_logs table: {}", e))?;

    // 创建索引
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_token_usage_logs_token_id ON token_usage_logs(token_id)",
        [],
    );
    let _ = conn.execute("CREATE INDEX IF NOT EXISTS idx_token_usage_logs_request_time ON token_usage_logs(request_time)", []);

    // [FIX Issue #1719] 数据清洗：修复旧版本升级导致的 NULL 字段
    // 这些字段在旧版本中可能不存在，ALTER TABLE 添加后默认为 NULL，导致反序列化失败
    let _ = conn.execute("UPDATE user_tokens SET expires_type = 'never' WHERE expires_type IS NULL OR expires_type = ''", []);
    let _ = conn.execute(
        "UPDATE user_tokens SET max_ips = 0 WHERE max_ips IS NULL",
        [],
    );
    let _ = conn.execute(
        "UPDATE user_tokens SET total_requests = 0 WHERE total_requests IS NULL",
        [],
    );
    let _ = conn.execute(
        "UPDATE user_tokens SET total_tokens_used = 0 WHERE total_tokens_used IS NULL",
        [],
    );
    let _ = conn.execute(
        "UPDATE user_tokens SET enabled = 1 WHERE enabled IS NULL",
        [],
    );
    // 额度字段 NULL 清洗（旧库 ALTER ADD COLUMN 后老行为 NULL，防御性归零）
    let _ = conn.execute(
        "UPDATE user_tokens SET daily_quota = 0 WHERE daily_quota IS NULL",
        [],
    );
    let _ = conn.execute(
        "UPDATE user_tokens SET monthly_quota = 0 WHERE monthly_quota IS NULL",
        [],
    );
    let _ = conn.execute(
        "UPDATE user_tokens SET daily_used = 0 WHERE daily_used IS NULL",
        [],
    );
    let _ = conn.execute(
        "UPDATE user_tokens SET monthly_used = 0 WHERE monthly_used IS NULL",
        [],
    );

    Ok(())
}

/// 初始化数据库（生产入口，连接全局数据库文件）
pub fn init_db() -> Result<(), String> {
    let conn = connect_db()?;
    init_db_with_conn(&conn)
}

/// 创建新令牌
pub fn create_token(
    username: String,
    expires_type: String,
    description: Option<String>,
    max_ips: i32,
    curfew_start: Option<String>,
    curfew_end: Option<String>,
    custom_expires_at: Option<i64>, // 自定义过期时间戳 (秒)
    daily_quota: i64,               // 每日 Token 用量上限，0 = 不限
    monthly_quota: i64,             // 每月 Token 用量上限，0 = 不限
) -> Result<UserToken, String> {
    let conn = connect_db()?;
    let id = Uuid::new_v4().to_string();
    let token = format!("sk-{}", Uuid::new_v4().to_string().replace("-", ""));
    let now = Utc::now().timestamp();

    let expires_at = match expires_type.as_str() {
        "day" => Some(
            Utc::now()
                .checked_add_signed(chrono::Duration::days(1))
                .unwrap()
                .timestamp(),
        ),
        "week" => Some(
            Utc::now()
                .checked_add_signed(chrono::Duration::weeks(1))
                .unwrap()
                .timestamp(),
        ),
        "month" => Some(
            Utc::now()
                .checked_add_signed(chrono::Duration::days(30))
                .unwrap()
                .timestamp(),
        ),
        "custom" => custom_expires_at, // 使用自定义时间戳
        _ => None,                     // "never" or other
    };

    let user_token = UserToken {
        id: id.clone(),
        token: token.clone(),
        username: username.clone(),
        description: description.clone(),
        enabled: true,
        expires_type: expires_type.clone(),
        expires_at,
        max_ips,
        curfew_start: curfew_start.clone(),
        curfew_end: curfew_end.clone(),
        daily_quota,
        monthly_quota,
        daily_used: 0,
        monthly_used: 0,
        daily_anchor: None,
        monthly_anchor: None,
        created_at: now,
        updated_at: now,
        last_used_at: None,
        total_requests: 0,
        total_tokens_used: 0,
    };

    conn.execute(
        "INSERT INTO user_tokens (
            id, token, username, description, enabled, expires_type, expires_at, max_ips,
            curfew_start, curfew_end,
            daily_quota, monthly_quota, daily_used, monthly_used, daily_anchor, monthly_anchor,
            created_at, updated_at, total_requests, total_tokens_used
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
        params![
            user_token.id,
            user_token.token,
            user_token.username,
            user_token.description,
            user_token.enabled,
            user_token.expires_type,
            user_token.expires_at,
            user_token.max_ips,
            user_token.curfew_start,
            user_token.curfew_end,
            user_token.daily_quota,
            user_token.monthly_quota,
            user_token.daily_used,
            user_token.monthly_used,
            user_token.daily_anchor,
            user_token.monthly_anchor,
            user_token.created_at,
            user_token.updated_at,
            user_token.total_requests,
            user_token.total_tokens_used,
        ],
    )
    .map_err(|e| format!("Failed to insert user token: {}", e))?;

    Ok(user_token)
}

/// 列出所有令牌
pub fn list_tokens() -> Result<Vec<UserToken>, String> {
    let conn = connect_db()?;
    let mut stmt = conn
        .prepare("SELECT * FROM user_tokens ORDER BY created_at DESC")
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let token_iter = stmt
        .query_map([], |row| {
            Ok(UserToken {
                id: row.get("id")?,
                token: row.get("token")?,
                username: row.get("username")?,
                description: row.get("description")?,
                enabled: row.get("enabled").unwrap_or(true), // 防御性默认值
                expires_type: row.get("expires_type").unwrap_or("never".to_string()), // 防御性默认值
                expires_at: row.get("expires_at").unwrap_or(None),
                max_ips: row.get("max_ips").unwrap_or(0),
                curfew_start: row.get("curfew_start").unwrap_or(None),
                curfew_end: row.get("curfew_end").unwrap_or(None),
                daily_quota: row.get("daily_quota").unwrap_or(0),
                monthly_quota: row.get("monthly_quota").unwrap_or(0),
                daily_used: row.get("daily_used").unwrap_or(0),
                monthly_used: row.get("monthly_used").unwrap_or(0),
                daily_anchor: row.get("daily_anchor").unwrap_or(None),
                monthly_anchor: row.get("monthly_anchor").unwrap_or(None),
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
                last_used_at: row.get("last_used_at").unwrap_or(None),
                total_requests: row.get("total_requests").unwrap_or(0),
                total_tokens_used: row.get("total_tokens_used").unwrap_or(0),
            })
        })
        .map_err(|e| format!("Failed to query tokens: {}", e))?;

    let mut tokens = Vec::new();
    for token in token_iter {
        tokens.push(token.map_err(|e| format!("Failed to parse token row: {}", e))?);
    }

    Ok(tokens)
}

/// 获取单个令牌信息
pub fn get_token_by_id(id: &str) -> Result<Option<UserToken>, String> {
    let conn = connect_db()?;
    let mut stmt = conn
        .prepare("SELECT * FROM user_tokens WHERE id = ?1")
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let token = stmt
        .query_row(params![id], |row| {
            Ok(UserToken {
                id: row.get("id")?,
                token: row.get("token")?,
                username: row.get("username")?,
                description: row.get("description")?,
                enabled: row.get("enabled")?,
                expires_type: row.get("expires_type")?,
                expires_at: row.get("expires_at")?,
                max_ips: row.get("max_ips")?,
                curfew_start: row.get("curfew_start").unwrap_or(None),
                curfew_end: row.get("curfew_end").unwrap_or(None),
                daily_quota: row.get("daily_quota").unwrap_or(0),
                monthly_quota: row.get("monthly_quota").unwrap_or(0),
                daily_used: row.get("daily_used").unwrap_or(0),
                monthly_used: row.get("monthly_used").unwrap_or(0),
                daily_anchor: row.get("daily_anchor").unwrap_or(None),
                monthly_anchor: row.get("monthly_anchor").unwrap_or(None),
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
                last_used_at: row.get("last_used_at")?,
                total_requests: row.get("total_requests")?,
                total_tokens_used: row.get("total_tokens_used")?,
            })
        })
        .optional()
        .map_err(|e| format!("Failed to query token: {}", e))?;

    Ok(token)
}

/// 根据 Token 值获取令牌信息
pub fn get_token_by_value(token: &str) -> Result<Option<UserToken>, String> {
    let conn = connect_db()?;
    let mut stmt = conn
        .prepare("SELECT * FROM user_tokens WHERE token = ?1")
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let token = stmt
        .query_row(params![token], |row| {
            Ok(UserToken {
                id: row.get("id")?,
                token: row.get("token")?,
                username: row.get("username")?,
                description: row.get("description")?,
                enabled: row.get("enabled")?,
                expires_type: row.get("expires_type")?,
                expires_at: row.get("expires_at")?,
                max_ips: row.get("max_ips")?,
                curfew_start: row.get("curfew_start").unwrap_or(None),
                curfew_end: row.get("curfew_end").unwrap_or(None),
                daily_quota: row.get("daily_quota").unwrap_or(0),
                monthly_quota: row.get("monthly_quota").unwrap_or(0),
                daily_used: row.get("daily_used").unwrap_or(0),
                monthly_used: row.get("monthly_used").unwrap_or(0),
                daily_anchor: row.get("daily_anchor").unwrap_or(None),
                monthly_anchor: row.get("monthly_anchor").unwrap_or(None),
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
                last_used_at: row.get("last_used_at")?,
                total_requests: row.get("total_requests")?,
                total_tokens_used: row.get("total_tokens_used")?,
            })
        })
        .optional()
        .map_err(|e| format!("Failed to query token: {}", e))?;

    Ok(token)
}

/// 根据 Token 值获取令牌信息（使用传入的连接，便于测试）
pub fn get_token_by_value_with_conn(
    token: &str,
    conn: &Connection,
) -> Result<Option<UserToken>, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM user_tokens WHERE token = ?1")
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let token = stmt
        .query_row(params![token], |row| {
            Ok(UserToken {
                id: row.get("id")?,
                token: row.get("token")?,
                username: row.get("username")?,
                description: row.get("description")?,
                enabled: row.get("enabled")?,
                expires_type: row.get("expires_type")?,
                expires_at: row.get("expires_at")?,
                max_ips: row.get("max_ips")?,
                curfew_start: row.get("curfew_start").unwrap_or(None),
                curfew_end: row.get("curfew_end").unwrap_or(None),
                daily_quota: row.get("daily_quota").unwrap_or(0),
                monthly_quota: row.get("monthly_quota").unwrap_or(0),
                daily_used: row.get("daily_used").unwrap_or(0),
                monthly_used: row.get("monthly_used").unwrap_or(0),
                daily_anchor: row.get("daily_anchor").unwrap_or(None),
                monthly_anchor: row.get("monthly_anchor").unwrap_or(None),
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
                last_used_at: row.get("last_used_at")?,
                total_requests: row.get("total_requests")?,
                total_tokens_used: row.get("total_tokens_used")?,
            })
        })
        .optional()
        .map_err(|e| format!("Failed to query token: {}", e))?;

    Ok(token)
}

/// 更新令牌状态/备注等
/// 注意：daily_used/monthly_used/daily_anchor/monthly_anchor 由系统维护，
/// 不通过本接口暴露，防止通过修改已用量绕过额度限制。
pub fn update_token_with_conn(
    id: &str,
    username: Option<String>,
    description: Option<String>,
    enabled: Option<bool>,
    max_ips: Option<i32>,
    curfew_start: Option<Option<String>>,
    curfew_end: Option<Option<String>>,
    daily_quota: Option<i64>,
    monthly_quota: Option<i64>,
    conn: &Connection,
) -> Result<(), String> {
    let now = Utc::now().timestamp();

    let mut query = "UPDATE user_tokens SET updated_at = ?1".to_string();
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(now)];
    let mut param_idx = 2;

    if let Some(user) = username {
        query.push_str(&format!(", username = ?{}", param_idx));
        params_vec.push(Box::new(user));
        param_idx += 1;
    }

    if let Some(desc) = description {
        query.push_str(&format!(", description = ?{}", param_idx));
        params_vec.push(Box::new(desc));
        param_idx += 1;
    }

    if let Some(en) = enabled {
        query.push_str(&format!(", enabled = ?{}", param_idx));
        params_vec.push(Box::new(en));
        param_idx += 1;
    }

    if let Some(ips) = max_ips {
        query.push_str(&format!(", max_ips = ?{}", param_idx));
        params_vec.push(Box::new(ips));
        param_idx += 1;
    }

    if let Some(start) = curfew_start {
        query.push_str(&format!(", curfew_start = ?{}", param_idx));
        params_vec.push(Box::new(start));
        param_idx += 1;
    }

    if let Some(end) = curfew_end {
        query.push_str(&format!(", curfew_end = ?{}", param_idx));
        params_vec.push(Box::new(end));
        param_idx += 1;
    }

    if let Some(dq) = daily_quota {
        query.push_str(&format!(", daily_quota = ?{}", param_idx));
        params_vec.push(Box::new(dq));
        param_idx += 1;
    }

    if let Some(mq) = monthly_quota {
        query.push_str(&format!(", monthly_quota = ?{}", param_idx));
        params_vec.push(Box::new(mq));
        param_idx += 1;
    }

    query.push_str(&format!(" WHERE id = ?{}", param_idx));
    params_vec.push(Box::new(id.to_string()));

    // 将 Vec<Box<dyn ToSql>> 转换为 &[&dyn ToSql]
    let params_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();

    conn.execute(&query, params_refs.as_slice())
        .map_err(|e| format!("Failed to update user token: {}", e))?;

    Ok(())
}

/// 更新令牌状态/备注等（生产入口，连接全局数据库）
pub fn update_token(
    id: &str,
    username: Option<String>,
    description: Option<String>,
    enabled: Option<bool>,
    max_ips: Option<i32>,
    curfew_start: Option<Option<String>>,
    curfew_end: Option<Option<String>>,
    daily_quota: Option<i64>,
    monthly_quota: Option<i64>,
) -> Result<(), String> {
    let conn = connect_db()?;
    update_token_with_conn(
        id,
        username,
        description,
        enabled,
        max_ips,
        curfew_start,
        curfew_end,
        daily_quota,
        monthly_quota,
        &conn,
    )
}

/// 续期令牌
pub fn renew_token(id: &str, expires_type: &str) -> Result<(), String> {
    let conn = connect_db()?;
    let now = Utc::now().timestamp();

    let expires_at = match expires_type {
        "day" => Some(
            Utc::now()
                .checked_add_signed(chrono::Duration::days(1))
                .unwrap()
                .timestamp(),
        ),
        "week" => Some(
            Utc::now()
                .checked_add_signed(chrono::Duration::weeks(1))
                .unwrap()
                .timestamp(),
        ),
        "month" => Some(
            Utc::now()
                .checked_add_signed(chrono::Duration::days(30))
                .unwrap()
                .timestamp(),
        ),
        _ => None, // "never" or other
    };

    conn.execute(
        "UPDATE user_tokens SET expires_type = ?1, expires_at = ?2, updated_at = ?3, enabled = 1 WHERE id = ?4",
        params![expires_type, expires_at, now, id],
    ).map_err(|e| format!("Failed to renew token: {}", e))?;

    Ok(())
}

/// 删除令牌
pub fn delete_token(id: &str) -> Result<(), String> {
    let conn = connect_db()?;
    conn.execute("DELETE FROM user_tokens WHERE id = ?1", params![id])
        .map_err(|e| format!("Failed to delete token: {}", e))?;
    Ok(())
}

/// 清理超过 N 天的令牌用量明细（token_usage_logs 只增，长期运行需有界）。
/// request_time 为秒级 Unix 时间戳，与写入处 Utc::now().timestamp() 一致。
pub fn cleanup_old_usage_logs(days: i64) -> Result<usize, String> {
    let conn = connect_db()?;
    let cutoff = chrono::Utc::now().timestamp() - days * 24 * 3600;
    let deleted = conn
        .execute(
            "DELETE FROM token_usage_logs WHERE request_time < ?1",
            [cutoff],
        )
        .map_err(|e| e.to_string())?;
    Ok(deleted)
}

/// 获取令牌的所有 IP 绑定
pub fn get_token_ips(token_id: &str) -> Result<Vec<TokenIpBinding>, String> {
    let conn = connect_db()?;
    let mut stmt = conn
        .prepare("SELECT * FROM token_ip_bindings WHERE token_id = ?1 ORDER BY last_seen_at DESC")
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let iter = stmt
        .query_map(params![token_id], |row| {
            Ok(TokenIpBinding {
                id: row.get("id")?,
                token_id: row.get("token_id")?,
                ip_address: row.get("ip_address")?,
                first_seen_at: row.get("first_seen_at")?,
                last_seen_at: row.get("last_seen_at")?,
                request_count: row.get("request_count")?,
                user_agent: row.get("user_agent")?,
            })
        })
        .map_err(|e| format!("Failed to query token IPs: {}", e))?;

    let mut bindings = Vec::new();
    for b in iter {
        bindings.push(b.map_err(|e| format!("Failed to parse binding row: {}", e))?);
    }

    Ok(bindings)
}

/// 记录/更新令牌使用情况 (同时处理 user_tokens 和 token_ip_bindings)
pub fn record_token_usage_and_ip(
    token_id: &str,
    ip: &str,
    model: &str,
    input_tokens: i32,
    output_tokens: i32,
    status: u16,
    user_agent: Option<String>,
) -> Result<(), String> {
    let mut conn = connect_db()?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to create transaction: {}", e))?;
    let now = Utc::now().timestamp();

    // 1. 更新 user_tokens 主表
    tx.execute(
        "UPDATE user_tokens SET 
            last_used_at = ?1, 
            total_requests = total_requests + 1, 
            total_tokens_used = total_tokens_used + ?2 
        WHERE id = ?3",
        params![now, input_tokens + output_tokens, token_id],
    )
    .map_err(|e| format!("Failed to update user_tokens stats: {}", e))?;

    // 2. 更新或插入 token_ip_bindings 表
    let binding_exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM token_ip_bindings WHERE token_id = ?1 AND ip_address = ?2)",
        params![token_id, ip],
        |row| row.get(0),
    ).unwrap_or(false);

    if binding_exists {
        tx.execute(
            "UPDATE token_ip_bindings SET 
                last_seen_at = ?1, 
                request_count = request_count + 1,
                user_agent = COALESCE(?2, user_agent)
            WHERE token_id = ?3 AND ip_address = ?4",
            params![now, user_agent, token_id, ip],
        )
        .map_err(|e| format!("Failed to update ip binding: {}", e))?;
    } else {
        let binding_id = Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO token_ip_bindings (
                id, token_id, ip_address, first_seen_at, last_seen_at, request_count, user_agent
            ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
            params![binding_id, token_id, ip, now, now, user_agent],
        )
        .map_err(|e| format!("Failed to insert ip binding: {}", e))?;
    }

    // 3. 插入 token_usage_logs 表
    let log_id = Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO token_usage_logs (
            id, token_id, ip_address, model, input_tokens, output_tokens, request_time, status
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            log_id,
            token_id,
            ip,
            model,
            input_tokens,
            output_tokens,
            now,
            status
        ],
    )
    .map_err(|e| format!("Failed to insert usage log: {}", e))?;

    tx.commit()
        .map_err(|e| format!("Failed to commit transaction: {}", e))?;

    Ok(())
}

/// 计算当前周期锚点时间戳（北京时间 UTC+8，与宵禁时区一致）
/// 返回 (今日北京时间 00:00 的 UTC 秒, 本月 1 日北京时间 00:00 的 UTC 秒)
fn quota_period_anchors(now: chrono::DateTime<Utc>) -> (i64, i64) {
    let beijing = FixedOffset::east_opt(8 * 3600).unwrap();
    let now_bj = now.with_timezone(&beijing);

    // 今日 00:00 北京时间
    let today_start = now_bj
        .with_hour(0)
        .unwrap()
        .with_minute(0)
        .unwrap()
        .with_second(0)
        .unwrap()
        .with_nanosecond(0)
        .unwrap();
    let daily_anchor = today_start.timestamp();

    // 本月 1 日 00:00 北京时间
    let month_start = today_start.with_day(1).unwrap();
    let monthly_anchor = month_start.timestamp();

    (daily_anchor, monthly_anchor)
}

/// 确保 user_tokens 表存在（防御性：数据库文件被意外删除/重建后自动恢复）
fn ensure_quota_table_exists(conn: &Connection) -> Result<(), String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='user_tokens'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if count == 0 {
        init_db()?;
    }
    Ok(())
}

/// 额度预占：请求进入时原子冻结 QUOTA_HOLD_AMOUNT，防止并发超发。
/// 一条 UPDATE 同时完成周期翻转 + 预占 + 超限检查，SQLite 写锁串行化保证原子性。
/// 返回 (是否通过, 拒绝原因)
fn hold_quota(token: &UserToken, conn: &Connection) -> Result<(bool, Option<String>), String> {
    if token.daily_quota == 0 && token.monthly_quota == 0 {
        return Ok((true, None));
    }

    let now = Utc::now();
    let (daily_anchor, monthly_anchor) = quota_period_anchors(now);
    let hold = QUOTA_HOLD_AMOUNT;

    let affected = conn
        .execute(
            "UPDATE user_tokens
             SET
               daily_used = CASE
                 WHEN daily_anchor IS NULL OR daily_anchor != ?3 THEN ?5
                 ELSE daily_used + ?5
               END,
               monthly_used = CASE
                 WHEN monthly_anchor IS NULL OR monthly_anchor != ?4 THEN ?5
                 ELSE monthly_used + ?5
               END,
               daily_anchor = ?3,
               monthly_anchor = ?4
             WHERE id = ?1
               AND (?2 = 0 OR (
                 CASE WHEN daily_anchor IS NULL OR daily_anchor != ?3 THEN 0 ELSE daily_used END + ?5 <= ?2
               ))
               AND (?6 = 0 OR (
                 CASE WHEN monthly_anchor IS NULL OR monthly_anchor != ?4 THEN 0 ELSE monthly_used END + ?5 <= ?6
               ))",
            params![
                token.id,
                token.daily_quota,
                daily_anchor,
                monthly_anchor,
                hold,
                token.monthly_quota,
            ],
        )
        .map_err(|e| format!("Failed to hold quota: {}", e))?;

    if affected == 0 {
        // 预占失败 = 超限，读取当前已用量用于提示文案
        let (daily_used, monthly_used): (i64, i64) = conn
            .query_row(
                "SELECT daily_used, monthly_used FROM user_tokens WHERE id = ?1",
                params![token.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap_or((0, 0));
        let reason = format!(
            "Token quota exceeded. Daily: {}/{}, Monthly: {}/{}",
            daily_used, token.daily_quota, monthly_used, token.monthly_quota
        );
        return Ok((false, Some(reason)));
    }

    Ok((true, None))
}

/// 额度校正/回滚：响应结束后调用。
/// - 成功请求（status < 400）：按实际用量多退少补（差值 = 实际 - 预占）
/// - 失败请求（status >= 400）：全额回滚预占量
/// - 跨周期：若当前 anchor 与预占时不同，跳过校正（预占留旧周期自然过期，新周期从零开始）
pub fn settle_quota_usage(
    token_id: &str,
    actual_used: i64,
    status: u16,
    conn: &Connection,
) -> Result<(), String> {
    let now = Utc::now();
    let (daily_anchor_now, monthly_anchor_now) = quota_period_anchors(now);

    // 读取当前 anchor 和 quota，判断是否跨周期 / 是否完全不限
    let (daily_anchor, monthly_anchor, daily_quota, monthly_quota): (
        Option<i64>,
        Option<i64>,
        i64,
        i64,
    ) = match conn.query_row(
        "SELECT daily_anchor, monthly_anchor, daily_quota, monthly_quota FROM user_tokens WHERE id = ?1",
        params![token_id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get::<_, i64>(2).unwrap_or(0),
                row.get::<_, i64>(3).unwrap_or(0),
            ))
        },
    ) {
        Ok(v) => v,
        Err(_) => return Ok(()), // token 不存在或已删除，忽略
    };

    // 完全不限（日/月额度均为 0）：hold_quota 未预占，无需校正，避免污染 used
    if daily_quota == 0 && monthly_quota == 0 {
        return Ok(());
    }

    // 跨周期：跳过校正，预占留在旧周期自然过期
    if daily_anchor != Some(daily_anchor_now) || monthly_anchor != Some(monthly_anchor_now) {
        return Ok(());
    }

    let hold = QUOTA_HOLD_AMOUNT;
    let delta = if status >= 400 {
        -hold // 失败：全额回滚
    } else {
        actual_used - hold // 成功：多退少补
    };

    conn.execute(
        "UPDATE user_tokens SET daily_used = daily_used + ?1, monthly_used = monthly_used + ?1 WHERE id = ?2",
        params![delta, token_id],
    )
    .map_err(|e| format!("Failed to settle quota: {}", e))?;

    Ok(())
}

/// 检查 Token 是否有效 (包含过期时间检查和 IP 限制检查)
/// 检查 Token 是否有效（使用传入的连接，便于测试用内存数据库）
/// 返回: (是否有效, 拒绝原因)
pub fn validate_token_with_conn(
    token_str: &str,
    ip: &str,
    conn: &Connection,
) -> Result<(bool, Option<String>), String> {
    let token_opt = get_token_by_value_with_conn(token_str, conn)?;

    if let Some(token) = token_opt {
        // 1. 检查过期时间
        if token.expires_type != "never" {
            if let Some(expires_at) = token.expires_at {
                if expires_at < Utc::now().timestamp() {
                    return Ok((
                        false,
                        Some(
                            "Your token has expired. Please contact the administrator to renew it."
                                .to_string(),
                        ),
                    ));
                }
            }
        }

        // 2. 检查 IP 限制
        if token.max_ips > 0 {
            // 检查当前 IP 是否已绑定
            let is_bound: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM token_ip_bindings WHERE token_id = ?1 AND ip_address = ?2)",
                    params![token.id, ip],
                    |row| row.get(0),
                )
                .unwrap_or(false);

            if !is_bound {
                // 如果未绑定，检查是否达到上限
                let current_ip_count: i32 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM token_ip_bindings WHERE token_id = ?1",
                        params![token.id],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);

                if current_ip_count >= token.max_ips {
                    return Ok((false, Some(format!("IP limit reached ({}/{}). Please contact the administrator to increase the limit.", current_ip_count, token.max_ips))));
                }
            }
        }

        // 3. 检查宵禁时间 (Curfew)
        if let (Some(start_str), Some(end_str)) = (&token.curfew_start, &token.curfew_end) {
            if !start_str.is_empty() && !end_str.is_empty() {
                let beijing_offset = FixedOffset::east_opt(8 * 3600).unwrap();
                let now_beijing = Utc::now().with_timezone(&beijing_offset);
                let current_time_str =
                    format!("{:02}:{:02}", now_beijing.hour(), now_beijing.minute());

                let is_curfew = if start_str > end_str {
                    current_time_str >= *start_str || current_time_str < *end_str
                } else {
                    current_time_str >= *start_str && current_time_str < *end_str
                };

                if is_curfew {
                    return Ok((false, Some(format!("Service is not available between {} and {} Beijing Time (Curfew enabled). Current Beijing time: {}", start_str, end_str, current_time_str))));
                }
            }
        }

        // 4. 额度预占（原子冻结 QUOTA_HOLD_AMOUNT，超限则拒绝）
        let (quota_ok, quota_reason) = hold_quota(&token, conn)?;
        if !quota_ok {
            return Ok((false, quota_reason));
        }

        // 一切正常，Token 有效
        Ok((true, None))
    } else {
        Ok((
            false,
            Some("Invalid token. Please check your API key.".to_string()),
        ))
    }
}

/// 检查 Token 是否有效 (包含过期时间检查和 IP 限制检查)
/// 返回: (是否有效, 拒绝原因)
pub fn validate_token(token_str: &str, ip: &str) -> Result<(bool, Option<String>), String> {
    let conn = connect_db()?;
    ensure_quota_table_exists(&conn)?;
    validate_token_with_conn(token_str, ip, &conn)
}

/// 获取 IP 关联的用户名 (用于 IP 管理页面)
/// 返回最近一次使用该 IP 的 Token 所属的用户名
pub fn get_username_for_ip(ip: &str) -> Result<Option<String>, String> {
    let conn = connect_db()?;
    let result: Option<String> = conn
        .query_row(
            "SELECT t.username
         FROM token_ip_bindings b 
         JOIN user_tokens t ON b.token_id = t.id 
         WHERE b.ip_address = ?1 
         ORDER BY b.last_seen_at DESC 
         LIMIT 1",
            params![ip],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to query username by ip: {}", e))?;

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 创建内存测试数据库（完全脱离文件系统和环境变量）
    fn setup_test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db_with_conn(&conn).unwrap();
        conn
    }

    /// 测试辅助：在传入连接上创建带额度的 token
    fn create_test_token(conn: &Connection, daily_quota: i64, monthly_quota: i64) -> UserToken {
        let id = Uuid::new_v4().to_string();
        let token_str = format!("sk-{}", Uuid::new_v4().to_string().replace("-", ""));
        let now = Utc::now().timestamp();
        conn.execute(
            "INSERT INTO user_tokens (
                id, token, username, description, enabled, expires_type, expires_at, max_ips,
                curfew_start, curfew_end,
                daily_quota, monthly_quota, daily_used, monthly_used, daily_anchor, monthly_anchor,
                created_at, updated_at, total_requests, total_tokens_used
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
            params![
                id,
                token_str,
                "test_user",
                None::<String>,
                true,
                "never",
                None::<i64>,
                0,
                None::<String>,
                None::<String>,
                daily_quota,
                monthly_quota,
                0,
                0,
                None::<i64>,
                None::<i64>,
                now,
                now,
                0,
                0,
            ],
        )
        .unwrap();
        get_token_by_value_with_conn(&token_str, conn)
            .unwrap()
            .unwrap()
    }

    /// 测试辅助：直接设置 token 的额度使用状态
    fn set_quota_state(
        conn: &Connection,
        token_id: &str,
        daily_used: i64,
        monthly_used: i64,
        daily_anchor: Option<i64>,
        monthly_anchor: Option<i64>,
    ) {
        conn.execute(
            "UPDATE user_tokens SET daily_used = ?1, monthly_used = ?2, daily_anchor = ?3, monthly_anchor = ?4 WHERE id = ?5",
            params![daily_used, monthly_used, daily_anchor, monthly_anchor, token_id],
        )
        .unwrap();
    }

    /// 测试辅助：查询 token 当前状态
    fn get_test_token(conn: &Connection, token_id: &str) -> UserToken {
        conn.query_row(
            "SELECT * FROM user_tokens WHERE id = ?1",
            params![token_id],
            |row| {
                Ok(UserToken {
                    id: row.get("id")?,
                    token: row.get("token")?,
                    username: row.get("username")?,
                    description: row.get("description")?,
                    enabled: row.get("enabled")?,
                    expires_type: row.get("expires_type")?,
                    expires_at: row.get("expires_at")?,
                    max_ips: row.get("max_ips")?,
                    curfew_start: row.get("curfew_start").unwrap_or(None),
                    curfew_end: row.get("curfew_end").unwrap_or(None),
                    daily_quota: row.get("daily_quota").unwrap_or(0),
                    monthly_quota: row.get("monthly_quota").unwrap_or(0),
                    daily_used: row.get("daily_used").unwrap_or(0),
                    monthly_used: row.get("monthly_used").unwrap_or(0),
                    daily_anchor: row.get("daily_anchor").unwrap_or(None),
                    monthly_anchor: row.get("monthly_anchor").unwrap_or(None),
                    created_at: row.get("created_at")?,
                    updated_at: row.get("updated_at")?,
                    last_used_at: row.get("last_used_at")?,
                    total_requests: row.get("total_requests")?,
                    total_tokens_used: row.get("total_tokens_used")?,
                })
            },
        )
        .unwrap()
    }

    #[test]
    fn test_create_and_query_token() {
        let conn = setup_test_conn();
        let token = create_test_token(&conn, 0, 0);
        assert_eq!(token.username, "test_user");
        assert!(token.token.starts_with("sk-"));
        let fetched = get_test_token(&conn, &token.id);
        assert_eq!(fetched.username, "test_user");
    }

    #[test]
    fn test_never_expire_token_validation() {
        let conn = setup_test_conn();
        let token = create_test_token(&conn, 0, 0);
        let (valid, reason) = validate_token_with_conn(&token.token, "127.0.0.1", &conn).unwrap();
        assert!(
            valid,
            "never-expire token must be valid, reason: {:?}",
            reason
        );
    }

    // ===== 额度限制测试 =====

    #[test]
    fn test_quota_zero_means_unlimited() {
        let conn = setup_test_conn();
        let token = create_test_token(&conn, 0, 0);
        let (valid, _) = validate_token_with_conn(&token.token, "127.0.0.1", &conn).unwrap();
        assert!(valid, "Zero quota means unlimited");
        let fetched = get_test_token(&conn, &token.id);
        assert_eq!(
            fetched.daily_used, 0,
            "Unlimited token should not hold quota"
        );
    }

    #[test]
    fn test_daily_quota_hold_succeeds_under_limit() {
        let conn = setup_test_conn();
        let token = create_test_token(&conn, 20000, 0);
        let (valid, _) = validate_token_with_conn(&token.token, "127.0.0.1", &conn).unwrap();
        assert!(valid);
        let fetched = get_test_token(&conn, &token.id);
        assert_eq!(fetched.daily_used, QUOTA_HOLD_AMOUNT);
        assert!(fetched.daily_anchor.is_some());
    }

    #[test]
    fn test_daily_quota_hold_fails_when_exceeded() {
        let conn = setup_test_conn();
        // quota=5000 < hold=8192，第一次就应该拒绝
        let token = create_test_token(&conn, 5000, 0);
        let (valid, reason) = validate_token_with_conn(&token.token, "127.0.0.1", &conn).unwrap();
        assert!(!valid, "Should reject when hold exceeds quota");
        assert!(reason.is_some());
        assert!(reason.unwrap().contains("quota exceeded"));
        let fetched = get_test_token(&conn, &token.id);
        assert_eq!(
            fetched.daily_used, 0,
            "Rejected request must not modify used"
        );
    }

    #[test]
    fn test_daily_quota_hold_fails_after_accumulation() {
        let conn = setup_test_conn();
        // quota=20000, hold=8192: 第1次成功(8192), 第2次成功(16384), 第3次失败(24576>20000)
        let token = create_test_token(&conn, 20000, 0);
        let (v1, _) = validate_token_with_conn(&token.token, "127.0.0.1", &conn).unwrap();
        let (v2, _) = validate_token_with_conn(&token.token, "127.0.0.1", &conn).unwrap();
        let (v3, _) = validate_token_with_conn(&token.token, "127.0.0.1", &conn).unwrap();
        assert!(v1 && v2, "First two holds should succeed");
        assert!(!v3, "Third hold should fail (24576 > 20000)");
        let fetched = get_test_token(&conn, &token.id);
        assert_eq!(fetched.daily_used, QUOTA_HOLD_AMOUNT * 2);
    }

    #[test]
    fn test_quota_settle_success_refunds_excess() {
        let conn = setup_test_conn();
        let token = create_test_token(&conn, 20000, 0);
        validate_token_with_conn(&token.token, "127.0.0.1", &conn).unwrap(); // 预占 8192
        settle_quota_usage(&token.id, 1000, 200, &conn).unwrap();
        let fetched = get_test_token(&conn, &token.id);
        assert_eq!(fetched.daily_used, 1000, "Should refund excess hold");
    }

    #[test]
    fn test_quota_settle_success_charges_deficit() {
        let conn = setup_test_conn();
        let token = create_test_token(&conn, 30000, 0);
        validate_token_with_conn(&token.token, "127.0.0.1", &conn).unwrap();
        settle_quota_usage(&token.id, 16000, 200, &conn).unwrap();
        let fetched = get_test_token(&conn, &token.id);
        assert_eq!(fetched.daily_used, 16000, "Should charge deficit");
    }

    #[test]
    fn test_quota_settle_failure_rolls_back_full() {
        let conn = setup_test_conn();
        let token = create_test_token(&conn, 20000, 0);
        validate_token_with_conn(&token.token, "127.0.0.1", &conn).unwrap();
        settle_quota_usage(&token.id, 5000, 500, &conn).unwrap();
        let fetched = get_test_token(&conn, &token.id);
        assert_eq!(
            fetched.daily_used, 0,
            "Failed request must roll back full hold"
        );
    }

    #[test]
    fn test_daily_quota_resets_at_midnight() {
        let conn = setup_test_conn();
        let token = create_test_token(&conn, 20000, 0);
        validate_token_with_conn(&token.token, "127.0.0.1", &conn).unwrap();

        let (today_anchor, _) = quota_period_anchors(Utc::now());
        set_quota_state(&conn, &token.id, 16384, 0, Some(today_anchor - 86400), None);

        let (valid, _) = validate_token_with_conn(&token.token, "127.0.0.1", &conn).unwrap();
        assert!(valid, "Should pass after daily reset");
        let fetched = get_test_token(&conn, &token.id);
        assert_eq!(
            fetched.daily_used, QUOTA_HOLD_AMOUNT,
            "daily_used should reset on new day"
        );
        assert_eq!(fetched.daily_anchor, Some(today_anchor));
    }

    #[test]
    fn test_monthly_quota_resets_at_month_start() {
        let conn = setup_test_conn();
        let token = create_test_token(&conn, 0, 100000);
        validate_token_with_conn(&token.token, "127.0.0.1", &conn).unwrap();

        let (_, month_anchor) = quota_period_anchors(Utc::now());
        set_quota_state(
            &conn,
            &token.id,
            0,
            90000,
            None,
            Some(month_anchor - 40 * 86400),
        );

        let (valid, _) = validate_token_with_conn(&token.token, "127.0.0.1", &conn).unwrap();
        assert!(valid, "Should pass after monthly reset");
        let fetched = get_test_token(&conn, &token.id);
        assert_eq!(
            fetched.monthly_used, QUOTA_HOLD_AMOUNT,
            "monthly_used should reset on new month"
        );
    }

    #[test]
    fn test_concurrent_hold_never_exceeds_limit() {
        // 并发测试需要共享数据库文件（内存数据库每个连接独立）
        let tmp_dir = tempfile::tempdir().unwrap();
        let db_path = tmp_dir.path().join("concurrent_test.db");
        let db_path_str = db_path.to_str().unwrap().to_string();

        // 主线程初始化
        {
            let conn = Connection::open(&db_path).unwrap();
            init_db_with_conn(&conn).unwrap();
            let token = create_test_token(&conn, 20000, 0);
            std::mem::forget(token); // token 存在 DB 中，不需要 Rust 对象
        }

        // 并发 5 个线程，每个打开自己的连接
        let mut handles = vec![];
        for _ in 0..5 {
            let path = db_path_str.clone();
            handles.push(std::thread::spawn(move || {
                let conn = Connection::open(&path).unwrap();
                // 找到第一个 token
                let token_str: String = conn
                    .query_row("SELECT token FROM user_tokens LIMIT 1", [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                validate_token_with_conn(&token_str, "127.0.0.1", &conn)
                    .unwrap()
                    .0
            }));
        }
        let results: Vec<bool> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let success_count = results.iter().filter(|&&v| v).count();
        assert!(
            success_count <= 2,
            "Concurrent holds must not exceed quota (max 2), got {}",
            success_count
        );

        // 验证最终 used 不超过 quota
        let conn = Connection::open(&db_path).unwrap();
        let daily_used: i64 = conn
            .query_row("SELECT daily_used FROM user_tokens LIMIT 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(
            daily_used <= 20000,
            "daily_used {} must not exceed quota 20000",
            daily_used
        );
    }

    #[test]
    fn test_update_token_cannot_modify_used_or_anchor() {
        let conn = setup_test_conn();
        let token = create_test_token(&conn, 10000, 0);
        set_quota_state(&conn, &token.id, 5000, 0, Some(1234567890), None);

        update_token_with_conn(
            &token.id,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(20000),
            Some(0),
            &conn,
        )
        .unwrap();

        let fetched = get_test_token(&conn, &token.id);
        assert_eq!(fetched.daily_quota, 20000, "quota should be updated");
        assert_eq!(
            fetched.daily_used, 5000,
            "used must NOT be modified by update_token"
        );
        assert_eq!(
            fetched.daily_anchor,
            Some(1234567890),
            "anchor must NOT be modified by update_token"
        );
    }

    #[test]
    fn test_legacy_token_migration_defaults_to_zero() {
        let conn = setup_test_conn();
        let token = create_test_token(&conn, 0, 0);
        assert_eq!(token.daily_quota, 0);
        assert_eq!(token.monthly_quota, 0);
        assert_eq!(token.daily_used, 0);
        assert_eq!(token.daily_anchor, None);

        let (valid, _) = validate_token_with_conn(&token.token, "127.0.0.1", &conn).unwrap();
        assert!(valid, "Legacy token with zero quota must be unlimited");
    }

    #[test]
    fn test_settle_skips_when_cross_period() {
        let conn = setup_test_conn();
        let token = create_test_token(&conn, 20000, 0);
        validate_token_with_conn(&token.token, "127.0.0.1", &conn).unwrap();

        let (today_anchor, _) = quota_period_anchors(Utc::now());
        set_quota_state(
            &conn,
            &token.id,
            QUOTA_HOLD_AMOUNT,
            0,
            Some(today_anchor - 86400),
            None,
        );

        settle_quota_usage(&token.id, 1000, 200, &conn).unwrap();
        let fetched = get_test_token(&conn, &token.id);
        assert_eq!(
            fetched.daily_used, QUOTA_HOLD_AMOUNT,
            "Cross-period settle should be skipped, used unchanged"
        );
    }

    #[test]
    fn test_settle_skips_when_quota_all_zero() {
        let conn = setup_test_conn();
        let token = create_test_token(&conn, 0, 0); // 完全不限
        validate_token_with_conn(&token.token, "127.0.0.1", &conn).unwrap();
        let fetched = get_test_token(&conn, &token.id);
        assert_eq!(
            fetched.daily_used, 0,
            "Unlimited token should not hold quota"
        );

        // 校正不应污染 used（hold_quota 未预占，settle 必须跳过）
        settle_quota_usage(&token.id, 5000, 200, &conn).unwrap();
        let fetched = get_test_token(&conn, &token.id);
        assert_eq!(
            fetched.daily_used, 0,
            "Unlimited token settle must not modify daily_used"
        );
        assert_eq!(
            fetched.monthly_used, 0,
            "Unlimited token settle must not modify monthly_used"
        );
    }
}
