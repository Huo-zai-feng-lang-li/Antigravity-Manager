# 项目交接记忆库 (Handoff)

## 当前正在执行的任务
- 任务名称：Cloudflare 命名隧道全自动部署与链路优化
- 目标域名：`gateway.ai95.indevs.in` -> `http://localhost:8045`
- 关联账号：`ai95.indevs.in` (Zone ID: `8092dbd907019533c83a956a2468a36d`, Account ID: `6b14a138558986705be9edd377d7d092`)

## 当前状态
- [x] 规划与架构设计完成
- [x] 自动化脚本调用 Cloudflare API 创建 Tunnel、配置 Ingress 与 DNS 记录完成
- [x] 代码级 Bug 修复与体验闭环：
  - `src-tauri/src/modules/cloudflared.rs`：新增 `custom_domain` 属性，启动 Auth 模式零延迟回显固定 URL，增强日志 hostname 正则提取健壮性
  - `src/types/config.ts`：更新 `CloudflaredConfig` 接口定义，保证前后端类型安全
  - `src/pages/ApiProxy.tsx`：增加自定义域名 UI 输入与持久化绑定，启动即刻展示并复制 `https://gateway.ai95.indevs.in/v1`
  - `gui_config.json`：写入本地持久化配置
- [x] 深度链路性能优化完成：
  - Cloudflare 规则集部署 Cache Rules：`http.host eq "gateway.ai95.indevs.in"` 开启 `cache: false`，彻底消除大模型 SSE 流式输出缓冲卡顿
  - 边缘网络特性全开：`0-RTT`, `HTTP/3 (QUIC)`, `TLS 1.3`, `Brotli`, `Early Hints`
- [x] 端到端网络取证完成（0-RTT 握手耗时从 2.6s 压至 0.9s，优选 IP 测速至 94ms，HTTP/3 与 Bypass Cache 验证生效）
- [x] 版本递增至 `v4.6.10` 并同步 CHANGELOG、README、Casks
- [x] 深度排查并修复 CI 构建崩盘 Bug：修复 `tauri.conf.json` 中 Minisign pubkey 截断损坏导致 Base64 conversion failed 致命错误

## 交付信息
- 目标版本：`v4.6.10`
- 访问地址：`https://gateway.ai95.indevs.in`
- 客户端 Base URL：`https://gateway.ai95.indevs.in/v1`
- 本地映射：`http://localhost:8045`
- Tunnel 名称：`antigravity-gateway`
- Tunnel ID：`c62b7d95-2b4b-4508-835d-61b9c195a8b4`


