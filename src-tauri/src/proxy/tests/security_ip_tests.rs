//! IP Security Module Tests
//! IP 安全监控功能的综合测试套件
//!
//! 测试目标:
//! 1. 验证 IP 黑/白名单功能的正确性
//! 2. 验证 CIDR 匹配逻辑
//! 3. 验证过期时间处理
//! 4. 验证不影响主流程性能
//! 5. 验证数据库操作的原子性和一致性

#[cfg(test)]
mod security_db_tests {
    use crate::modules::security_db::{
        add_to_blacklist, add_to_whitelist, cleanup_old_ip_logs, clear_ip_access_logs,
        get_blacklist, get_ip_access_logs, get_ip_access_logs_count, get_ip_stats, get_whitelist,
        increment_blacklist_hit, init_db, is_ip_in_blacklist, is_ip_in_whitelist,
        remove_from_blacklist, remove_from_whitelist, save_ip_access_log, IpAccessLog,
    };
    use std::time::{SystemTime, UNIX_EPOCH};

    /// 辅助函数：获取当前时间戳
    fn now_timestamp() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    /// 辅助函数：清理测试环境
    fn cleanup_test_data() {
        // 清理黑名单
        if let Ok(entries) = get_blacklist() {
            for entry in entries {
                let _ = remove_from_blacklist(&entry.id);
            }
        }
        // 清理白名单
        if let Ok(entries) = get_whitelist() {
            for entry in entries {
                let _ = remove_from_whitelist(&entry.id);
            }
        }
        // 清理访问日志
        let _ = clear_ip_access_logs();
    }

    // ============================================================================
    // 测试类别 1: 数据库初始化
    // ============================================================================

