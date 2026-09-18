import type { IpGeoInfo } from '../types/security';

/**
 * 还原 IPv4-mapped IPv6（如 ::ffff:8.8.8.8 → 8.8.8.8），让展示更易懂。
 * 纯字符串处理，不依赖浏览器特性。
 */
export function displayIp(ip: string): string {
    if (!ip) return ip;
    const mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    return mapped ? mapped[1] : ip;
}

export function isIpv6(ip: string): boolean {
    return displayIp(ip).includes(':');
}

/**
 * 表格等窄空间使用的 IP 缩写：先还原 v4-mapped（::ffff:1.2.3.4 → 1.2.3.4），
 * 再对超长纯 IPv6 保留前 2 组与末 1 组
 * （如 2408:847a:712:6e98:1437:4fff:fedf:4e8f → 2408:847a…4e8f）。
 * 仅用于展示，完整地址放在 title；纯 IPv6 技术上无法转为 IPv4。
 */
export function compactIp(ip: string, maxLen = 20): string {
    if (!ip) return ip;
    const shown = displayIp(ip);
    if (shown.length <= maxLen) return shown;
    const groups = shown.split(':');
    if (groups.length < 5) return shown;
    return `${groups.slice(0, 2).join(':')}…${groups.slice(-1).join(':')}`;
}

/** 本地分类（不查网）：loopback / private / linklocal / public */
export type IpKind = 'loopback' | 'private' | 'linklocal' | 'public';

export function classifyIp(ip: string): IpKind {
    const v4 = displayIp(ip).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        if (a === 127) return 'loopback';
        if (a === 10) return 'private';
        if (a === 172 && b >= 16 && b <= 31) return 'private';
        if (a === 192 && b === 168) return 'private';
        if (a === 169 && b === 254) return 'linklocal';
        if (a === 0) return 'private';
        return 'public';
    }
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return 'loopback';
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return 'linklocal';
    return 'public';
}

/** 归属地文本：优先 城市/地区，其次国家；公网无缓存时返回 null（等待异步补全） */
export function geoText(geo?: IpGeoInfo | null): string | null {
    if (!geo) return null;
    const parts = [geo.city, geo.region, geo.country].filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
}

export interface IpDisplay {
    /** 主文本：IP（已还原 v4-mapped） */
    ip: string;
    /** 次要文本：归属地或本地标签 */
    detail: string;
    kind: IpKind;
    isIpv6: boolean;
}

/**
 * 组合 IP 展示信息。`t` 用于本地标签 i18n，缺失时回退默认中文。
 */
export function describeIp(
    rawIp: string,
    geo?: IpGeoInfo | null,
    t?: (key: string) => string,
): IpDisplay {
    const ip = displayIp(rawIp);
    const kind = classifyIp(ip);
    const v6 = isIpv6(ip);

    const fallbackLabels: Record<IpKind, string> = {
        loopback: '本地回环',
        private: '局域网',
        linklocal: '链路本地',
        public: '公网',
    };

    const localLabels: Record<IpKind, string> = {
        loopback: (t ? t('security.ip_kind.loopback') : null) || fallbackLabels.loopback,
        private: (t ? t('security.ip_kind.private') : null) || fallbackLabels.private,
        linklocal: (t ? t('security.ip_kind.linklocal') : null) || fallbackLabels.linklocal,
        public: '',
    };

    let detail = geoText(geo) || '';
    if (kind !== 'public') {
        detail = localLabels[kind] || fallbackLabels[kind];
    }

    return { ip, detail, kind, isIpv6: v6 };
}

/** 剩余有效期（秒级时间戳 → 人类可读），过期返回 null */
export function remainingTime(expiresAt?: number, now: number = Math.floor(Date.now() / 1000)): string | null {
    if (!expiresAt) return null;
    const diff = expiresAt - now;
    if (diff <= 0) return null;
    const hours = Math.floor(diff / 3600);
    const minutes = Math.floor((diff % 3600) / 60);
    if (hours >= 48) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isValidIpv4(ip: string): boolean {
    const m = ip.match(IPV4_RE);
    if (!m) return false;
    // 与 Rust std Ipv4Addr::from_str 对齐：拒绝前导零（八进制歧义，如 010）
    return m.slice(1).every(part => {
        if (part.length > 1 && part.startsWith('0')) return false;
        return Number(part) <= 255;
    });
}

function isValidIpv6(ip: string): boolean {
    // 支持 :: 压缩形式；含 IPv4-mapped 后缀（::ffff:1.2.3.4）
    let v6 = ip;
    const v4Suffix = v6.match(/^(.*?)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4Suffix && v6.includes(':')) {
        if (!isValidIpv4(v4Suffix[2])) return false;
        v6 = v4Suffix[1] + '0:0';
    }
    if (!v6.includes(':')) return false;
    if ((v6.match(/::/g) || []).length > 1) return false;

    const halves = v6.split('::');
    const groups = halves.flatMap(h => (h === '' ? [] : h.split(':')));
    if (halves.length === 1) {
        if (groups.length !== 8) return false;
    } else if (groups.length > 7) {
        return false;
    }
    return groups.every(g => g === '' || /^[0-9a-fA-F]{1,4}$/.test(g));
}

/** 校验单 IP 或 CIDR（IPv4 / IPv6），与后端 ip_util::is_valid_ip_pattern 对齐 */
export function isValidIpPattern(pattern: string): boolean {
    const p = pattern.trim();
    if (!p) return false;
    const slash = p.indexOf('/');
    if (slash === -1) {
        return isValidIpv4(p) || isValidIpv6(p);
    }
    if (p.indexOf('/', slash + 1) !== -1) return false;
    const addr = p.slice(0, slash);
    const mask = Number(p.slice(slash + 1));
    if (!Number.isInteger(mask) || mask < 0) return false;
    if (addr.includes(':')) {
        return mask <= 128 && isValidIpv6(addr);
    }
    return mask <= 32 && isValidIpv4(addr);
}
