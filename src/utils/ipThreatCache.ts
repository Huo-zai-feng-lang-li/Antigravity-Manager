import type { IpGeoInfo } from '../types/security';
import { classifyIp, displayIp } from './ipFormat';
import { request } from './request';

interface BaiduRiskItem {
    label?: string;
    subItems?: string[];
}

interface BaiduPortraitResponse {
    code: number;
    data?: {
        country?: string;
        province?: string;
        city?: string;
        isp?: string;
        scene?: string;
        risk_score?: string;
        security_risks?: Record<string, BaiduRiskItem[]>;
    };
}

const MAX_CACHE_SIZE = 500;
const MAX_SESSION_ENTRIES = 200;
const MEMORY_CACHE = new Map<string, IpGeoInfo>();
const IN_FLIGHT = new Map<string, Promise<IpGeoInfo | null>>();
const SESSION_CACHE_KEY = 'antigravity_ip_geo_enrich_v1';

// 初始化从 sessionStorage 读取
try {
    const cached = sessionStorage.getItem(SESSION_CACHE_KEY);
    if (cached) {
        const parsed = JSON.parse(cached);
        for (const [k, v] of Object.entries(parsed)) {
            if (MEMORY_CACHE.size < MAX_CACHE_SIZE) {
                MEMORY_CACHE.set(k, v as IpGeoInfo);
            }
        }
    }
} catch {
    // 忽略异常
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveToSessionDebounced() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            const obj: Record<string, IpGeoInfo> = {};
            let count = 0;
            // 仅保留最新的 MAX_SESSION_ENTRIES 条，防止爆浏览器存储
            const entries = Array.from(MEMORY_CACHE.entries());
            const startIdx = Math.max(0, entries.length - MAX_SESSION_ENTRIES);
            for (let i = startIdx; i < entries.length; i++) {
                const [k, v] = entries[i];
                obj[k] = v;
                count++;
                if (count >= MAX_SESSION_ENTRIES) break;
            }
            sessionStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(obj));
        } catch {
            // 忽略存储超限异常
        }
    }, 500);
}

function setCache(ip: string, geo: IpGeoInfo) {
    if (MEMORY_CACHE.size >= MAX_CACHE_SIZE) {
        const oldestKey = MEMORY_CACHE.keys().next().value;
        if (oldestKey) MEMORY_CACHE.delete(oldestKey);
    }
    MEMORY_CACHE.set(ip, geo);
    saveToSessionDebounced();
}

/**
 * 通过 Vite 代理或直接请求获取百度 IP 画像（支持 Single-Flight 去重与 LRU 缓存）
 */
export async function fetchBaiduPortrait(ip: string): Promise<IpGeoInfo | null> {
    const rawIp = displayIp(ip).trim();
    if (!rawIp || classifyIp(rawIp) !== 'public') {
        return null;
    }

    if (MEMORY_CACHE.has(rawIp)) {
        const cached = MEMORY_CACHE.get(rawIp);
        if (cached && (cached.risk_score || cached.country)) {
            return cached;
        }
    }

    // Single-Flight: 若已有同 IP 请求在途，直接复用 Promise，避免并发风暴
    const running = IN_FLIGHT.get(rawIp);
    if (running) {
        return running;
    }

    const task = (async (): Promise<IpGeoInfo | null> => {
        // 1. 优先通过后端 (Tauri IPC 或 /api/security/ip-geo) 实时查询并落库
        try {
            const backendGeo = await request<IpGeoInfo | null>('query_ip_geo', { ip: rawIp });
            if (backendGeo && (backendGeo.risk_score || backendGeo.country)) {
                setCache(rawIp, backendGeo);
                return backendGeo;
            }
        } catch {
            // 后端不可用时静默降级
        }

        try {
            // 2. 降级使用 Vite 代理以规避浏览器防盗链，前端直连百度画像
            const res = await fetch(`/baidu-portrait/api/v1/ip-portrait/brief-info?ip=${encodeURIComponent(rawIp)}`);
            if (!res.ok) return null;
            const json: BaiduPortraitResponse = await res.json();
            if (json.code !== 200 || !json.data) return null;

            const data = json.data;
            const subItemsList: string[] = [];
            if (data.security_risks) {
                for (const category of Object.values(data.security_risks)) {
                    if (Array.isArray(category)) {
                        for (const item of category) {
                            if (item.subItems && Array.isArray(item.subItems)) {
                                for (const sub of item.subItems) {
                                    if (sub && typeof sub === 'string' && !subItemsList.includes(sub)) {
                                        subItemsList.push(sub);
                                    }
                                }
                            }
                            if (item.label && typeof item.label === 'string' && !subItemsList.includes(item.label)) {
                                subItemsList.push(item.label);
                            }
                        }
                    }
                }
            }

            const enriched: IpGeoInfo = {
                country: data.country || undefined,
                region: data.province || undefined,
                city: data.city || undefined,
                isp: data.isp || undefined,
                scene: data.scene || undefined,
                risk_score: data.risk_score || undefined,
                risk_detail: subItemsList.length > 0 ? subItemsList.join('、') : undefined,
                sub_items: subItemsList,
            };

            setCache(rawIp, enriched);
            return enriched;
        } catch (e) {
            console.warn('[IpThreatCache] Failed to fetch Baidu portrait for', rawIp, e);
            return null;
        } finally {
            IN_FLIGHT.delete(rawIp);
        }
    })();

    IN_FLIGHT.set(rawIp, task);
    return task;
}

/**
 * 批量富化缺失风险画像的 IP 列表（并发受控执行）
 */
export async function enrichIpListGeo<T extends { client_ip: string; geo?: IpGeoInfo }>(
    items: T[]
): Promise<{ changed: boolean; items: T[] }> {
    let changed = false;
    const newItems = [...items];

    // 并发触发富化任务
    const promises = newItems.map(async (item, i) => {
        const rawIp = displayIp(item.client_ip).trim();
        if (classifyIp(rawIp) !== 'public') return;

        // 如果已有 risk_score 或 country 且数据充足，跳过
        if (item.geo?.risk_score && item.geo.risk_score.trim() !== '') {
            return;
        }

        // 先查本地缓存
        let enriched = MEMORY_CACHE.get(rawIp);
        if (!enriched || (!enriched.risk_score && !enriched.country)) {
            enriched = (await fetchBaiduPortrait(rawIp)) || undefined;
        }

        if (enriched && (enriched.risk_score || enriched.country)) {
            newItems[i] = {
                ...item,
                geo: {
                    ...(item.geo || {}),
                    ...enriched,
                },
            };
            changed = true;
        }
    });

    await Promise.all(promises);
    return { changed, items: newItems };
}