    #[test]
    fn test_db_initialization() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        // 验证数据库初始化不会 panic
        let result = init_db();
        assert!(
            result.is_ok(),
            "Database initialization should succeed: {:?}",
            result.err()
        );
    }

    #[test]
    fn test_db_multiple_initializations() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        // 验证多次初始化不会出错 (幂等性)
        for _ in 0..3 {
            let result = init_db();
            assert!(
                result.is_ok(),
                "Multiple DB initializations should be idempotent"
            );
        }
    }

    // ============================================================================
    // 测试类别 2: IP 黑名单基本操作
    // ============================================================================

    #[test]
    fn test_blacklist_add_and_check() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        // 添加 IP 到黑名单
        let result = add_to_blacklist("192.168.1.100", Some("Test block"), None, "test");
        assert!(
            result.is_ok(),
            "Should add IP to blacklist: {:?}",
            result.err()
        );

        // 验证 IP 在黑名单中
        let is_blocked = is_ip_in_blacklist("192.168.1.100");
        assert!(is_blocked.is_ok());
        assert!(is_blocked.unwrap(), "IP should be in blacklist");

        // 验证其他 IP 不在黑名单中
        let is_other_blocked = is_ip_in_blacklist("192.168.1.101");
        assert!(is_other_blocked.is_ok());
        assert!(
            !is_other_blocked.unwrap(),
            "Other IP should not be in blacklist"
        );

        cleanup_test_data();
    }

    #[test]
    fn test_blacklist_remove() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        // 添加 IP
        let entry = add_to_blacklist("10.0.0.5", Some("Temp block"), None, "test").unwrap();

        // 验证存在
        assert!(is_ip_in_blacklist("10.0.0.5").unwrap());

        // 移除
        let remove_result = remove_from_blacklist(&entry.id);
        assert!(remove_result.is_ok());

        // 验证已移除
        assert!(!is_ip_in_blacklist("10.0.0.5").unwrap());

        cleanup_test_data();
    }

    #[test]
    fn test_blacklist_get_entry_details() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        // 添加带有详细信息的条目
        let _ = add_to_blacklist(
            "172.16.0.50",
            Some("Abuse detected"),
            Some(now_timestamp() + 3600), // 1小时后过期
            "admin",
        );

        // 获取条目详情（走内存快照，与中间件判定路径一致）
        let rules = crate::proxy::security::ip_rules::IpRuleSet::load().unwrap();
        let entry = rules
            .match_blacklist("172.16.0.50")
            .expect("entry should be matched by snapshot");
        assert_eq!(entry.ip_pattern, "172.16.0.50");
        assert_eq!(entry.reason.as_deref(), Some("Abuse detected"));
        assert_eq!(entry.created_by, "admin");
        assert!(entry.expires_at.is_some());

        cleanup_test_data();
    }

    // ============================================================================
    // 测试类别 3: CIDR 匹配
    // ============================================================================

    #[test]
    fn test_cidr_matching_basic() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        // 添加 CIDR 范围到黑名单
        let _ = add_to_blacklist("192.168.1.0/24", Some("Block subnet"), None, "test");

        // 验证该子网内的 IP 都被阻止
        assert!(
            is_ip_in_blacklist("192.168.1.1").unwrap(),
            "192.168.1.1 should match /24"
        );
        assert!(
            is_ip_in_blacklist("192.168.1.100").unwrap(),
            "192.168.1.100 should match /24"
        );
        assert!(
            is_ip_in_blacklist("192.168.1.254").unwrap(),
            "192.168.1.254 should match /24"
        );

        // 验证子网外的 IP 不被阻止
        assert!(
            !is_ip_in_blacklist("192.168.2.1").unwrap(),
            "192.168.2.1 should not match"
        );
        assert!(
            !is_ip_in_blacklist("10.0.0.1").unwrap(),
            "10.0.0.1 should not match"
        );

        cleanup_test_data();
    }

    #[test]
    fn test_cidr_matching_various_masks() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        // 测试 /16 掩码
        let _ = add_to_blacklist("10.10.0.0/16", Some("Block /16"), None, "test");

        assert!(is_ip_in_blacklist("10.10.0.1").unwrap(), "Should match /16");
        assert!(
            is_ip_in_blacklist("10.10.255.255").unwrap(),
            "Should match /16"
        );
        assert!(
            !is_ip_in_blacklist("10.11.0.1").unwrap(),
            "Should not match /16"
        );

        cleanup_test_data();

        // 测试 /32 掩码 (单个 IP)
        let _ = add_to_blacklist("8.8.8.8/32", Some("Block single"), None, "test");

        assert!(is_ip_in_blacklist("8.8.8.8").unwrap(), "Should match /32");
        assert!(
            !is_ip_in_blacklist("8.8.8.9").unwrap(),
            "Should not match /32"
        );

        cleanup_test_data();
    }

    #[test]
    fn test_cidr_edge_cases() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        // 测试 /0 (所有 IP) - 边界情况
        let _ = add_to_blacklist("0.0.0.0/0", Some("Block all"), None, "test");

        assert!(
            is_ip_in_blacklist("1.2.3.4").unwrap(),
            "Everything should match /0"
        );
        assert!(
            is_ip_in_blacklist("255.255.255.255").unwrap(),
            "Everything should match /0"
        );

        cleanup_test_data();

        // 测试 /8 掩码
        let _ = add_to_blacklist("10.0.0.0/8", Some("Block /8"), None, "test");

        assert!(
            is_ip_in_blacklist("10.255.255.255").unwrap(),
            "Should match /8"
        );
        assert!(
            !is_ip_in_blacklist("11.0.0.0").unwrap(),
            "Should not match /8"
        );

        cleanup_test_data();
    }

    // ============================================================================
    // 测试类别 4: 过期时间处理
    // ============================================================================

    #[test]
    fn test_blacklist_expiration() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        // 添加一个已过期的条目
        let _ = add_to_blacklist(
            "203.0.113.82",
            Some("Already expired"),
            Some(now_timestamp() - 60), // 1分钟前过期
            "test",
        );

        // 快照匹配跳过已过期规则
        let is_blocked = is_ip_in_blacklist("203.0.113.82");
        assert!(!is_blocked.unwrap(), "Expired entry should be cleaned up");

        cleanup_test_data();
    }

    #[test]
    fn test_blacklist_not_yet_expired() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        // 添加一个未过期的条目
        let _ = add_to_blacklist(
            "203.0.113.80",
            Some("Will expire later"),
            Some(now_timestamp() + 3600), // 1小时后过期
            "test",
        );

        // 未过期条目应该仍然生效
        assert!(is_ip_in_blacklist("203.0.113.80").unwrap());

        cleanup_test_data();
    }

    #[test]
    fn test_permanent_blacklist() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        // 添加永久封禁 (无过期时间)
        let _ = add_to_blacklist(
            "203.0.113.81",
            Some("Permanent ban"),
            None, // 无过期时间
            "test",
        );

        // 永久封禁应该始终生效
        assert!(is_ip_in_blacklist("203.0.113.81").unwrap());

        cleanup_test_data();
    }

    // ============================================================================
    // 测试类别 5: IP 白名单
    // ============================================================================

    #[test]
    fn test_whitelist_add_and_check() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        // 添加 IP 到白名单
        let result = add_to_whitelist("10.0.0.1", Some("Trusted server"));
        assert!(result.is_ok());

        // 验证 IP 在白名单中
        assert!(is_ip_in_whitelist("10.0.0.1").unwrap());
        assert!(!is_ip_in_whitelist("10.0.0.2").unwrap());

        cleanup_test_data();
    }

    #[test]
    fn test_whitelist_cidr() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        // 添加 CIDR 范围到白名单
        let _ = add_to_whitelist("192.168.0.0/16", Some("Internal network"));

        // 验证子网内的 IP 都被允许
        assert!(is_ip_in_whitelist("192.168.1.1").unwrap());
        assert!(is_ip_in_whitelist("192.168.255.255").unwrap());

        // 验证子网外的 IP 不在白名单
        assert!(!is_ip_in_whitelist("10.0.0.1").unwrap());

        cleanup_test_data();
    }

    // ============================================================================
    // 测试类别 6: IP 访问日志
    // ============================================================================

    #[test]
    fn test_access_log_save_and_retrieve() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        // 保存访问日志
        let log = IpAccessLog {
            id: uuid::Uuid::new_v4().to_string(),
            client_ip: "test.log.ip".to_string(),
            timestamp: now_timestamp(),
            method: Some("POST".to_string()),
            path: Some("/v1/messages".to_string()),
            user_agent: Some("TestClient/1.0".to_string()),
            status: Some(200),
            duration: Some(150),
            api_key_hash: Some("hash123".to_string()),
            blocked: false,
            block_reason: None,
            username: None,
            geo: None,
        };

        let save_result = save_ip_access_log(&log);
        assert!(
            save_result.is_ok(),
            "Should save access log: {:?}",
            save_result.err()
        );

        // 检索日志
        let logs = get_ip_access_logs(10, 0, Some("test.log.ip"), false);
        assert!(logs.is_ok());

        let logs = logs.unwrap();
        assert!(!logs.is_empty(), "Should retrieve saved log");
        assert_eq!(logs[0].client_ip, "test.log.ip");

        cleanup_test_data();
    }

    #[test]
    fn test_access_log_blocked_filter() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        // 保存正常日志
        let normal_log = IpAccessLog {
            id: uuid::Uuid::new_v4().to_string(),
            client_ip: "normal.access.ip".to_string(),
            timestamp: now_timestamp(),
            method: Some("GET".to_string()),
            path: Some("/healthz".to_string()),
            user_agent: None,
            session_title: None,
            status: Some(200),
            duration: Some(10),
            api_key_hash: None,
            blocked: false,
            block_reason: None,
            username: None,
            geo: None,
        };
        let _ = save_ip_access_log(&normal_log);

        // 保存被阻止的日志
        let blocked_log = IpAccessLog {
            id: uuid::Uuid::new_v4().to_string(),
            client_ip: "blocked.access.ip".to_string(),
            timestamp: now_timestamp(),
            method: Some("POST".to_string()),
            path: Some("/v1/messages".to_string()),
            user_agent: None,
            session_title: None,
            status: Some(403),
            duration: Some(0),
            api_key_hash: None,
            blocked: true,
            block_reason: Some("IP in blacklist".to_string()),
            username: None,
            geo: None,
        };
        let _ = save_ip_access_log(&blocked_log);

        // 只检索被阻止的日志
        let blocked_only = get_ip_access_logs(10, 0, None, true).unwrap();
        assert_eq!(blocked_only.len(), 1);
        assert_eq!(blocked_only[0].client_ip, "blocked.access.ip");
        assert!(blocked_only[0].blocked);

        cleanup_test_data();
    }

    #[test]
    fn test_access_log_filter_treats_sql_syntax_as_plain_text() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        for client_ip in ["filter.safe.ip", "filter.other.ip"] {
            let log = IpAccessLog {
                id: uuid::Uuid::new_v4().to_string(),
                client_ip: client_ip.to_string(),
                timestamp: now_timestamp(),
                method: Some("GET".to_string()),
                path: Some("/healthz".to_string()),
                user_agent: None,
                session_title: None,
                status: Some(200),
                duration: Some(10),
                api_key_hash: None,
                blocked: false,
                block_reason: None,
                username: None,
                geo: None,
            };
            save_ip_access_log(&log).unwrap();
        }

        let injection = "' OR 1=1 --";
        assert!(get_ip_access_logs(10, 0, Some(injection), false)
            .unwrap()
            .is_empty());
        assert_eq!(get_ip_access_logs_count(Some(injection), false).unwrap(), 0);

        cleanup_test_data();
    }

    /// LIKE 通配符（%、_、\）必须被转义为字面量，否则搜索 "50%" 会匹配到 "50X..."。
    #[test]
    fn test_access_log_search_escapes_like_wildcards() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        let cases: &[(&str, &str)] = &[
            ("203.0.113.10", "/promo/50%off"),
            ("203.0.113.11", "/promo/50Xoff"), // % 的干扰项
            ("203.0.113.12", "/labels/a_b"),
            ("203.0.113.13", "/labels/aXb"), // _ 的干扰项
            ("203.0.113.14", r"/path/with\slash"),
        ];
        for (ip, path) in cases {
            let log = IpAccessLog {
                id: uuid::Uuid::new_v4().to_string(),
                client_ip: ip.to_string(),
                timestamp: now_timestamp(),
                method: Some("GET".to_string()),
                path: Some(path.to_string()),
                user_agent: None,
                session_title: None,
                status: Some(200),
                duration: Some(10),
                api_key_hash: None,
                blocked: false,
                block_reason: None,
                username: None,
                geo: None,
            };
            save_ip_access_log(&log).unwrap();
        }

        // "%" 被当作字面百分号：只命中 50%off，不命中 50Xoff
        assert_eq!(get_ip_access_logs_count(Some("50%"), false).unwrap(), 1);
        // "_" 被当作字面下划线：只命中 a_b，不命中 aXb
        assert_eq!(get_ip_access_logs_count(Some("a_b"), false).unwrap(), 1);
        // "\" 被当作字面反斜杠
        assert_eq!(
            get_ip_access_logs_count(Some(r"with\slash"), false).unwrap(),
            1
        );
        // 空字符串与 None 同口径：返回全量
        assert_eq!(get_ip_access_logs_count(Some(""), false).unwrap(), 5);
        assert_eq!(
            get_ip_access_logs(10, 0, Some("  "), false).unwrap().len(),
            5
        );

        cleanup_test_data();
    }

    /// 空表统计必须经 COALESCE 返回 0 而不是 rusqlite 报错（P1 崩溃回归）。
    #[test]
    fn test_ip_stats_empty_table_returns_zero() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        for window in [None, Some(1), Some(24), Some(0)] {
            let stats = get_ip_stats(window).expect("empty table must not error");
            assert_eq!(stats.total_requests, 0, "window={window:?}");
            assert_eq!(stats.unique_ips, 0, "window={window:?}");
            assert_eq!(stats.blocked_count, 0, "window={window:?}");
        }

        cleanup_test_data();
    }

    /// IPv6 CIDR 端到端：写入名单后内存快照按网段命中。
    #[test]
    fn test_ipv6_cidr_blacklist_end_to_end() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        add_to_blacklist("240e:1234::/32", Some("v6 range"), None, "test").unwrap();

        assert!(is_ip_in_blacklist("240e:1234:dead::1").unwrap());
        assert!(is_ip_in_blacklist("240e:1234:ffff::beef").unwrap());
        assert!(!is_ip_in_blacklist("240e:1235::1").unwrap());
        assert!(!is_ip_in_blacklist("8.8.8.8").unwrap());

        cleanup_test_data();
    }

    /// IPv4-mapped IPv6（::ffff:1.2.3.4）必须归约到对应 v4 名单，防止混淆绕过。
    #[test]
    fn test_v4_mapped_ipv6_matches_v4_rules() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        add_to_blacklist("8.8.8.8", Some("mapped black"), None, "test").unwrap();
        add_to_whitelist("9.9.9.9", Some("mapped white")).unwrap();

        assert!(is_ip_in_blacklist("::ffff:8.8.8.8").unwrap());
        assert!(is_ip_in_whitelist("::ffff:9.9.9.9").unwrap());
        assert!(!is_ip_in_blacklist("::ffff:8.8.4.4").unwrap());

        cleanup_test_data();
    }

    // ============================================================================
    // 测试类别 7: 统计功能
    // ============================================================================

    #[test]
    fn test_ip_stats() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        // 添加一些测试数据
        for i in 0..5 {
            let log = IpAccessLog {
                id: uuid::Uuid::new_v4().to_string(),
                client_ip: format!("stats.test.{}", i % 3), // 3 个唯一 IP
                timestamp: now_timestamp(),
                method: Some("POST".to_string()),
                path: Some("/v1/messages".to_string()),
                user_agent: None,
                session_title: None,
                status: Some(200),
                duration: Some(100),
                api_key_hash: None,
                blocked: i == 4, // 最后一个被阻止
                block_reason: if i == 4 {
                    Some("Test".to_string())
                } else {
                    None
                },
                username: None,
                geo: None,
            };
            let _ = save_ip_access_log(&log);
        }

        // 添加黑名单和白名单条目
        let _ = add_to_blacklist("203.0.113.41", None, None, "test");
        let _ = add_to_blacklist("203.0.113.42", None, None, "test");
        let _ = add_to_whitelist("203.0.113.43", None);

        // 获取统计
        let stats = get_ip_stats(None);
        assert!(stats.is_ok());

        let stats = stats.unwrap();
        assert!(stats.total_requests >= 5, "Should have at least 5 requests");
        assert!(stats.unique_ips >= 3, "Should have at least 3 unique IPs");
        assert!(
            stats.blocked_count >= 1,
            "Should have at least 1 blocked request"
        );
        assert_eq!(stats.blacklist_count, 2);
        assert_eq!(stats.whitelist_count, 1);

        cleanup_test_data();
    }

    // ============================================================================
    // 测试类别 8: 清理功能
    // ============================================================================

    #[test]
    fn test_cleanup_old_logs() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        // 添加一条 "旧" 日志 (模拟 2 天前)
        let old_log = IpAccessLog {
            id: uuid::Uuid::new_v4().to_string(),
            client_ip: "old.log.ip".to_string(),
            timestamp: now_timestamp() - (2 * 24 * 3600), // 2 天前
            method: Some("GET".to_string()),
            path: Some("/old".to_string()),
            user_agent: None,
            session_title: None,
            status: Some(200),
            duration: Some(10),
            api_key_hash: None,
            blocked: false,
            block_reason: None,
            username: None,
            geo: None,
        };
        let _ = save_ip_access_log(&old_log);

        // 添加一条新日志
        let new_log = IpAccessLog {
            id: uuid::Uuid::new_v4().to_string(),
            client_ip: "new.log.ip".to_string(),
            timestamp: now_timestamp(),
            method: Some("GET".to_string()),
            path: Some("/new".to_string()),
            user_agent: None,
            session_title: None,
            status: Some(200),
            duration: Some(10),
            api_key_hash: None,
            blocked: false,
            block_reason: None,
            username: None,
            geo: None,
        };
        let _ = save_ip_access_log(&new_log);

        // 清理 1 天前的日志
        let deleted = cleanup_old_ip_logs(1);
        assert!(deleted.is_ok());
        assert!(deleted.unwrap() >= 1, "Should delete at least 1 old log");

        // 验证新日志仍然存在
        let logs = get_ip_access_logs(10, 0, Some("new.log.ip"), false).unwrap();
        assert!(!logs.is_empty(), "New log should still exist");

        // 验证旧日志已被清理
        let old_logs = get_ip_access_logs(10, 0, Some("old.log.ip"), false).unwrap();
        assert!(old_logs.is_empty(), "Old log should be cleaned up");

        cleanup_test_data();
    }

    // ============================================================================
    // 测试类别 9: 并发安全性
    // ============================================================================

    #[test]
    fn test_concurrent_access() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        use std::thread;

        let _ = init_db();
        cleanup_test_data();

        let handles: Vec<_> = (0..10)
            .map(|i| {
                thread::spawn(move || {
                    // 每个线程添加不同的 IP
                    let ip = format!("10.40.0.{}", i + 1);
                    let _ = add_to_blacklist(&ip, Some("Concurrent test"), None, "test");

                    // 验证自己添加的 IP
                    is_ip_in_blacklist(&ip).unwrap_or(false)
                })
            })
            .collect();

        let results: Vec<bool> = handles.into_iter().map(|h| h.join().unwrap()).collect();

        // 所有线程都应该成功
        assert!(
            results.iter().all(|&r| r),
            "All concurrent adds should succeed"
        );

        cleanup_test_data();
    }

    // ============================================================================
    // 测试类别 10: 边界情况和错误处理
    // ============================================================================

    #[test]
    fn test_duplicate_blacklist_entry() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        // 第一次添加应该成功
        let result1 = add_to_blacklist("203.0.113.10", Some("First"), None, "test");
        assert!(result1.is_ok());

        // 第二次添加相同 IP 应该失败 (UNIQUE constraint)
        let result2 = add_to_blacklist("203.0.113.10", Some("Second"), None, "test");
        assert!(result2.is_err(), "Duplicate IP should fail");

        cleanup_test_data();
    }

    #[test]
    fn test_empty_ip_pattern() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        // 空 IP 模式应该仍然可以添加 (取决于业务需求)
        // 这里只测试不会 panic
        let result = add_to_blacklist("", Some("Empty IP"), None, "test");
        // 结果可能成功或失败，但不应该 panic
        let _ = result;

        cleanup_test_data();
    }

    #[test]
    fn test_special_characters_in_reason() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        // 测试包含特殊字符的原因
        let reason = "Test with 'quotes' and \"double quotes\" and emoji 🚫";
        let result = add_to_blacklist("203.0.113.20", Some(reason), None, "test");
        assert!(result.is_ok());

        let rules = crate::proxy::security::ip_rules::IpRuleSet::load().unwrap();
        let entry = rules
            .match_blacklist("203.0.113.20")
            .expect("entry should be matched by snapshot");
        assert_eq!(entry.reason.as_deref(), Some(reason));

        cleanup_test_data();
    }

    #[test]
    fn test_hit_count_increment() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();
        cleanup_test_data();

        // 添加一个黑名单条目
        let _ = add_to_blacklist("203.0.113.30", Some("Count test"), None, "test");

        // 拦截命中时递增计数
        let blacklist = get_blacklist().unwrap();
        let entry = blacklist
            .iter()
            .find(|e| e.ip_pattern == "203.0.113.30")
            .expect("entry should exist");
        for _ in 0..5 {
            increment_blacklist_hit(&entry.id).unwrap();
        }

        // 检查 hit_count
        let blacklist = get_blacklist().unwrap();
        let entry = blacklist
            .iter()
            .find(|e| e.ip_pattern == "203.0.113.30")
            .expect("entry should exist");
        assert!(
            entry.hit_count >= 5,
            "Hit count should be at least 5, got {}",
            entry.hit_count
        );

        cleanup_test_data();
    }
}

