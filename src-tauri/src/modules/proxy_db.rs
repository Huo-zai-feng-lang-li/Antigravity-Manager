use crate::proxy::monitor::ProxyRequestLog;
use rusqlite::{params, Connection};
use std::path::PathBuf;

pub fn get_proxy_db_path() -> Result<PathBuf, String> {
    let data_dir = crate::modules::account::get_data_dir()?;
    Ok(data_dir.join("proxy_logs.db"))
}

fn connect_db() -> Result<Connection, String> {
    let db_path = get_proxy_db_path()?;
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    // Enable WAL mode for better concurrency
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;

    // Set busy timeout to 5000ms to avoid "database is locked" errors
    conn.pragma_update(None, "busy_timeout", 5000)
        .map_err(|e| e.to_string())?;

    // Synchronous NORMAL is faster and safe enough for WAL
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| e.to_string())?;

    Ok(conn)
}

pub fn init_db() -> Result<(), String> {
    // connect_db will initialize WAL mode and other pragmas
    let conn = connect_db()?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS request_logs (
            id TEXT PRIMARY KEY,
            timestamp INTEGER,
            method TEXT,
            url TEXT,
            status INTEGER,
            duration INTEGER,
            model TEXT,
            error TEXT
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    // Try to add new columns (ignore errors if they exist)
    let _ = conn.execute("ALTER TABLE request_logs ADD COLUMN request_body TEXT", []);
    let _ = conn.execute("ALTER TABLE request_logs ADD COLUMN response_body TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE request_logs ADD COLUMN input_tokens INTEGER",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE request_logs ADD COLUMN output_tokens INTEGER",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE request_logs ADD COLUMN cached_tokens INTEGER",
        [],
    );
    let _ = conn.execute("ALTER TABLE request_logs ADD COLUMN account_email TEXT", []);
    let _ = conn.execute("ALTER TABLE request_logs ADD COLUMN mapped_model TEXT", []);
    let _ = conn.execute("ALTER TABLE request_logs ADD COLUMN protocol TEXT", []);
    let _ = conn.execute("ALTER TABLE request_logs ADD COLUMN client_ip TEXT", []);
    let _ = conn.execute("ALTER TABLE request_logs ADD COLUMN username TEXT", []);
    let _ = conn.execute("ALTER TABLE request_logs ADD COLUMN session_title TEXT", []);

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_timestamp ON request_logs (timestamp DESC)",
        [],
    )
    .map_err(|e| e.to_string())?;

    // Add status index for faster stats queries
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_status ON request_logs (status)",
        [],
    )
    .map_err(|e| e.to_string())?;

    // 回填历史日志的会话标题（仅处理响应里含 title 标记且尚未提取的行）
    backfill_session_titles(&conn);

    Ok(())
}

/// 报文落库时头部保留的最大字节数（模型参数/系统提示位于 JSON 头部）。
const BODY_HEAD_LIMIT: usize = 12 * 1024;
/// 报文落库时尾部保留的最大字节数（用户最后的提问、多模态图片位于 JSON 尾部）。
const BODY_TAIL_LIMIT: usize = 12 * 1024;
/// 含内联图片的报文整体保留上限（base64 图片通常 1~3MB，完整保留才能在对话视图显示缩略图）。
const IMAGE_BODY_LIMIT: usize = 10 * 1024 * 1024;

