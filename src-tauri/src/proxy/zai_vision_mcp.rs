use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Default)]
pub struct ZaiVisionMcpState {
    sessions: Arc<Mutex<HashMap<String, ZaiVisionSession>>>,
}

#[derive(Debug, Clone)]
struct ZaiVisionSession {
    created_at: std::time::Instant,
}

/// 会话最长存活时间：客户端未显式 DELETE（崩溃/断连）时，在新建会话时顺带淘汰，避免 HashMap 无界泄漏。
const ZAI_VISION_SESSION_TTL: std::time::Duration = std::time::Duration::from_secs(60 * 60);

impl ZaiVisionMcpState {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn create_session(&self) -> String {
        let session_id = uuid::Uuid::new_v4().to_string();
        let mut sessions = self.sessions.lock().await;
        // [FIX] 顺带淘汰超过 TTL 未被显式关闭的陈旧会话，防止断连后 session 永久残留
        sessions.retain(|_, s| s.created_at.elapsed() < ZAI_VISION_SESSION_TTL);
        sessions.insert(
            session_id.clone(),
            ZaiVisionSession {
                created_at: std::time::Instant::now(),
            },
        );
        session_id
    }

    pub async fn has_session(&self, session_id: &str) -> bool {
        let sessions = self.sessions.lock().await;
        sessions.contains_key(session_id)
    }

    pub async fn remove_session(&self, session_id: &str) {
        let mut sessions = self.sessions.lock().await;
        sessions.remove(session_id);
    }
}
