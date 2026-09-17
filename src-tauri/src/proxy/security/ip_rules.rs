//! IP 黑白名单内存快照。
//!
//! 名单数据量小（通常几十条），启动时全量加载到内存，增删改后由命令层调用
//! [`IpRuleSet::load`] 重新装载并原子替换，使代理热路径的 IP 判定零磁盘 IO。

use crate::modules::security_db::{get_blacklist, get_whitelist, IpBlacklistEntry};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::modules::ip_util::{self, IpNetwork};

/// 不可变的名单快照；替换整体走 `Arc` 原子换入。
#[derive(Debug, Default)]
pub struct IpRuleSet {
    black_exact: HashMap<String, Arc<IpBlacklistEntry>>,
    black_cidr: Vec<(IpNetwork, Arc<IpBlacklistEntry>)>,
    white_exact: HashSet<String>,
    white_cidr: Vec<IpNetwork>,
}

impl IpRuleSet {
    /// 从安全库装载当前有效名单（过期黑名单与非法规则自动剔除）。
    pub fn load() -> Result<Self, String> {
        let now = chrono::Utc::now().timestamp();
        let mut ruleset = IpRuleSet::default();

        for entry in get_blacklist()? {
            if entry.expires_at.is_some_and(|expires| expires < now) {
                continue;
            }
            ruleset.add_black(Arc::new(entry));
        }

        for entry in get_whitelist()? {
            ruleset.add_white(entry.ip_pattern.trim());
        }

        Ok(ruleset)
    }

    fn add_black(&mut self, entry: Arc<IpBlacklistEntry>) {
        let pattern = entry.ip_pattern.trim();
        if pattern.contains('/') {
            if let Some(network) = IpNetwork::parse(pattern) {
                self.black_cidr.push((network, entry));
            }
        } else if let Some(key) = ip_util::normalize_pattern(pattern) {
            self.black_exact.insert(key, entry);
        }
    }

    fn add_white(&mut self, pattern: &str) {
        if pattern.contains('/') {
            if let Some(network) = IpNetwork::parse(pattern) {
                self.white_cidr.push(network);
            }
        } else if let Some(key) = ip_util::normalize_pattern(pattern) {
            self.white_exact.insert(key);
        }
    }

    /// 匹配黑名单；已过期或无法解析的规则不命中。
    pub fn match_blacklist(&self, ip: &str) -> Option<Arc<IpBlacklistEntry>> {
        let now = chrono::Utc::now().timestamp();
        let normalized = ip_util::display_ip(ip);

        if let Some(entry) = self.black_exact.get(&normalized) {
            if !is_expired(entry, now) {
                return Some(Arc::clone(entry));
            }
        }

        let addr = ip_util::parse_client_ip(ip)?;
        self.black_cidr
            .iter()
            .find(|(network, entry)| network.contains_ip(&addr) && !is_expired(entry, now))
            .map(|(_, entry)| Arc::clone(entry))
    }

    /// 判断 IP 是否在白名单。
    pub fn is_whitelisted(&self, ip: &str) -> bool {
        let normalized = ip_util::display_ip(ip);
        if self.white_exact.contains(&normalized) {
            return true;
        }
        match ip_util::parse_client_ip(ip) {
            Some(addr) => self
                .white_cidr
                .iter()
                .any(|network| network.contains_ip(&addr)),
            None => false,
        }
    }
}

fn is_expired(entry: &IpBlacklistEntry, now: i64) -> bool {
    entry.expires_at.is_some_and(|expires| expires < now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::security_db::IpWhitelistEntry;

    fn black_entry(pattern: &str, expires_at: Option<i64>) -> Arc<IpBlacklistEntry> {
        Arc::new(IpBlacklistEntry {
            id: uuid::Uuid::new_v4().to_string(),
            ip_pattern: pattern.to_string(),
            reason: None,
            created_at: 0,
            expires_at,
            created_by: "test".to_string(),
            hit_count: 0,
        })
    }

    fn white_entry(pattern: &str) -> IpWhitelistEntry {
        IpWhitelistEntry {
            id: uuid::Uuid::new_v4().to_string(),
            ip_pattern: pattern.to_string(),
            description: None,
            created_at: 0,
        }
    }

    #[test]
    fn matches_exact_and_cidr_in_memory() {
        let mut rules = IpRuleSet::default();
        // 通过 load 路径外的内部构造不可用，直接用公开装载结果验证逻辑：
        // 这里借助 DB 无关的白/黑名单结构与 add 路径一致的匹配函数。
        let _ = white_entry("10.0.0.1");

        let exact = black_entry("1.2.3.4", None);
        rules.add_black(exact);
        let cidr = black_entry("192.168.0.0/16", None);
        rules.add_black(cidr);

        assert!(rules.match_blacklist("1.2.3.4").is_some());
        assert!(rules.match_blacklist("192.168.50.1").is_some());
        assert!(rules.match_blacklist("8.8.8.8").is_none());
    }

    #[test]
    fn expired_entries_do_not_match() {
        let mut rules = IpRuleSet::default();
        rules.add_black(black_entry("5.6.7.8", Some(1)));
        assert!(rules.match_blacklist("5.6.7.8").is_none());
    }

    #[test]
    fn whitelist_exact_and_cidr() {
        let mut rules = IpRuleSet::default();
        rules.add_white("127.0.0.1");
        rules.add_white("10.0.0.0/8");
        assert!(rules.is_whitelisted("127.0.0.1"));
        assert!(rules.is_whitelisted("10.99.0.1"));
        assert!(!rules.is_whitelisted("8.8.4.4"));
    }

    #[test]
    fn invalid_rules_are_skipped() {
        let mut rules = IpRuleSet::default();
        rules.add_black(black_entry("not-an-ip", None));
        rules.add_white("garbage");
        assert!(rules.match_blacklist("not-an-ip").is_none());
        assert!(!rules.is_whitelisted("garbage"));
    }
}
