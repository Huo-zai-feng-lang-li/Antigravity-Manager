import React from 'react';
import { ShieldCheck, ShieldAlert, AlertTriangle, MapPin, Radio, Building2, Network, Shield } from 'lucide-react';
import type { IpGeoInfo } from '../../types/security';
import { describeIp } from '../../utils/ipFormat';

interface Props {
    ip: string;
    geo?: IpGeoInfo | null;
    className?: string;
    compact?: boolean;
}

export const getRiskMeta = (riskScore?: string | null) => {
    const raw = (riskScore || '').trim();
    if (raw === '高' || raw.includes('高') || raw.toLowerCase().includes('high')) {
        return {
            level: '高风险',
            scoreText: raw,
            color: 'text-rose-600 dark:text-rose-400',
            badgeBg: 'bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-900/60 shadow-xs shadow-rose-500/10',
            ringStart: '#f43f5e',
            ringEnd: '#e11d48',
            pulseColor: 'bg-rose-500',
            panelBg: 'bg-rose-50 dark:bg-rose-950/30 border-rose-200/80 dark:border-rose-900/50 text-rose-700 dark:text-rose-300',
            dashOffset: 45,
            icon: ShieldAlert,
        };
    }
    if (raw === '中' || raw.includes('中') || raw.toLowerCase().includes('med')) {
        return {
            level: '中风险',
            scoreText: raw,
            color: 'text-amber-600 dark:text-amber-400',
            badgeBg: 'bg-amber-50 dark:bg-amber-950/50 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-900/60 shadow-xs shadow-amber-500/10',
            ringStart: '#fbbf24',
            ringEnd: '#f59e0b',
            pulseColor: 'bg-amber-500',
            panelBg: 'bg-amber-50 dark:bg-amber-950/30 border-amber-200/80 dark:border-amber-900/50 text-amber-700 dark:text-amber-300',
            dashOffset: 120,
            icon: AlertTriangle,
        };
    }
    return {
        level: raw === '低' ? '低风险' : (raw || '安全正常'),
        scoreText: raw || '安全',
        color: 'text-emerald-600 dark:text-emerald-400',
        badgeBg: 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/60 shadow-xs shadow-emerald-500/10',
        ringStart: '#34d399',
        ringEnd: '#059669',
        pulseColor: 'bg-emerald-500',
        panelBg: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200/80 dark:border-emerald-900/50 text-emerald-700 dark:text-emerald-300',
        dashOffset: 190,
        icon: ShieldCheck,
    };
};

/** 提取风险标签（subItems / 风险细项） */
export const getRiskTags = (geo?: IpGeoInfo | null): string[] => {
    if (!geo) return [];
    const tags: string[] = [];
    if (geo.sub_items && Array.isArray(geo.sub_items)) {
        for (const item of geo.sub_items) {
            const t = item?.trim();
            if (t && !tags.includes(t)) tags.push(t);
        }
    }
    if (geo.risk_detail) {
        const parts = geo.risk_detail.split(/[,、，\s]+/).filter(Boolean);
        for (const p of parts) {
            const t = p.trim();
            if (t && !tags.includes(t)) tags.push(t);
        }
    }
    return tags;
};