// ============================================================================
// IP Filter 中间件测试 (单元测试)
// ============================================================================

#[cfg(test)]
mod ip_filter_middleware_tests {
    // 注意：中间件测试需要模拟 HTTP 请求，这里提供测试框架
    // 实际的集成测试应该在启动完整服务后进行

    /// 直连模式必须忽略可伪造的 X-Forwarded-For，只认 TCP 对端；
    /// 显式代理模式才采信代理头（修复 P0 绕过漏洞的回归测试）。
    #[test]
    fn test_direct_mode_ignores_spoofed_xff() {
        use crate::modules::ip_util::{pick_client_ip, TrustMode};
        use axum::http::HeaderMap;
        use std::net::SocketAddr;

        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            "203.0.113.9, 198.51.100.2".parse().unwrap(),
        );
        let peer: SocketAddr = "192.168.1.10:54321".parse().unwrap();

        let direct = pick_client_ip(&headers, Some(peer.ip()), TrustMode::Direct)
            .expect("peer IP must be used");
        assert_eq!(direct, "192.168.1.10");

        // 一层可信代理：XFF 最右一跳由紧邻代理写入（攻击者真实地址），
        // 左侧 203.0.113.9 是攻击者可伪造的内容，必须取最右。
        let proxied = pick_client_ip(&headers, Some(peer.ip()), TrustMode::ProxyHops(1))
            .expect("XFF must be used in proxy mode");
        assert_eq!(proxied, "198.51.100.2");
    }
}

