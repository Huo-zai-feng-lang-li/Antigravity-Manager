# Cloudflare 命名隧道自动化部署与链路优化实施计划

## 核心目标
1. 目标子域名：`gateway.example.com`（指向本地 Antigravity 代理 `http://localhost:8045`）
2. 全自动云端编排：通过 Cloudflare API 完成 Tunnel 创建、Ingress 路由规则写入、DNS CNAME 记录自动绑定
3. 链路速度与稳定性深度优化：
   - 启用 HTTP/2 协议（防止国内运营商对 QUIC/UDP 进行 QoS 限速或阻断）
   - Ingress OriginRequest 优化（开启 keep-alive 连接池、超时缩短为 15s，减少建连握手 RTT）
   - Cloudflare CDN 边缘 Anycast 代理加速（Proxied 模式）
4. 本地客户端零感知持久化：自动将 Tunnel Token 与优化配置持久化写入 `gui_config.json`

## 执行流程与里程碑
- [x] 阶段 1：云端 Tunnel 创建与 Token 提取
  - 调用 `POST /accounts/{id}/cfd_tunnel` 创建名为 `antigravity-gateway` 的隧道
  - Tunnel ID: `<TUNNEL_ID>`
  - 获取生成的专属 Tunnel Token
- [x] 阶段 2：云端路由与 DNS 自动绑定
  - 调用 `PUT /accounts/{id}/cfd_tunnel/{tunnel_id}/configurations` 设置 Ingress 规则指向 `localhost:8045` 并配置 originRequest 优化（HTTP/2 Origin, 100 Keep-Alive Connections, 15s timeout）
  - 调用 `POST /zones/{zone_id}/dns_records` 添加自定义子域名的 CNAME 记录至 `<TUNNEL_ID>.cfargotunnel.com` (Proxied: true)
- [x] 阶段 3：本地配置持久化与速度优化
  - 更新 `gui_config.json` 中的 `cloudflared` 配置（`mode: "auth"`, `token: eyJhIjoi...`, `use_http2: true`）
- [x] 阶段 4：双向链路验证与端到端取证
  - DNS 解析与 Anycast CDN 节点验证生效
  - 确认二进制文件 `cloudflared.exe` 存在于客户端专用 bin 目录