export const IpThreatCard: React.FC<Props> = ({ ip, geo, className = '', compact = false }) => {
    const risk = getRiskMeta(geo?.risk_score);
    const ipDesc = describeIp(ip, geo);
    const riskTags = getRiskTags(geo);
    const badge = ipDesc.isIpv6 ? 'IPv6' : (ipDesc.kind === 'public' ? 'IPv4 公网' : '内网/本地');
    const typeLabel = ipDesc.isIpv6 ? 'IPv6 公网' : (ipDesc.kind === 'public' ? 'IPv4 公网' : ipDesc.detail || '本地/私有');

    // 格式化归属地
    const locationParts = [geo?.country, geo?.region, geo?.city].filter(Boolean);
    const locationStr = locationParts.length > 0 ? locationParts.join(' · ') : '未知地区';

    // 运营商与场景
    const rawIsp = geo?.isp ? geo.isp.replace(/（.*?）/g, '').trim() : '未知运营商';
    const scene = geo?.scene || (geo?.isp?.match(/（(.*?)）/)?.[1]) || '通用网络';
    const risks = geo?.risk_detail || (risk.level.includes('高') ? '疑似代理 / 恶意爬虫特征' : risk.level.includes('中') ? '存在异常访问特征' : '未检测到恶意行为 · 状态合规');

    const RiskIcon = risk.icon;

    return (
        <div
            className={`w-[360px] max-w-[92vw] bg-white dark:bg-slate-900 rounded-xl border border-slate-200/90 dark:border-slate-800 shadow-2xl dark:shadow-black/70 overflow-hidden text-left ${
                compact ? 'p-3' : 'p-3.5'
            } ${className}`}
        >
            {/* 顶栏 Header */}
            <div className="flex items-center justify-between gap-2 pb-2.5 mb-2.5 border-b border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                    {/* 呼吸状态灯 */}
                    <span className="relative flex h-2 w-2 shrink-0">
                        <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${risk.pulseColor}`} />
                        <span className={`relative inline-flex rounded-full h-2 w-2 ${risk.pulseColor}`} />
                    </span>

                    {/* IP 地址 */}
                    <span
                        className="font-mono font-bold text-xs tracking-tight text-slate-900 dark:text-slate-100 truncate select-all"
                        title={ip}
                    >
                        {ip.length > 26 ? `${ip.slice(0, 13)}...${ip.slice(-9)}` : ip}
                    </span>

                    {/* 网络协议小标签 */}
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 shrink-0">
                        {badge}
                    </span>
                </div>

                {/* 风险评级徽标 */}
                <div className="flex items-center shrink-0">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${risk.badgeBg}`}>
                        <RiskIcon size={12} className="shrink-0" />
                        <span>{risk.level}</span>
                    </span>
                </div>
            </div>

            {/* 核心排版：整行展示归属地与运营商，告别截断 */}
            <div className="space-y-2 py-0.5">
                {/* 归属地 */}
                <div className="flex items-start gap-2.5 text-xs">
                    <div className="mt-0.5 p-1 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-500 shrink-0">
                        <MapPin size={12} />
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="text-[10px] text-slate-400 dark:text-slate-500 font-medium leading-none mb-0.5">地理位置</div>
                        <div className="text-slate-800 dark:text-slate-200 font-medium leading-snug break-words" title={locationStr}>
                            {locationStr}
                        </div>
                    </div>
                </div>

                {/* 运营商 */}
                <div className="flex items-start gap-2.5 text-xs">
                    <div className="mt-0.5 p-1 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-500 shrink-0">
                        <Building2 size={12} />
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="text-[10px] text-slate-400 dark:text-slate-500 font-medium leading-none mb-0.5">网络服务商 (ISP)</div>
                        <div className="text-slate-800 dark:text-slate-200 font-medium leading-snug break-words" title={rawIsp}>
                            {rawIsp}
                        </div>
                    </div>
                </div>
            </div>

            {/* 元数据微胶囊标签行 */}
            <div className="flex items-center gap-1.5 mt-2.5 pt-2 border-t border-slate-100 dark:border-slate-800 text-[10px] flex-wrap">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-50 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400 border border-slate-200/60 dark:border-slate-700/60">
                    <Radio size={10} className="text-slate-400" />
                    <span>{scene}</span>
                </span>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-50 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400 border border-slate-200/60 dark:border-slate-700/60">
                    <Network size={10} className="text-slate-400" />
                    <span>{typeLabel}</span>
                </span>
                {riskTags.map((tag, idx) => (
                    <span
                        key={idx}
                        className={`inline-flex items-center px-1.5 py-0.5 rounded font-medium border ${risk.badgeBg}`}
                    >
                        {tag}
                    </span>
                ))}
                <span className="ml-auto inline-flex items-center gap-0.5 text-slate-400 dark:text-slate-500">
                    <Shield size={10} />
                    <span>威胁画像</span>
                </span>
            </div>

            {/* 底部研判条 */}
            <div className={`mt-2 px-2.5 py-1.5 rounded-lg border flex items-center justify-between gap-2 text-xs ${risk.panelBg}`}>
                <div className="flex items-center gap-1.5 min-w-0 truncate">
                    <RiskIcon size={13} className="shrink-0" />
                    <span className="font-semibold truncate text-[11px]">{risks}</span>
                </div>
                {geo?.risk_score && (
                    <span className="text-[10px] font-mono opacity-80 shrink-0">
                        评分: {geo.risk_score}
                    </span>
                )}
            </div>
        </div>
    );
};

export default IpThreatCard;