/// 在不截断 UTF-8 字符的前提下，取字符串的前 max_bytes 字节。
fn safe_prefix(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// 在不截断 UTF-8 字符的前提下，取字符串的后 max_bytes 字节。
fn safe_suffix(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut start = s.len() - max_bytes;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

/// 统计报文中内联图片的数量（按 MIME 标记字节匹配，无需解析 JSON）。
/// 覆盖 OpenAI(`data:image/`)、Anthropic(`media_type`)、Gemini REST(`mimeType`)
/// 与 Gemini protobuf(`mime_type`) 四种写法；外链图片（http URL）不在此计数，
/// 由前端解析器直接抢救 URL。
fn count_inline_images(body: &str) -> usize {
    let needles = [
        "data:image/",
        "\"media_type\":\"image/",
        "\"mimeType\":\"image/",
        "\"mime_type\":\"image/",
    ];
    needles
        .iter()
        .map(|needle| body.matches(needle).count())
        .max()
        .unwrap_or(0)
}

/// 超长报文按"头部 + 尾部"保留，中间省略。
///
/// 单纯保留头部会把 JSON 尾部的用户输入与多模态图片整体切掉，
/// 导致对话视图只能看到模型回答；头尾各保留一段后，前端解析器
/// 还能从尾部抢救出最后一条用户消息和图片标记。标记中附带内联
/// 图片数量，供前端为物理上不完整的 base64 图片生成占位卡片。
fn truncate_body(body: &str) -> String {
    // 含内联图片的报文在 IMAGE_BODY_LIMIT 内完整保留，否则 base64 被切断后对话视图无法显示图片
    if count_inline_images(body) > 0 && body.len() <= IMAGE_BODY_LIMIT {
        return body.to_string();
    }
    if body.len() <= BODY_HEAD_LIMIT + BODY_TAIL_LIMIT {
        return body.to_string();
    }

    let head = safe_prefix(body, BODY_HEAD_LIMIT);
    let tail = safe_suffix(body, BODY_TAIL_LIMIT);
    let omitted_bytes = body.len() - head.len() - tail.len();
    let image_count = count_inline_images(body);

    let marker = if image_count > 0 {
        format!("...[truncated {omitted_bytes} bytes;images={image_count}]...")
    } else {
        format!("...[truncated {omitted_bytes} bytes]...")
    };
    format!("{head}{marker}{tail}")
}

/// 判断请求是否为客户端自动生成会话标题的元请求。
fn looks_like_title_request(request_body: &str) -> bool {
    let r = request_body.to_lowercase();
    const KEYWORDS: &[&str] = &[
        "generate a short title", "task category",
        "write a 5-10 word title", "respond with the title",
        "generate a title for", "create a brief title",
        "title for the conversation", "conversation title",
        "generate the title", "containing a title",
        "生成标题", "为对话起个标题",
    ];
    KEYWORDS.iter().any(|k| r.contains(k))
}

/// 从混合文本中提取 "title":"..." 的值（处理转义，限长 100）。
fn find_title_in_text(text: &str) -> Option<String> {
    let key = "\"title\"";
    let pos = text.find(key)?;
    let rest = text[pos + key.len()..].trim_start();
    let rest = rest.strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let mut out = String::new();
    let mut escaped = false;
    for ch in rest.chars() {
        if escaped {
            out.push(ch);
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '"' => break,
            _ => out.push(ch),
        }
    }
    let out = out.trim().to_string();
    if out.is_empty() || out.len() > 100 { None } else { Some(out) }
}

/// 从标题生成请求的响应里提取会话标题。
/// 顶层 {title,category} 直接采信；content/output_text 内嵌 JSON 仅在请求像标题生成时采信。
fn extract_session_title(request_body: &str, response_body: &str) -> Option<String> {
    if request_body.is_empty() || response_body.is_empty() {
        return None;
    }
    let v: serde_json::Value = match serde_json::from_str(response_body) {
        Ok(v) => v,
        Err(_) => {
            return if looks_like_title_request(request_body) {
                find_title_in_text(response_body)
            } else {
                None
            };
        }
    };

    // 响应本身就是 {"title":...,"category":...}
    if let Some(t) = v.get("title").and_then(|x| x.as_str()) {
        let t = t.trim();
        if !t.is_empty() && t.len() <= 100 {
            return Some(t.to_string());
        }
    }

    if !looks_like_title_request(request_body) {
        return None;
    }
    let content = v
        .pointer("/choices/0/message/content")
        .or_else(|| v.pointer("/choices/0/text"))
        .or_else(|| v.get("output_text"))
        .or_else(|| v.get("content"))
        .and_then(|x| x.as_str());
    content.and_then(find_title_in_text)
}

/// 回填历史日志的会话标题。
fn backfill_session_titles(conn: &rusqlite::Connection) {
    let rows: Vec<(String, Option<String>, Option<String>)> = {
        let mut stmt = match conn.prepare(
            "SELECT id, request_body, response_body FROM request_logs 
             WHERE session_title IS NULL AND response_body LIKE '%\"title\"%' LIMIT 1000",
        ) {
            Ok(s) => s,
            Err(_) => return,
        };
        // 先取候选行（session_title 为空的），再在 Rust 侧按关键词/JSON 精确判断
        let iter = match stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get(1)?, row.get(2)?))
        }) {
            Ok(it) => it,
            Err(_) => return,
        };
        iter.filter_map(|r| r.ok()).collect()
    };
    for (id, req, resp) in rows {
        if let (Some(req), Some(resp)) = (req.as_deref(), resp.as_deref()) {
            if let Some(title) = extract_session_title(req, resp) {
                let _ = conn.execute(
                    "UPDATE request_logs SET session_title = ?1 WHERE id = ?2 AND session_title IS NULL",
                    rusqlite::params![title, id],
                );
            }
        }
    }
}

