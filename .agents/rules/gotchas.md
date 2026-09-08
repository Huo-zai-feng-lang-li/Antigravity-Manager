# Antigravity-Manager 踩坑与防御指南 (Gotchas & Defenses)

本文档汇总了在开发、维护与跨平台部署 Antigravity-Manager 过程中沉淀的高危陷阱与硬核解决方案。所有开发者在修改核心逻辑前必须逐一核对。

---

## 1. 操作系统与底层环境踩坑

### 1.1 Windows: EcoQoS / Power Throttling 导致后台代理假死
- **现象**：在 Windows 11 / 10 较新版本中，当 Tauri 窗口最小化或转入后台一段时间后，代理服务请求响应变慢数十倍甚至直接超时。
- **根因**：Windows 操作系统针对后台进程自动启用了 **EcoQoS (节能节流/Power Throttling)**，将进程绑死在能效小核并强制限制 CPU 调度时钟。
- **防御对策**：
  - 在 `src-tauri/src/lib.rs` 启动时通过 Windows Win32 API 明确关闭当前进程的 `ProcessPowerThrottling` 限制，声明为正常性能优先级，严禁随意删除此优化逻辑。

### 1.2 macOS: 文件描述符 (NOFILE) 耗尽引发“Too many open files”
- **现象**：macOS 默认对单进程的文件描述符上限仅为 256 或 1024。在多并发代理场景下，TCP 链接迅速将句柄占满，导致网络请求全部 Panic 崩溃。
- **防御对策**：
  - 在应用启动时（`setup_system_limits`）动态检测并调用 `libc::setrlimit` 将 `RLIMIT_NOFILE` 软限制主动提升至 `65535` 或系统允许的最大值。

### 1.3 Linux: WebKitGTK DMA-BUF 渲染崩溃与 Headless 闪退
- **现象**：部分 Linux 发行版（如 Ubuntu 22.04/24.04 配合 NVIDIA 闭源驱动）运行 Tauri 界面时发生 Segmentation Fault，或报错 `WebKitGTK: Failed to create GBM buffer`。
- **防御对策**：
  - Linux 启动时自动注入环境变量：`WEBKIT_DISABLE_DMABUF_RENDERER=1`。
  - 在 Docker / Headless 模式下执行时，自动跳过 Webview 初始化，直接使用纯 Tokio 异步运行时启动 Axum 服务。

---

## 2. 上游协议与 Google Cloud Code 代理陷阱

### 2.1 403 Forbidden 陷阱与 `x-goog-user-project` 报头冲突
- **现象**：向上游发送请求时，上游返回 `403 FORBIDDEN`（错误提示通常为 `SERVICE_DISABLED` 或 `Quota exceeded for project`）。
- **根因**：部分账号为免费/试用类型，并不隶属于特定 GCP 项目；若强制在 Header 中带上 `x-goog-user-project`，Google 端网关会将其归属于无效项目直接拒绝。
- **防御对策**（已在 `UpstreamClient::call_v1_internal_with_headers` 中实现）：
  - 当收到 403 时，自动捕获并判断 Header 中是否存在 `x-goog-user-project`。
  - **单次自动降级重试**：立即移除该 Header，重置重试标记，重新发起一次端点降级探测。
  - 针对 `generateContent` 与 `streamGenerateContent`，默认主动剥离 `x-goog-user-project`。

### 2.2 流式传输分块 (Chunked) 与图像生成 Content-Length 冲突
- **现象**：请求图像生成接口（Imagen / Gemini Image）时，频繁被 Google 服务端拒绝或报 429 / 400 Bad Request。
- **根因**：如果对所有请求无差别使用 `rquest::Body::wrap_stream`，会导致 HTTP 请求以 `Transfer-Encoding: chunked` 形式发送，缺少明确的 `Content-Length`。Google 图像生成后端强制校验固定包长。
- **防御对策**：
  - 仅对流式对话方法 `streamGenerateContent` 启用 stream 分块包装。
  - 对 `generateContent`、`loadCodeAssist`、图像生成等所有非流式方法，必须发送明确字节长度的 Body（`req_builder.body(body_bytes)`）。

### 2.3 上游端点 Fallback 优先级与限流风暴
- **现象**：直接调用 Google Prod 端点（`cloudcode-pa.googleapis.com`）极易触发全局 429 限流。
- **防御对策**：
  - 严格保持优先级调用链路：
    `Sandbox (daily-cloudcode-pa.sandbox.googleapis.com)` ➔ `Daily (daily-cloudcode-pa.googleapis.com)` ➔ `Prod (cloudcode-pa.googleapis.com)`。
  - 只有在收到 `REQUEST_TIMEOUT`、`NOT_FOUND` 或 `5xx` 时，才允许向后回退。严禁颠倒端点尝试顺序。

---

## 3. 账号管理与数据持久化防损陷阱

### 3.1 账号 JSON 文件尾部畸形字符 (Trailing Characters)
- **现象**：进程非正常退出或磁盘并发写入冲突时，`accounts/*.json` 文件尾部可能多写一个 `}`，导致 `serde_json::from_str` 报错。
- **防御对策**：
  - 采用流式反序列化自愈解析（`serde_json::Deserializer::from_str(&content)`），成功反序列化有效主体后，自动将干净的数据覆盖回磁盘，实现无感知自愈。

### 3.2 UTF-8 BOM 与空字节 (NUL Prefix) 污染
- **现象**：Windows 编辑器或系统还原工具可能会在 JSON 开头写入 `0xEF, 0xBB, 0xBF` (BOM) 或因文件截断写入大量 `0x00` (NUL) 字节。
- **防御对策**：
  - 解析前强制调用 `sanitize_index_content`，剥离 BOM 前缀并丢弃开头的连续 NUL 字节。
  - 当文件彻底损坏无法恢复时，自动生成带时间戳和 UUID 的备份（`accounts.json.corrupt-<timestamp>-<uuid>`），并从 `accounts/*.json` 目录全量扫描自动重建索引。

### 3.3 写入竞争与原子重命名
- **严禁直接向原文件覆盖写**：
  - 写入流程必须规范为：写入临时文件 `accounts.json.tmp.<uuid>` ➔ 同步落盘 ➔ 调用跨平台 `atomic_replace_file` 重命名替换目标文件。
  - 必须持有全局进程互斥锁 `ACCOUNT_INDEX_LOCK`，防止多线程并发破坏数据完整性。

---

## 4. 本地 IDE (VS Code / Cursor) 数据库注入陷阱

### 4.1 SQLite `state.vscdb` 文件锁冲突
- **现象**：当 VS Code / Cursor 处于打开状态时，其 SQLite 数据库被 IDE 独占锁定，直接使用写连接会报 `database is locked (code 5)`。
- **防御对策**：
  - 配置 Rusqlite 的 `busy_timeout`（至少 5000ms）。
  - 执行注入更新时使用 WAL 模式（Write-Ahead Logging），并将事务控制在毫秒级微操作内，避免长期持有写锁。

### 4.2 Protobuf 序列化格式对齐
- **现象**：VS Code 对保存在 `state.vscdb` 中的 OAuth Session 具有严格的 Protobuf 序列化结构与校验特征。
- **防御对策**：
  - 注入前必须严格校验结构体字段，确保 `service_machine_id`、`session_id` 与账号 Token 的对应关系一致，防止注入后 IDE 弹出“凭据已失效”提示。