// ============================================================================
// 性能基准测试
// ============================================================================

#[cfg(test)]
mod performance_benchmarks {
    use crate::modules::security_db::{
        add_to_blacklist, get_blacklist, init_db, is_ip_in_blacklist,
    };
    use std::time::Instant;

    /// 基准测试：黑名单查找性能
    #[test]
    fn benchmark_blacklist_lookup() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();

        // 清理并添加 100 个黑名单条目
        if let Ok(entries) = get_blacklist() {
            for entry in entries {
                let _ = crate::modules::security_db::remove_from_blacklist(&entry.id);
            }
        }

        for i in 0..100 {
            let _ = add_to_blacklist(&format!("203.0.113.{i}"), Some("Benchmark"), None, "test");
        }

        // 执行 1000 次查找（每次 load 快照，模拟命令层判定路径）
        let start = Instant::now();
        for _ in 0..1000 {
            let _ = is_ip_in_blacklist("203.0.113.50");
        }
        let duration = start.elapsed();

        println!("1000 blacklist lookups took: {:?}", duration);
        println!("Average per lookup: {:?}", duration / 1000);

        // 性能断言：1000 次命令层判定（每次含快照装载查库）总时长 < 5s。
        // 注意这不是代理热路径；热路径走 Arc 内存快照，见 ip_filter 中间件。
        assert!(
            duration.as_millis() < 5000,
            "1000 snapshot lookups should finish within 5s, took {duration:?}"
        );