pub fn save_log(log: &ProxyRequestLog) -> Result<(), String> {
    let conn = connect_db()?;

    let request_body = log.request_body.as_deref().map(truncate_body);
    let response_body = log.response_body.as_deref().map(truncate_body);
    let session_title = match (log.request_body.as_deref(), log.response_body.as_deref()) {
        (Some(req), Some(resp)) => extract_session_title(req, resp),
        _ => None,
    };

    conn.execute(
        "INSERT INTO request_logs (id, timestamp, method, url, status, duration, model, error, request_body, response_body, input_tokens, output_tokens, cached_tokens, account_email, mapped_model, protocol, client_ip, username, session_title)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
        params![
            log.id,
            log.timestamp,
            log.method,
            log.url,
            log.status,
            log.duration,
            log.model,
            log.error,
            request_body,
            response_body,
            log.input_tokens,
            log.output_tokens,
            log.cached_tokens,
            log.account_email,
            log.mapped_model,
            log.protocol,
            log.client_ip,
            log.username,
            session_title,
        ],
    ).map_err(|e| e.to_string())?;

    Ok(())
}

/// Get logs summary (without large request_body and response_body fields) with pagination
pub fn get_logs_summary(limit: usize, offset: usize) -> Result<Vec<ProxyRequestLog>, String> {
    let conn = connect_db()?;

    let mut stmt = conn
        .prepare(
            "SELECT id, timestamp, method, url, status, duration, model, error,
                NULL as request_body, NULL as response_body,
                input_tokens, output_tokens, cached_tokens, account_email, mapped_model, protocol, client_ip, username,
                session_title
         FROM request_logs
         ORDER BY timestamp DESC
         LIMIT ?1 OFFSET ?2",
        )
        .map_err(|e| e.to_string())?;

    let logs_iter = stmt
        .query_map([limit, offset], |row| {
            Ok(ProxyRequestLog {
                id: row.get(0)?,
                timestamp: row.get(1)?,
                method: row.get(2)?,
                url: row.get(3)?,
                status: row.get(4)?,
                duration: row.get(5)?,
                model: row.get(6)?,
                error: row.get(7)?,
                request_body: None,  // Don't query large fields for list view
                response_body: None, // Don't query large fields for list view
                input_tokens: row.get(10).unwrap_or(None),
                output_tokens: row.get(11).unwrap_or(None),
                cached_tokens: row.get(12).unwrap_or(None),
                account_email: row.get(13).unwrap_or(None),
                mapped_model: row.get(14).unwrap_or(None),
                protocol: row.get(15).unwrap_or(None),
                client_ip: row.get(16).unwrap_or(None),
                username: row.get(17).unwrap_or(None),
                user_agent: None,
                session_title: row.get(18).unwrap_or(None),
            })
        })
        .map_err(|e| e.to_string())?;

    let mut logs = Vec::new();
    for log in logs_iter {
        logs.push(log.map_err(|e| e.to_string())?);
    }
    Ok(logs)
}

/// Get logs (backward compatible, calls get_logs_summary)
pub fn get_logs(limit: usize) -> Result<Vec<ProxyRequestLog>, String> {
    get_logs_summary(limit, 0)
}

pub fn get_stats() -> Result<crate::proxy::monitor::ProxyStats, String> {
    let conn = connect_db()?;

    // Optimized: Use single query instead of three separate queries
    // Use COALESCE to handle NULL values when table is empty (SUM returns NULL for empty set)
    let (total_requests, success_count, error_count): (u64, u64, u64) = conn
        .query_row(
            "SELECT
            COUNT(*) as total,
            COALESCE(SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END), 0) as success,
            COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) as error
         FROM request_logs",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|e| e.to_string())?;

    Ok(crate::proxy::monitor::ProxyStats {
        total_requests,
        success_count,
        error_count,
    })
}

