# 最新接续状态 (2026-09-10 21:50)

## 核心进展
- 完成对 Codex 接入本地反代时报 `Reconnecting... 2/5 request timed out` 的全链路深度逆向取证与网络排查，明确了 WebSocket 传输机制、Windows WinINet `<local>` 判定逻辑及最佳接入配置。
- 关键文件与配置：`C:\Users\Administrator\.codex\config.toml`、`D:\Desktop\脚本\BAT\解决codex代理冲突、网络异常、启动卡住.bat`、`D:\Codex-Editable\resources\codex.exe`。

## 核心动机与背景 (Motivation & Background)
- **现象**：用户在 Codex 中配置 `http://192.168.0.51:8045` 或 `127.0.0.1:8045` 时报错 `Reconnecting... 2/5 request timed out`；但在同一环境下访问 `http://localhost:8045` 或公网 `https://gateway.ai95.indevs.in` 却秒通。
- **根因剖析**：
  1. **Windows 系统代理对 `<local>` 的判定陷阱**：
     - 系统启用了本地代理服务（`ProxyServer: 127.0.0.1:51081`, `ProxyOverride: local;<local>`）。
     - 微软 WinINet 规范：`<local>` **只匹配不含点号（`.`）的主机名**（如 `localhost`），**不匹配带点分十进制的 IP**（如 `127.0.0.1`、`192.168.0.51`）。
     - Codex 核心（Rust reqwest）在未指定白名单时回退读取 WinINet，导致发往 `192.168.0.51` / `127.0.0.1` 的流量全部被强行转发给代理客户端 `51081`，代理节点无法路由局域网/私网 IP，陷入连接死等导致超时。
  2. **WebSocket 机制与 `supports_websockets` 影响**：
     - Codex 二进制（`core\src\responses_retry.rs`）默认优先发起 WebSocket 握手；若网关未适配 WS 双向流，Codex 会重试并在终端显示 `Reconnecting... 1/5`，之后才尝试降级到 HTTPS。
     - 关闭 WS（`supports_websockets = false`）完全无害：Codex 会直接切换为标准的 HTTP POST + SSE 流式协议（`text/event-stream`），打字机流式、Thinking 推理块、工具调用（Tool Calls）均 100% 完整支持。
  3. **批处理脚本陷阱**：
     - 用户 `解决codex代理冲突、网络异常、启动卡住.bat` 中存在 `set NO_PROXY=` 清空指令，导致后台子进程 `codex.exe` 失去局域网保护回退读取注册表。

## 关键设计与实现 (Implementation & Decisions)
- **Codex 最佳推荐配置方案（免代理干扰首选）**：
  在 `C:\Users\Administrator\.codex\config.toml` 中配置：
  ```toml
  model = "gemini-3.8-flash-tiered"
  model_provider = "local_antigravity"

  [model_providers.local_antigravity]
  name = "local_antigravity"
  base_url = "http://localhost:8045/v1"   # 推荐写 localhost，利用 <local> 机制天然免疫系统代理
  wire_api = "responses"                  # 实测反代原生支持 /v1/responses
  requires_openai_auth = true
  supports_websockets = false            # 显式关闭 WS，直接走 HTTP SSE 流式，彻底消除握手卡顿
  ```
- **公网网关备选方案**：
  使用 `https://gateway.ai95.indevs.in/v1`，公网域名走系统代理或直连均可正常解析，配合 `supports_websockets = false` 实测退出码 0 秒级响应。
- **BAT 修复建议**：
  将 BAT 中的 `set NO_PROXY=` 改为 `set NO_PROXY=192.168.0.51,192.168.0.0/16,127.0.0.1,localhost`。

## 待办事项 (Next Steps)
- [ ] 根据用户选择，将推荐配置（`http://localhost:8045/v1` + `supports_websockets = false`）实际写入 `C:\Users\Administrator\.codex\config.toml` 并验证。
- [ ] 协助用户将 `解决codex代理冲突、网络异常、启动卡住.bat` 调整为显式白名单注入，避免进程再次踩坑。
- [ ] 跟踪上一个任务 v4.7.3 的 CI 发布状态并验证新包安装后的 WS 运行表现。

## 关键上下文
- 目录: `D:\Desktop\Super-File\AI-IDE\AI\反重力\Antigravity-Manager`
- 核心配置: `C:\Users\Administrator\.codex\config.toml`、`C:\Users\Administrator\.codex\auth.json`
- 桌面客户端路径: `D:\Codex-Editable\Codex.exe`、后台二进制 `D:\Codex-Editable\resources\codex.exe`
- 批处理脚本路径: `D:\Desktop\脚本\BAT\解决codex代理冲突、网络异常、启动卡住.bat`
