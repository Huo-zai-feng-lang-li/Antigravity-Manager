# Antigravity-Manager 项目开发与工程宪章

> 版本适用：v4.6.9+  
> 核心定位：基于 Tauri v2 + Rust + Axum + React 的跨平台高可用 AI 协议转换与账号调度网关。

---

## 规则体系导航索引

本规则库采用分层解耦设计，指导所有 AI Agent 与工程团队的架构审计、代码实现与系统自检：

1. **[工程与防腐总则 (本篇 README.md)](./README.md)**：代码诗学、圈复杂度约束、异步线程池健康、跨端通信适配基线。
2. **[系统架构与分层设计 (architecture.md)](./architecture.md)**：Axum 洋葱中间件、TokenManager 调度状态机、UpstreamClient TLS 指纹仿真、VS Code `state.vscdb` 注入全景拓扑。
3. **[踩坑避雷与防御指南 (gotchas.md)](./gotchas.md)**：Windows EcoQoS 假死、macOS NOFILE 句柄耗尽、Linux WebKitGTK 崩溃、Google v1internal 403 移除 Header 降级、图片生成 Content-Length 冲突、JSON BOM/NUL 损坏自愈。
4. **[安全鉴权与代理管控 (security-and-proxy.md)](./security-and-proxy.md)**：API Key 与 Web Password 双鉴权体系、`ABV_` 环境变量最高优先级、日志凭据脱敏、单账号代理隔离与热重载。

---

## 1. 核心工程法则 (The Iron Laws)

### 1.1 事实证据高于口头推测 (Evidence Over Assertion)
- **严禁虚假报喜**：禁止在未经代码审计、编译验证、单元测试或真实端点请求的前提下声明“已修复”或“无 Bug”。
- **全链路闭环**：任何逻辑变更必须提供测试结果或运行时诊断凭证（包括退出码、响应状态码、关键脱敏日志）。

### 1.2 圈复杂度与代码诗学 (Cyclomatic Complexity < 9)
- **复杂度硬约束**：单个函数/方法的圈复杂度严格控制在 **9 以下**。超过 9 必须无条件进行函数抽取或状态机模式重构。
- **模块职责单一**：禁止将鉴权、限流、协议转换、上游分发揉进单一文件或函数中（参考 `src-tauri/src/proxy/` 各子模块划分）。
- **零冗余与类型严谨**：
  - Rust 侧：禁止随意使用 `unwrap()`、`expect("panic")`。所有错误必须使用 `Result<T, AppError>` 或结构化错误链路向下传递。
  - TypeScript 侧：严禁无理由使用 `any`，所有 API 请求/响应均需在 `src/types/` 或模块定义中完成类型闭环。

### 1.3 线程池与异步防护 (Tokio Runtime Hygiene)
- **禁止在异步上下文中执行阻塞式 IO**：
  - 严禁在 `tokio::task` 或 Axum Handler 中直接调用同步 `std::fs`、`std::thread::sleep`、或耗时加解密操作。
  - 必须使用 `tokio::fs`、`tokio::time::sleep` 或通过 `tokio::task::spawn_blocking` 将同步任务隔离到阻塞线程池中。
- **防止死锁**：跨异步等待（`.await`）持有同步锁（`std::sync::MutexGuard` / `std::sync::RwLockReadGuard`）属于严重架构违规，必须改用 `tokio::sync::*` 或在 `.await` 之前显式释放锁作用域。

---

## 2. 目录职责规范与防腐边界

| 目录/路径 | 职能划分 | 约束与防腐规则 |
|---|---|---|
| `src-tauri/src/proxy/` | Axum 反向代理服务核心 | 仅负责 HTTP 流量接收、鉴权、监控、路由与协议转发。严禁直接耦合 Tauri 桌面窗口状态。 |
| `src-tauri/src/proxy/token_manager.rs` | 账号令牌与状态管理 | 核心状态容器。负责账号池缓存、OAuth 刷新、429 冷却、熔断与健康度计算。必须保证多线程并发一致性。 |
| `src-tauri/src/proxy/upstream/` | 上游通信与 TLS 模拟 | 负责通过 `rquest` 模拟 Chrome123 指纹、Google v1internal 端点三级降级、连接池优化与请求重试。 |
| `src-tauri/src/modules/account.rs` | 账号数据持久化与容灾 | 负责 JSON 读写、BOM 清洗、NUL 字节过滤、损坏自动自愈与原子文件替换。严禁在此做网络业务判断。 |
| `src-tauri/src/modules/db.rs` | 本地 IDE 数据库注入 | 负责向 VS Code / Cursor / Windsurf 的 `state.vscdb` 注入 Protobuf 认证凭证与机器指纹。必须兼容不同平台路径。 |
| `src/stores/` | 前端状态管理 (Zustand) | 管理 UI 展现状态。数据变更必须调用 `src/services/` 或 `src/utils/request.ts`，禁止在 Store 中手写原生 fetch。 |
| `src/utils/request.ts` | 跨端通信抹平层 | 核心适配器：自动识别运行环境（Tauri 桌面端调用 `invoke`，Headless Web 模式调用 HTTP REST API）。业务代码严禁绕过此层。 |

---

## 3. 跨端适配原则 (Desktop vs Headless)

1. **双模式兼容**：
   - 桌面端依赖 Tauri IPC 命令（`#[tauri::command]`）。
   - Headless / Docker 模式依赖 Axum 暴露的管理端点（`/api/accounts`, `/api/config` 等）。
2. **环境变量最高优先级**：
   - 生产环境中，以 `ABV_` 开头的环境变量（如 `ABV_API_KEY`, `ABV_WEB_PASSWORD`, `ABV_DATA_DIR`）具有最高优先级，覆盖本地持久化配置。
3. **无界面（Headless）守护**：
   - 在 Headless 模式下启动时，不得尝试初始化 Webview 窗口，直接进入 Tokio 异步事件循环守护进程。

---

## 4. 交付与验证基线 (Verification Baseline)

1. **改动验证三要素**：
   - **代码可编译**：`cargo check` / `cargo clippy` 零 Error。
   - **无回归风险**：核心模块变更必须通过现有的 `cargo test`。
   - **真实链路印证**：涉及 API 代理改动，需使用测试脚本或 curl 命令针对 local port 执行端到端流量取证。
2. **变更审查清单**：
   - [ ] 圈复杂度是否保持 < 9？
   - [ ] 是否存在任何未脱敏的凭证日志？
   - [ ] 是否破坏了原子化文件写入或并发锁安全性？
   - [ ] 是否兼顾了 Headless Web 模式与 Tauri 桌面端双向兼容？
