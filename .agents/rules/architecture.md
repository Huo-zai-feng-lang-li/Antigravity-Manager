# Antigravity-Manager 架构设计与分层规范

## 1. 系统全景架构拓扑

```
+-------------------------------------------------------------------------+
|                              客户端调用方                                 |
|   (VS Code / Cursor / Windsurf / Claude Code / OpenAI Client / Web UI)  |
+------------------------------------+------------------------------------+
                                     |
                                     v HTTP / WebSocket (Port: 8045 默认)
+-------------------------------------------------------------------------+
|                        Axum 反向代理服务层 (Server)                      |
|  [中间件链 (洋葱模型)]:                                                  |
|   1. IP Filter Middleware (黑白名单校验)                                  |
|   2. Security Middleware (API Key / Web Password / UserToken 双鉴权)     |
|   3. Monitor Middleware (请求耗时、流量、Prometheus 指标统计)             |
|   4. Route Dispatcher (路由分流器: OpenAI / Claude / Gemini / Admin API) |
+------------------------------------+------------------------------------+
                                     |
         +---------------------------+---------------------------+
         |                                                       |
         v                                                       v
+----------------------------------+     +----------------------------------+
|      协议转换层 (Handlers)       |     |        管理控制面 (Admin API)     |
| - handlers/openai.rs (Chat/Completions)| - 账号 CRUD & 配额查询           |
| - handlers/claude.rs (Messages API)    | - 代理池配置与健康检查           |
| - handlers/gemini.rs (Native Gemini)   | - 规则路由与模型重定向映射       |
| - handlers/audio.rs & warmup.rs        | - 服务日志与统计监控看板         |
+-----------------+----------------+     +-----------------+----------------+
                  |                                        |
                  +-------------------+--------------------+
                                      |
                                      v
+-------------------------------------------------------------------------+
|                      核心调度层: TokenManager                            |
| - 内存账号池缓存 (Arc<RwLock<HashMap<String, Account>>>)                  |
| - 智能调度器: 权衡剩余配额 (Quota)、健康评分 (Health Score)、活跃度 (LRU) |
| - 429 冷却与自动熔断跟踪 (LiveLimitStatus / Circuit Breaker)             |
| - 并发防击穿锁 (Double-Checked Locking & In-flight Token Refresh)        |
+------------------------------------+------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|                     上游通信与 TLS 指纹仿真层: UpstreamClient            |
| - rquest (基于 BoringSSL 仿真 Chrome 123 TLS 指纹、ALPN、HTTP/2)        |
| - 多端点自动 Fallback:                                                   |
|     1. Sandbox: daily-cloudcode-pa.sandbox.googleapis.com/v1internal    |
|     2. Daily: daily-cloudcode-pa.googleapis.com/v1internal               |
|     3. Prod: cloudcode-pa.googleapis.com/v1internal                      |
| - 特殊错误自愈 (403 移除 x-goog-user-project 并动态重试)                |
| - 动态代理池绑定 (ProxyPoolManager: 直连 / HTTP / SOCKS5 单账号绑定)    |
+------------------------------------+------------------------------------+
                                     |
                                     v HTTPS
+-------------------------------------------------------------------------+
|                     Google Cloud Code / Gemini 上游服务                  |
+-------------------------------------------------------------------------+
```

---

## 2. 核心模块通信契约与职责划分

### 2.1 Axum Server 与洋葱中间件
- **职责范围**：处理所有外部网络 I/O，完成协议前置清洗与统一异常拦截。
- **架构约束**：
  - 严禁在中间件中进行慢 I/O 操作或非必要的数据库查询。
  - 所有跨路由状态（`AppState`）必须采用 `Arc<T>` 封装，内部状态若需变更应优先使用无锁结构（如 `dashmap::DashMap`、`atomic::*`）或细粒度 `RwLock`。

### 2.2 TokenManager (核心大脑)
- **职责范围**：
  1. **账号调度**：根据目标模型（如 `gemini-2.5-pro`、`claude-3-7-sonnet`）在多账号间执行最优负载均衡算法。
  2. **OAuth 刷新防击穿**：
     - 当 Token 过期（或在 5 分钟缓冲期内）时，触发刷新。
     - **必须采用并发防击穿模式**：同一账号在任意时刻仅允许一个异步协程发起 Google OAuth Refresh 请求，其余等待协程通过广播通知获取最新 Token，严禁并发并发刷新导致 OAuth Refresh Token 报废。
  3. **实时限流熔断与自愈**：
     - 捕获上游 429 或 `QUOTA_EXHAUSTED` 错误，自动将当前账号+模型加入 `live_limited_models` 冷却表，并计算 `reset_time`。
     - 在冷却到期前，调度器自动跳过该账号，转而调度池中可用备用账号。

### 2.3 UpstreamClient (网络与 TLS 仿冒)
- **职责范围**：负责对抗上游的反爬与协议风控。
- **关键机制**：
  - **TLS 仿真**：使用 `rquest` 库固定 `Emulation::Chrome123`，严格对齐浏览器的 Client Hello、密码套件与扩展顺序。
  - **请求头清洗与脱敏**：
    - 注入官方关键特征头：`x-client-name: antigravity`、`x-client-version`、`x-machine-id`、`x-vscode-sessionid`。
    - 所有上游 POST（含 `streamGenerateContent`、图片生成）请求体统一先序列化为字节再发送确定 `Content-Length`，禁止 `wrap_stream` 产生 chunked 请求体；`streamGenerateContent` 的流式仅体现在 SSE 响应方向。
  - **三级降级链路**：优先进入 Sandbox/Daily 端点避开主线限流风暴，仅在备用端点全部不可用时降级至 Prod。

### 2.4 数据持久化与自愈层 (Account Data & DB Module)
- **双重持久化通道**：
  1. **本地 JSON 存储**：存储账号索引与模型配额缓存（`~/.antigravity_tools/` 或环境变量 `ABV_DATA_DIR` 指定路径）。
  2. **IDE 注入通道**：向 VS Code / Cursor 等编辑器的 SQLite 数据库（`state.vscdb`）注入 Google OAuth Protobuf 二进制状态，实现无感知账号切换。
- **文件写入防腐原则**：
  - 文件修改必须写入唯一临时文件（`temp_filename = format!("{}.tmp.{}", ...)`），刷新磁盘后再执行原子性替换（Atomic Rename），彻底杜绝掉电或崩溃导致的数据文件 0 字节损坏。
  - 加载时支持 BOM 剥离、前导 NUL 字节过滤以及尾部畸形括号自愈修复（Self-healing JSON parsing）。
