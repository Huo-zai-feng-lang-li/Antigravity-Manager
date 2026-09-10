# 最新接续状态 (2026-09-10 12:29)

## 核心进展
- **v4.6.20 已发布**（commit 92f556ae + fmt 修复 05999873，CI success，Release 5 assets 已发布）：token_stats 无限增长清理（de80afdb 含单测 4/4）、保存设置双 tip 改单 tip（78387094）、移除误导性自定义域名字段（eece25e9）、CF 隧道反代启动后自动拉起 + 黑窗口修复（ea680e45）、user_token_db 并发写 SQLITE_BUSY（5b639cbd）、退出端口释放（c4974917 v4.6.19）。

## 核心动机与背景 (Motivation & Background)
- 用户 fork 自 lbjlaq/Antigravity-Manager 的单机反代网关（8045 端口），34 个 Google 账号轮换 + socks5h://127.0.0.1:51081 VPN 出口，长期运行稳定性是核心诉求。
- 已知审计结论：代理配置保存后是**热生效**（save_config → update_proxy rebuild_default_client + clear_client_cache，无需重启）；命名隧道 URL 从 cloudflared 日志解析 hostname（extract_tunnel_url），custom_domain 仅影响 initial_url 显示。
- 代理池分配：账号绑定（account_bindings 持久化）优先 → 未绑定按策略轮询（每请求独立选）→ 回退全局上游 → 直连。绑定的代理自动从公用池剔除（专属隔离）。

## 关键设计与实现 (Implementation & Decisions)
- **token_stats 清理**：`token_stats.rs::cleanup_old_records(days)`（含 in_connection 版供测试），monitor.rs 每 6h 维护任务接入，保留 30 天（前端最大查 7 天）。实证：token_usage 曾有 21831 行零清理（2026-01-22~09-09）。
- **CF 自动启动**（commands/proxy.rs internal_start_proxy_service）：反代就绪后若 app_config.cloudflared.enabled && !is_process_running() && installed 则 start(cf_cfg)，失败仅 warn 不阻断。外层 manager 读锁跨 start().await 无死锁（start 只碰内部 process/status 锁）。
- **双 tip → 单 tip**：Settings.tsx handleSave 删除条件 showToast(restart_hint)（该提示实为误导，热生效）。
- **自定义域名移除**：ApiProxy.tsx 删除输入框 UI + cfCustomDomain state，启动/持久化时用 appConfig.cloudflared.custom_domain 原值（保留 URL 显示不回归）。
- **版本 bump 必须用 python**（Temp/bump_4620.py 风格 io.open utf-8 newline=''），**绝不用 PowerShell Set-Content**（会加 BOM 导致 CI 红）。

## 待办事项 (Next Steps)
- [ ] 用户安装 v4.6.20 后按需回归：隧道自动启动、端口释放、Token 统计 Tab 切换
- [ ] 若发现新 bug：先扫描全部调用链路再改，走一步验证一步，cargo fmt 后再提交（**commit 前必跑 cargo fmt --check**，CI 的 Check Rust formatting 会失败）

## 关键上下文
- 目录: `D:\Desktop\Super-File\AI-IDE\AI\反重力\Antigravity-Manager`
- 主要文件: `src-tauri/src/modules/token_stats.rs`、`src-tauri/src/modules/cloudflared.rs`、`src-tauri/src/commands/proxy.rs`、`src-tauri/src/proxy/proxy_pool.rs`、`src-tauri/src/proxy/monitor.rs`、`src/pages/Settings.tsx`、`src/pages/ApiProxy.tsx`
- git push 走代理：`git -c http.proxy=http://127.0.0.1:51081 push origin ...`（PowerShell 下 `-c` 必须紧跟 git 后，不能放 push 后）
- 全量测试已知失败集（与改动无关）：mappers thinking-budget 2 断言 + security_db 共享真实 db 环境污染随机 6-14 个