        // 清理
        if let Ok(entries) = get_blacklist() {
            for entry in entries {
                let _ = crate::modules::security_db::remove_from_blacklist(&entry.id);
            }
        }
    }

    /// 基准测试：CIDR 匹配性能
    #[test]
    fn benchmark_cidr_matching() {
        let _test_lock = crate::modules::security_db::lock_security_test();
        let _ = init_db();

        // 清理并添加 CIDR 规则
        if let Ok(entries) = get_blacklist() {
            for entry in entries {
                let _ = crate::modules::security_db::remove_from_blacklist(&entry.id);
            }
        }

        // 添加 20 个 CIDR 规则
        for i in 0..20 {
            let _ = add_to_blacklist(
                &format!("10.{}.0.0/16", i),
                Some("CIDR Benchmark"),
                None,
                "test",
            );
        }

        // 测试 CIDR 匹配性能
        let start = Instant::now();
        for _ in 0..1000 {
            // 测试需要遍历 CIDR 的 IP
            let _ = is_ip_in_blacklist("10.5.100.50");
        }
        let duration = start.elapsed();

        println!("1000 CIDR matches took: {:?}", duration);
        println!("Average per match: {:?}", duration / 1000);

        // 性能断言：CIDR 匹配应该在合理时间内
        assert!(
            duration.as_millis() < 5000,
            "CIDR matching should be reasonably fast"
        );

        // 清理
        if let Ok(entries) = get_blacklist() {
            for entry in entries {
                let _ = crate::modules::security_db::remove_from_blacklist(&entry.id);
            }
        }
    }
}
