# Antigravity-Manager 安全鉴权与代理管控规范

## 1. 鉴权体系架构与分级模型

Antigravity-Manager 采用严格的双通道双层鉴权模型，将**外部 API 请求**与**内部管理控制面**彻底解耦隔离。

```
                       +---------------------------------------+
                       |              请求进入                  |
                       +-------------------+-------------------+
                                           |
                    +----------------------+----------------------+
                    |                                             |
                    v (管理端点: /api/*)                           v (代理端点: /v1/*, /v1beta/*)
+---------------------------------------+     +---------------------------------------+
|          Web Password 鉴权            |     |             API Key 鉴权              |
| - Header: Authorization: Bearer <PWD> |     | - Header: Authorization: Bearer <KEY> |
| - Header: X-Web-Password: <PWD>       |     | - Header: x-api-key: <KEY>            |
| - Cookie: abv_token=<SESSION>         |     | - Query:  ?key=<KEY>                  |
+---------------------------------------+     +---------------------------------------+
```

### 1.1 环境变量覆盖规则
- 生产环境配置支持通过环境变量直接注入，具有全局最高优先级：
  - `ABV_API_KEY`：强制覆盖全局 API 访问密钥。如果设置，所有 `/v1/*` 端点必须匹配此密钥。
  - `ABV_WEB_PASSWORD`：强制覆盖管理后台密码。如果设置，所有 `/api/*` 管理路由必须校验此密码。
  - `ABV_PROXY_BIND`：指定代理绑定的 IP 与端口（默认 `127.0.0.1:8045`）。
- **安全红线**：若监听地址配置为 `0.0.0.0` 或暴露于公网（如结合 Cloudflared 隧道），系统启动时必须强制检测并确保 `API_KEY` 和 `WEB_PASSWORD` 非空；否则必须拒绝启动或输出高危安全警告。

### 1.2 用户令牌 (UserToken) 细粒度管控
- 代理网关支持颁发独立的 `UserToken` 给下游调用者：
  - **模型白名单限制**：可限制特定 Token 仅能访问部分模型（如允许使用 `gemini-2.5-flash`，禁止使用高成本的 `gemini-2.5-pro` 或图像生成）。
  - **有效期与配额**：支持设置过期时间戳及总请求量限额，超额自动熔断。

---

## 2. 凭据日志脱敏铁律 (Zero Credential Leakage)

所有面向终端打印、Tracing 日志或前端返回的错误信息中，**严禁明文出现任何敏感凭据**。

### 2.1 敏感信息抹除规范
在记录任何错误、请求异常或上游返回内容时，必须无条件调用脱敏工具函数：
- **邮箱脱敏 (`mask_email`)**：
  - 格式：`userexample@gmail.com` ➔ `use***@gm***`。
  - 严禁在日志中输出账号完整邮箱地址。
- **令牌与密码脱敏 (`sanitize_error_for_log`)**：
  - 过滤规则涵盖：`access_token`、`refresh_token`、`id_token`、`authorization`、`api_key`、`secret`、`password`、`proxy_url`、`http_proxy`、`https_proxy`。
  - 过滤形式：`$1=<redacted>`，抹除 Bearer 后的具体哈希值。
  - **日志长度截断**：错误日志单行截断上限为 1000 字符，防止日志炸弹（Log Bombing）耗尽磁盘 I/O。

---

## 3. 代理池 (ProxyPool) 隔离与防封禁机制

为防止多账号共用同一出口 IP 导致被 Google 批量判定异常或关联封号，系统内建动态代理池。

### 3.1 单账号独立代理绑定
- **绑定粒度**：支持为每个 Account ID 绑定专用的代理实例（HTTP / HTTPS / SOCKS5）。
- **动态调度**：
  - `UpstreamClient` 维护 `client_cache: DashMap<String, Client>`。
  - 当发出请求时，根据当前调度的 `account_id` 自动从 `ProxyPoolManager` 提取绑定的代理配置并复用专用客户端；无绑定时回退至系统全局默认代理。

### 3.2 热更新与连接池清理 (Hot-Reload)
- 当代理池配置发生变更（编辑 URL、修改认证密码、重新绑定账号）时：
  - 必须立即调用 `upstream_client.clear_client_cache()`，清空陈旧的 Reqwest/Rquest 客户端实例。
  - 调用 `rebuild_default_client()` 异步重建默认客户端，确保新的配置在无需重启系统的情况下毫秒级生效。

---

## 4. IP 访问控制与黑白名单

1. **白名单模式 (Allowlist)**：
   - 当启用白名单时，仅允许配置列表中的 IPv4 / CIDR 网段（如 `127.0.0.1`, `192.168.1.0/24`）发起请求，其余请求直接在中间件层返回 `403 Forbidden`。
2. **防暴力破解**：
   - Web 后台登录失败次数超限时，自动将来源 IP 加入临时封禁表（冷却时间可配置，默认 15 分钟）。
