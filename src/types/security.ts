// IP 管理 / 安全监控模块类型定义（字段名与后端 serde 输出保持一致：snake_case）

/** IP 归属地信息 */
export interface IpGeoInfo {
    country?: string;
    region?: string;
    city?: string;
    isp?: string;
}

/** IP 访问日志 */
export interface IpAccessLog {
    id: string;
    client_ip: string;
    timestamp: number; // Unix 秒
    method?: string;
    path?: string;
    user_agent?: string;
    status?: number;
    duration?: number;
    api_key_hash?: string;
    blocked: boolean;
    block_reason?: string;
    username?: string;
    geo?: IpGeoInfo;
}

export interface IpAccessLogResponse {
    logs: IpAccessLog[];
    total: number;
}

export interface IpAccessLogQuery {
    page: number;
    pageSize: number;
    search?: string;
    blockedOnly: boolean;
}

/** 黑名单条目 */
export interface IpBlacklistEntry {
    id: string;
    ip_pattern: string;
    reason?: string;
    created_at: number; // Unix 秒（注意：旧前端误用 added_at 导致 Invalid Date）
    expires_at?: number;
    created_by: string;
    hit_count: number;
}

/** 白名单条目 */
export interface IpWhitelistEntry {
    id: string;
    ip_pattern: string;
    description?: string;
    created_at: number;
}

/** IP 访问排行 */
export interface IpRanking {
    client_ip: string;
    request_count: number;
    last_seen: number;
    is_blocked: boolean;
    geo?: IpGeoInfo;
}

export interface IpStatsResponse {
    total_requests: number;
    unique_ips: number;
    blocked_requests: number;
    top_ips: IpRanking[];
}

/** 按 IP 聚合的 Token 消耗 */
export interface IpTokenStats {
    client_ip: string;
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    request_count: number;
    username?: string;
    geo?: IpGeoInfo;
}

export interface IpBlacklistConfig {
    enabled: boolean;
    block_message: string;
}

export interface IpWhitelistConfig {
    enabled: boolean;
    whitelist_priority: boolean;
}

export interface SecurityMonitorConfig {
    blacklist: IpBlacklistConfig;
    whitelist: IpWhitelistConfig;
    /** 是否信任前置代理的 X-Forwarded-For（直连保持关闭） */
    trust_proxy_headers: boolean;
    /** 是否启用在线 GeoIP 归属地查询 */
    geoip_enabled: boolean;
}

/** whoami 响应（后端 serde camelCase） */
export interface WhoAmIResponse {
    ip: string;
    ipVersion: string;
    class: string;
    loopback: boolean;
}

/** 名单类型 */
export type RuleListType = 'blacklist' | 'whitelist';

/** 过期预设（小时），0 表示永久 */
export const EXPIRY_PRESETS = [
    { value: 0, i18nKey: 'security.rules.expiry_forever' },
    { value: 1, i18nKey: 'security.rules.expiry_1h' },
    { value: 24, i18nKey: 'security.rules.expiry_24h' },
    { value: 168, i18nKey: 'security.rules.expiry_7d' },
    { value: 720, i18nKey: 'security.rules.expiry_30d' },
] as const;