/// Get single log detail (with request_body and response_body)
pub fn get_log_detail(log_id: &str) -> Result<ProxyRequestLog, String> {
    let conn = connect_db()?;

    let mut stmt = conn
        .prepare(
            "SELECT id, timestamp, method, url, status, duration, model, error,
                request_body, response_body, input_tokens, output_tokens,
                cached_tokens, account_email, mapped_model, protocol, client_ip, username,
                session_title
         FROM request_logs
         WHERE id = ?1",
        )
        .map_err(|e| e.to_string())?;

    stmt.query_row([log_id], |row| {
        Ok(ProxyRequestLog {
            id: row.get(0)?,
            timestamp: row.get(1)?,
            method: row.get(2)?,
            url: row.get(3)?,
            status: row.get(4)?,
            duration: row.get(5)?,
            model: row.get(6)?,
            error: row.get(7)?,
            request_body: row.get(8).unwrap_or(None),
            response_body: row.get(9).unwrap_or(None),
            input_tokens: row.get(10).unwrap_or(None),
            output_tokens: row.get(11).unwrap_or(None),
            cached_tokens: row.get(12).unwrap_or(None),
            account_email: row.get(13).unwrap_or(None),
            mapped_model: row.get(14).unwrap_or(None),
            protocol: row.get(15).unwrap_or(None),
            client_ip: row.get(16).unwrap_or(None),
            username: row.get(17).unwrap_or(None),
            user_agent: None,
            session_title: row.get(18).unwrap_or(None),
        })
    })
    .map_err(|e| e.to_string())
}

/// Cleanup old logs (keep last N days)
pub fn cleanup_old_logs(days: i64) -> Result<usize, String> {
    let conn = connect_db()?;

    // Note: Request log timestamp is stored in milliseconds (chrono::Utc::now().timestamp_millis())
    let cutoff_timestamp_ms = chrono::Utc::now().timestamp_millis() - (days * 24 * 3600 * 1000);

    let deleted = conn
        .execute(
            "DELETE FROM request_logs WHERE timestamp < ?1",
            [cutoff_timestamp_ms],
        )
        .map_err(|e| e.to_string())?;

    // Only execute VACUUM when substantial rows were deleted to avoid saturating disk I/O on startup
    if deleted >= 500 {
        if let Err(e) = conn.execute("VACUUM", []) {
            tracing::warn!("VACUUM failed after log cleanup: {}", e);
        }
    }

    Ok(deleted)
}

/// Limit maximum log count (keep newest N records)
#[allow(dead_code)]
pub fn limit_max_logs(max_count: usize) -> Result<usize, String> {
    let conn = connect_db()?;

    let deleted = conn
        .execute(
            "DELETE FROM request_logs WHERE id NOT IN (
            SELECT id FROM request_logs ORDER BY timestamp DESC LIMIT ?1
        )",
            [max_count],
        )
        .map_err(|e| e.to_string())?;

    // Only execute VACUUM when substantial rows were deleted
    if deleted >= 500 {
        if let Err(e) = conn.execute("VACUUM", []) {
            tracing::warn!("VACUUM failed after limit_max_logs: {}", e);
        }
    }

    Ok(deleted)
}

pub fn clear_logs() -> Result<(), String> {
    let conn = connect_db()?;
    conn.execute("DELETE FROM request_logs", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Get total count of logs in database
pub fn get_logs_count() -> Result<u64, String> {
    let conn = connect_db()?;

    let count: u64 = conn
        .query_row("SELECT COUNT(*) FROM request_logs", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;

    Ok(count)
}

/// Get count of logs matching search filter
/// filter: search text to match in url, method, model, or status
/// errors_only: if true, only count logs with status < 200 or >= 400
pub fn get_logs_count_filtered(filter: &str, errors_only: bool) -> Result<u64, String> {
    let conn = connect_db()?;

    let filter_pattern = format!("%{}%", filter);

    let sql = if errors_only {
        "SELECT COUNT(*) FROM request_logs WHERE (status < 200 OR status >= 400)"
    } else if filter.is_empty() {
        "SELECT COUNT(*) FROM request_logs"
    } else {
        "SELECT COUNT(*) FROM request_logs WHERE
            (url LIKE ?1 OR method LIKE ?1 OR model LIKE ?1 OR CAST(status AS TEXT) LIKE ?1 OR account_email LIKE ?1)"
    };

    let count: u64 = if filter.is_empty() && !errors_only {
        conn.query_row(sql, [], |row| row.get(0))
    } else if errors_only {
        conn.query_row(sql, [], |row| row.get(0))
    } else {
        conn.query_row(sql, [&filter_pattern], |row| row.get(0))
    }
    .map_err(|e| e.to_string())?;

    Ok(count)
}

/// Get logs with search filter and pagination
/// filter: search text to match in url, method, model, or status
/// errors_only: if true, only return logs with status < 200 or >= 400
pub fn get_logs_filtered(
    filter: &str,
    errors_only: bool,
    limit: usize,
    offset: usize,
) -> Result<Vec<ProxyRequestLog>, String> {
    let conn = connect_db()?;

    let filter_pattern = format!("%{}%", filter);

    let sql = if errors_only {
        "SELECT id, timestamp, method, url, status, duration, model, error,
                NULL as request_body, NULL as response_body,
                input_tokens, output_tokens, cached_tokens, account_email, mapped_model, protocol, client_ip, username,
                session_title
         FROM request_logs
         WHERE (status < 200 OR status >= 400)
         ORDER BY timestamp DESC
         LIMIT ?1 OFFSET ?2"
    } else if filter.is_empty() {
        "SELECT id, timestamp, method, url, status, duration, model, error,
                NULL as request_body, NULL as response_body,
                input_tokens, output_tokens, cached_tokens, account_email, mapped_model, protocol, client_ip, username,
                session_title
         FROM request_logs
         ORDER BY timestamp DESC
         LIMIT ?1 OFFSET ?2"
    } else {
        "SELECT id, timestamp, method, url, status, duration, model, error,
                NULL as request_body, NULL as response_body,
                input_tokens, output_tokens, cached_tokens, account_email, mapped_model, protocol, client_ip, username,
                session_title
         FROM request_logs
         WHERE (url LIKE ?3 OR method LIKE ?3 OR model LIKE ?3 OR CAST(status AS TEXT) LIKE ?3 OR account_email LIKE ?3 OR client_ip LIKE ?3)
         ORDER BY timestamp DESC
         LIMIT ?1 OFFSET ?2"
    };

    let logs: Vec<ProxyRequestLog> = if filter.is_empty() && !errors_only {
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let logs_iter = stmt
            .query_map([limit, offset], |row| {
                Ok(ProxyRequestLog {
                    id: row.get(0)?,
                    timestamp: row.get(1)?,
                    method: row.get(2)?,
                    url: row.get(3)?,
                    status: row.get(4)?,
                    duration: row.get(5)?,
                    model: row.get(6)?,
                    error: row.get(7)?,
                    request_body: None,
                    response_body: None,
                    input_tokens: row.get(10).unwrap_or(None),
                    output_tokens: row.get(11).unwrap_or(None),
                    cached_tokens: row.get(12).unwrap_or(None),
                    account_email: row.get(13).unwrap_or(None),
                    mapped_model: row.get(14).unwrap_or(None),
                    protocol: row.get(15).unwrap_or(None),
                    client_ip: row.get(16).unwrap_or(None),
                    username: row.get(17).unwrap_or(None),
                    user_agent: None,
                    session_title: row.get(18).unwrap_or(None),
                })
            })
            .map_err(|e| e.to_string())?;
        logs_iter.filter_map(|r| r.ok()).collect()
    } else if errors_only {
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let logs_iter = stmt
            .query_map([limit, offset], |row| {
                Ok(ProxyRequestLog {
                    id: row.get(0)?,
                    timestamp: row.get(1)?,
                    method: row.get(2)?,
                    url: row.get(3)?,
                    status: row.get(4)?,
                    duration: row.get(5)?,
                    model: row.get(6)?,
                    error: row.get(7)?,
                    request_body: None,
                    response_body: None,
                    input_tokens: row.get(10).unwrap_or(None),
                    output_tokens: row.get(11).unwrap_or(None),
                    cached_tokens: row.get(12).unwrap_or(None),
                    account_email: row.get(13).unwrap_or(None),
                    mapped_model: row.get(14).unwrap_or(None),
                    protocol: row.get(15).unwrap_or(None),
                    client_ip: row.get(16).unwrap_or(None),
                    username: row.get(17).unwrap_or(None),
                    user_agent: None,
                    session_title: row.get(18).unwrap_or(None),
                })
            })
            .map_err(|e| e.to_string())?;
        logs_iter.filter_map(|r| r.ok()).collect()
    } else {
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let logs_iter = stmt
            .query_map(rusqlite::params![limit, offset, filter_pattern], |row| {
                Ok(ProxyRequestLog {
                    id: row.get(0)?,
                    timestamp: row.get(1)?,
                    method: row.get(2)?,
                    url: row.get(3)?,
                    status: row.get(4)?,
                    duration: row.get(5)?,
                    model: row.get(6)?,
                    error: row.get(7)?,
                    request_body: None,
                    response_body: None,
                    input_tokens: row.get(10).unwrap_or(None),
                    output_tokens: row.get(11).unwrap_or(None),
                    cached_tokens: row.get(12).unwrap_or(None),
                    account_email: row.get(13).unwrap_or(None),
                    mapped_model: row.get(14).unwrap_or(None),
                    protocol: row.get(15).unwrap_or(None),
                    client_ip: row.get(16).unwrap_or(None),
                    username: row.get(17).unwrap_or(None),
                    user_agent: None,
                    session_title: row.get(18).unwrap_or(None),
                })
            })
            .map_err(|e| e.to_string())?;
        logs_iter.filter_map(|r| r.ok()).collect()
    };

    Ok(logs)
}

/// Get all logs with full details for export
pub fn get_all_logs_for_export() -> Result<Vec<ProxyRequestLog>, String> {
    let conn = connect_db()?;

    let mut stmt = conn
        .prepare(
            "SELECT id, timestamp, method, url, status, duration, model, error,
                request_body, response_body, input_tokens, output_tokens,
                cached_tokens, account_email, mapped_model, protocol, client_ip, username,
                session_title
         FROM request_logs
         ORDER BY timestamp DESC",
        )
        .map_err(|e| e.to_string())?;

    let logs_iter = stmt
        .query_map([], |row| {
            Ok(ProxyRequestLog {
                id: row.get(0)?,
                timestamp: row.get(1)?,
                method: row.get(2)?,
                url: row.get(3)?,
                status: row.get(4)?,
                duration: row.get(5)?,
                model: row.get(6)?,
                error: row.get(7)?,
                request_body: row.get(8).unwrap_or(None),
                response_body: row.get(9).unwrap_or(None),
                input_tokens: row.get(10).unwrap_or(None),
                output_tokens: row.get(11).unwrap_or(None),
                cached_tokens: row.get(12).unwrap_or(None),
                account_email: row.get(13).unwrap_or(None),
                mapped_model: row.get(14).unwrap_or(None),
                protocol: row.get(15).unwrap_or(None),
                client_ip: row.get(16).unwrap_or(None),
                username: row.get(17).unwrap_or(None),
                user_agent: None,
                session_title: row.get(18).unwrap_or(None),
            })
        })
        .map_err(|e| e.to_string())?;

    let mut logs = Vec::new();
    for log in logs_iter {
        logs.push(log.map_err(|e| e.to_string())?);
    }
    Ok(logs)
}

// ... existing code ...

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct IpTokenStats {
    pub client_ip: String,
    pub total_tokens: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub request_count: i64,
    pub username: Option<String>,
    /// 归属地信息，仅查询响应填充。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub geo: Option<crate::modules::security_db::IpGeoInfo>,
}

/// Get token usage grouped by IP. `hours <= 0` 表示不限制时间范围（全部）。
pub fn get_token_usage_by_ip(limit: usize, hours: i64) -> Result<Vec<IpTokenStats>, String> {
    let conn = connect_db()?;

    // 数据库时间戳为毫秒；hours<=0 时 since=None，SQL 跳过时间过滤
    let since: Option<i64> = if hours > 0 {
        Some(chrono::Utc::now().timestamp_millis() - hours * 3600 * 1000)
    } else {
        None
    };

    // [FIX] 不再从 request_logs 表获取 username，因为该字段可能为空
    // 先获取 IP 统计数据，然后再单独查询每个 IP 的用户名
    let mut stmt = conn
        .prepare(
            "SELECT
            client_ip,
            COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) as total,
            COALESCE(SUM(input_tokens), 0) as input,
            COALESCE(SUM(output_tokens), 0) as output,
            COUNT(*) as cnt
         FROM request_logs
         WHERE (?1 IS NULL OR timestamp >= ?1) AND client_ip IS NOT NULL AND client_ip != ''
         GROUP BY client_ip
         ORDER BY total DESC
         LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![since, limit], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut stats = Vec::new();
    for row in rows {
        let (client_ip, total_tokens, input_tokens, output_tokens, request_count) =
            row.map_err(|e| e.to_string())?;

        // 从 user_token_db 获取该 IP 关联的用户名
        // 这比从 request_logs 获取更可靠，因为 token_ip_bindings 表在每次 User Token 使用时都会更新
        let username =
            crate::modules::user_token_db::get_username_for_ip(&client_ip).unwrap_or(None);

        stats.push(IpTokenStats {
            client_ip,
            total_tokens,
            input_tokens,
            output_tokens,
            request_count,
            username,
            geo: None,
        });
    }

    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_truncate_body_short_stays_unchanged() {
        let s = "short body";
        assert_eq!(truncate_body(s), s);
    }

    #[test]
    fn test_truncate_body_long_keeps_head_and_tail() {
        let mut long = "H".repeat(25 * 1024);
        long.push_str("TAIL_MARKER_用户提问");
        let out = truncate_body(&long);
        assert!(out.len() < long.len());
        assert!(out.contains("[truncated"));
        // 尾部内容必须保留（对话视图依赖尾部抢救用户输入）
        assert!(out.ends_with("TAIL_MARKER_用户提问"));
        // 头部内容必须保留
        assert!(out.starts_with("HHHH"));
        // 重新解析必须成功（UTF-8 边界安全）
        assert!(String::from_utf8(out.into_bytes()).is_ok());
    }

    #[test]
    fn test_truncate_body_reports_inline_image_count() {
        // 超过 IMAGE_BODY_LIMIT 的含图报文仍会截断，marker 必须携带图片数量
        let mut long = "x".repeat(IMAGE_BODY_LIMIT + 25 * 1024);
        long.push_str(r#"{"type":"image_url","image_url":{"url":"data:image/png;base64,AAA"#);
        let out = truncate_body(&long);
        assert!(out.contains("[truncated"), "oversized image body should be truncated");
        assert!(
            out.contains("images=1"),
            "marker should carry image count: {out}"
        );
    }

    #[test]
    fn test_extract_title_from_aggregated_content() {
        // 代理聚合后落库格式：{content: "<自然语言>\n{\"title\":...}", usage:{}}
        let req = "Based on the conversation, generate a short title (max 6 words). Conversation: User: 你好";
        let resp = r#"{"content":"Analyzing the input.\n{\"title\":\"日常问候\",\"category\":\"chat\"}","usage":{}}"#;
        assert_eq!(extract_session_title(req, resp), Some("日常问候".to_string()));
    }

    #[test]
    fn test_extract_title_top_level() {
        let req = "generate a short title please";
        let resp = r#"{"title":"Debug Login Issue","category":"code"}"#;
        assert_eq!(extract_session_title(req, resp), Some("Debug Login Issue".to_string()));
    }

    #[test]
    fn test_extract_title_not_false_positive_on_normal_chat() {
        let req = "帮我写个排序算法";
        let resp = r#"{"choices":[{"message":{"content":"好的，这是快速排序..."}}]}"#;
        assert_eq!(extract_session_title(req, resp), None);
    }

    #[test]
    fn test_truncate_body_keeps_inline_image_intact() {
        // 含内联图片且小于 IMAGE_BODY_LIMIT 的报文必须完整保留，否则对话视图无法显示图片
        let mut body = "prefix".to_string();
        body.push_str(&"A".repeat(100 * 1024));
        body.push_str(r#"{"type":"input_image","image_url":"data:image/jpeg;base64,/9j/AAA"}"#);
        let out = truncate_body(&body);
        assert_eq!(out, body, "image body under limit must not be truncated");
        assert!(out.contains("data:image/jpeg;base64,/9j/AAA"));
    }

    #[test]
    fn test_truncate_body_utf8_boundary_safe() {
        // 中文是多字节 UTF-8，头尾切割点必须落在字符边界，不能切坏字符
        let long = "你".repeat(10 * 1024);
        let out = truncate_body(&long);
        assert!(String::from_utf8(out.clone().into_bytes()).is_ok());
        assert!(out.contains("[truncated"));
    }
}
