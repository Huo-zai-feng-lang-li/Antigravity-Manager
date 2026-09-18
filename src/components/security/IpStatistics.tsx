import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, ShieldAlert, Users, Globe, ShieldOff, ShieldCheck } from 'lucide-react';
import { request as invoke } from '../../utils/request';
import { showToast } from '../common/ToastContainer';
import { formatCompactNumber } from '../../utils/format';
import { describeIp, compactIp } from '../../utils/ipFormat';
import type { IpStatsResponse, IpTokenStats, IpRanking } from '../../types/security';

interface Props {
    refreshKey?: number;
    /** 点击拦截卡片跳转日志（带 blockedOnly） */
    onJumpBlocked?: () => void;
}

const RANGES = [
    { value: 1, key: 'security.stats.hour' },
    { value: 24, key: 'security.stats.day' },
    { value: 168, key: 'security.stats.week' },
    { value: 720, key: 'security.stats.month' },
    { value: 0, key: 'security.stats.all' },
] as const;

export const IpStatistics: React.FC<Props> = ({ refreshKey, onJumpBlocked }) => {
    const { t } = useTranslation();
    const [stats, setStats] = useState<IpStatsResponse | null>(null);
    const [tokenStats, setTokenStats] = useState<IpTokenStats[]>([]);
    const [loading, setLoading] = useState(false);
    const [timeRange, setTimeRange] = useState<number>(24);
    const [whitelisted, setWhitelisted] = useState<Set<string>>(new Set());
    const enrichTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** 每个时间窗周期最多补刷一次归属地，离线/限流时不退化为轮询 */
    const enrichScheduledRef = useRef(false);

    const loadStats = useCallback(async (isEnrichRetry = false, silent = false) => {
        if (!silent) setLoading(true);
        try {
            const hours = timeRange > 0 ? timeRange : undefined;
            const [statsData, tokenData] = await Promise.all([
                invoke<IpStatsResponse>('get_ip_stats', { hours }),
                invoke<IpTokenStats[]>('get_ip_token_stats', { limit: 20, hours: timeRange }),
            ]);
            setStats(statsData);
            setTokenStats(tokenData || []);

            const pendingGeo = [
                ...(statsData?.top_ips || []).filter((r: IpRanking) => !r.geo),
                ...(tokenData || []).filter((r: IpTokenStats) => !r.geo),
            ].some(r => describeIp(r.client_ip, undefined, t).kind === 'public');
            if (pendingGeo && !isEnrichRetry && !enrichScheduledRef.current) {
                enrichScheduledRef.current = true;
                if (enrichTimer.current) clearTimeout(enrichTimer.current);
                enrichTimer.current = setTimeout(() => loadStats(true), 1800);
            }
        } catch (e) {
            console.error('Failed to load stats', e);
        } finally {
            if (!silent) setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [timeRange, refreshKey]);

    useEffect(() => {
        enrichScheduledRef.current = false;
        loadStats();

        let poll: number | null = null;
        let unlistenFocus: (() => void) | null = null;
        let isVisible = document.visibilityState === 'visible';
        let isFocused = true;

        const start = () => {
            if (poll) return;
            poll = setInterval(() => loadStats(false, true), 5000);
        };
        const stop = () => {
            if (poll) { clearInterval(poll); poll = null; }
        };
        const refresh = () => {
            if (isVisible && isFocused) start(); else stop();
        };

        const onVis = () => { isVisible = document.visibilityState === 'visible'; refresh(); };
        document.addEventListener('visibilitychange', onVis);

        import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
            getCurrentWindow().onFocusChanged(({ payload: focused }) => {
                isFocused = focused; refresh();
            }).then(un => { unlistenFocus = un; });
        }).catch(() => {});

        start();
        return () => {
            document.removeEventListener('visibilitychange', onVis);
            if (unlistenFocus) unlistenFocus();
            stop();
            if (enrichTimer.current) clearTimeout(enrichTimer.current);
        };
    }, [loadStats]);

    const addRule = async (ip: string, type: 'blacklist' | 'whitelist') => {
        try {
            if (type === 'blacklist') {
                await invoke('add_ip_to_blacklist', {
                    request: { ipPattern: ip, reason: t('security.rules.from_stats_reason'), expiresAt: null },
                });
                setStats(prev => prev ? {
                    ...prev,
                    top_ips: prev.top_ips.map(r => r.client_ip === ip ? { ...r, is_blocked: true } : r),
                } : prev);
                showToast(t('security.rules.blacklist_auto_enabled'), 'success');
            } else {
                await invoke('add_ip_to_whitelist', { request: { ipPattern: ip, description: null } });
                setWhitelisted(prev => new Set(prev).add(ip));
                showToast(t('security.rules.add_success'), 'success');
            }
        } catch (e) {
            showToast(String(e), 'error');
        }
    };

    const unblock = async (ip: string) => {
        try {
            await invoke('remove_ip_from_blacklist', { ipPattern: ip });
            setStats(prev => prev ? {
                ...prev,
                top_ips: prev.top_ips.map(r => r.client_ip === ip ? { ...r, is_blocked: false } : r),
            } : prev);
            showToast(t('security.rules.remove_success'), 'success');
        } catch (e) {
            showToast(String(e), 'error');
        }
    };

    const rangeLabel = () => {
        const found = RANGES.find(r => r.value === timeRange);
        return found ? t(found.key) : `${timeRange}h`;
    };

    if (loading && !stats) {
        return <div className="p-10 text-center"><span className="loading loading-spinner" /></div>;
    }
    if (!stats) {
        return <div className="p-10 text-center text-gray-500">{t('security.stats.no_data')}</div>;
    }

    const maxReqCount = Math.max(...tokenStats.map(ip => ip.request_count), 1);

    const RuleButtons: React.FC<{ ip: string; blocked?: boolean }> = ({ ip, blocked }) => {
        const isWhite = whitelisted.has(ip);
        return (
            <div className="flex gap-1 justify-end" onClick={e => e.stopPropagation()}>
                {!blocked ? (
                    <button
                        className="btn btn-xs btn-ghost text-red-500 gap-1"
                        title={t('security.rules.add_black')}
                        onClick={() => addRule(ip, 'blacklist')}
                    >
                        <ShieldOff size={13} />
                    </button>
                ) : (
                    <button
                        className="btn btn-xs btn-ghost text-red-400 gap-1 hover:bg-red-50 dark:hover:bg-red-900/20"
                        title={t('security.rules.unblock')}
                        onClick={() => unblock(ip)}
                    >
                        <ShieldOff size={13} />
                        <span className="text-[10px]">{t('security.rules.blocked_tag')}</span>
                    </button>
                )}
                {!isWhite ? (
                    <button
                        className="btn btn-xs btn-ghost text-green-600 gap-1"
                        title={t('security.rules.add_white')}
                        onClick={() => addRule(ip, 'whitelist')}
                    >
                        <ShieldCheck size={13} />
                    </button>
                ) : (
                    <span className="badge badge-xs badge-success gap-1 text-white"><ShieldCheck size={10} />{t('security.rules.whitelisted_tag')}</span>
                )}
            </div>
        );
    };

    return (
        <div className="h-full flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto p-2 space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="stat bg-white dark:bg-base-200 shadow rounded-xl border border-gray-100 dark:border-base-300">
                        <div className="stat-figure text-blue-500"><Activity size={32} /></div>
                        <div className="stat-title">{t('security.stats.total_requests')}</div>
                        <div className="stat-value text-blue-500">{formatCompactNumber(stats.total_requests)}</div>
                        <div className="stat-desc">{rangeLabel()}</div>
                    </div>
                    <div className="stat bg-white dark:bg-base-200 shadow rounded-xl border border-gray-100 dark:border-base-300">
                        <div className="stat-figure text-purple-500"><Users size={32} /></div>
                        <div className="stat-title">{t('security.stats.unique_ips')}</div>
                        <div className="stat-value text-purple-500">{formatCompactNumber(stats.unique_ips)}</div>
                        <div className="stat-desc">{rangeLabel()}</div>
                    </div>
                    <div
                        role="button"
                        tabIndex={0}
                        onClick={onJumpBlocked}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onJumpBlocked?.(); }}
                        className="stat bg-white dark:bg-base-200 shadow rounded-xl border border-gray-100 dark:border-base-300 text-left hover:border-red-300 transition-colors cursor-pointer"
                        title={t('security.stats.jump_blocked_tip')}
                    >
                        <div className="stat-figure text-red-500"><ShieldAlert size={32} /></div>
                        <div className="stat-title">{t('security.stats.blocked_requests')}</div>
                        <div className="stat-value text-red-500">{formatCompactNumber(stats.blocked_requests)}</div>
                        <div className="stat-desc">{t('security.stats.jump_blocked')}</div>
                    </div>
                </div>

                {/* Top IPs（访问排行，含一键拉黑/加白） */}
                <div className="bg-white dark:bg-base-200 rounded-xl shadow-sm border border-gray-100 dark:border-base-300 overflow-hidden">
                    <div className="p-4 border-b border-gray-100 dark:border-base-300 flex items-center gap-2">
                        <Globe size={20} className="text-blue-500" />
                        <h3 className="font-bold text-lg">{t('security.stats.top_ips')} ({rangeLabel()})</h3>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="table w-full">
                            <thead>
                                <tr>
                                    <th className="w-12">{t('security.stats.rank')}</th>
                                    <th>{t('security.stats.ip_address')}</th>
                                    <th>{t('security.stats.location')}</th>
                                    <th className="w-32 text-right">{t('security.stats.request_count')}</th>
                                    <th className="w-40 text-right">{t('security.stats.actions')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {stats.top_ips.map((ip, index) => {
                                    const desc = describeIp(ip.client_ip, ip.geo, t);
                                    return (
                                        <tr key={ip.client_ip} className="hover:bg-gray-50 dark:hover:bg-base-300">
                                            <td className="font-bold text-gray-400">#{index + 1}</td>
                                            <td className="font-mono font-medium" title={desc.ip}>{compactIp(desc.ip)}</td>
                                            <td className="text-xs text-gray-600 dark:text-gray-300">{desc.detail || '-'}</td>
                                            <td className="text-right font-mono">{formatCompactNumber(ip.request_count)}</td>
                                            <td><RuleButtons ip={ip.client_ip} blocked={ip.is_blocked} /></td>
                                        </tr>
                                    );
                                })}
                                {stats.top_ips.length === 0 && (
                                    <tr><td colSpan={5} className="text-center py-8 text-gray-500">{t('security.stats.no_data')}</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Token 消耗活跃度 */}
                <div className="bg-white dark:bg-base-200 rounded-xl shadow-sm border border-gray-100 dark:border-base-300 overflow-hidden">
                    <div className="p-4 border-b border-gray-100 dark:border-base-300 flex items-center justify-between gap-2 flex-wrap">
                        <h3 className="font-bold text-lg">{t('security.stats.ip_activity_token_usage')}</h3>
                        <div className="flex gap-1">
                            {RANGES.map(r => (
                                <button
                                    key={r.value}
                                    className={`btn btn-xs min-w-[48px] ${timeRange === r.value ? 'btn-active btn-primary' : ''}`}
                                    onClick={() => setTimeRange(r.value)}
                                >
                                    {t(r.key)}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="table w-full">
                            <thead>
                                <tr>
                                    <th className="w-12">{t('security.stats.rank')}</th>
                                    <th>{t('security.stats.ip_address')}</th>
                                    <th className="w-24">{t('security.logs.username')}</th>
                                    <th className="w-1/4">{t('security.stats.activity_reqs')}</th>
                                    <th className="text-right">{t('security.stats.total_token')}</th>
                                    <th className="text-right text-xs text-gray-500">{t('security.stats.prompt')}</th>
                                    <th className="text-right text-xs text-gray-500">{t('security.stats.completion')}</th>
                                    <th className="w-40 text-right">{t('security.stats.actions')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {tokenStats.map((ip, index) => {
                                    let colorClass = 'text-green-500';
                                    if (ip.total_tokens > 1000000) colorClass = 'text-red-500 font-bold';
                                    else if (ip.total_tokens > 100000) colorClass = 'text-yellow-500 font-bold';
                                    else if (ip.total_tokens > 10000) colorClass = 'text-blue-500';
                                    const percentage = Math.min(100, Math.max(0, (ip.request_count / maxReqCount) * 100)) || 0;
                                    const blocked = stats.top_ips.find(r => r.client_ip === ip.client_ip)?.is_blocked;
                                    const desc = describeIp(ip.client_ip, ip.geo, t);
                                    return (
                                        <tr key={ip.client_ip} className="hover:bg-gray-50 dark:hover:bg-base-300">
                                            <td className="font-bold text-gray-400">#{index + 1}</td>
                                            <td className="font-mono font-medium" title={desc.ip}>
                                                {compactIp(desc.ip)}
                                                {desc.detail && (
                                                    <div className="text-[11px] text-gray-500 dark:text-gray-400 font-normal">{desc.detail}</div>
                                                )}
                                            </td>
                                            <td className="font-medium text-blue-600 dark:text-blue-400">{ip.username || '-'}</td>
                                            <td>
                                                <div className="flex flex-col gap-1">
                                                    <div className="flex justify-between text-xs text-gray-500">
                                                        <span>{formatCompactNumber(ip.request_count)} reqs</span>
                                                        <span>{Math.round(percentage)}%</span>
                                                    </div>
                                                    <div className="w-full bg-gray-100 dark:bg-base-300 rounded-full h-1.5">
                                                        <div className="bg-blue-500 h-1.5 rounded-full transition-all duration-500" style={{ width: `${percentage}%` }} />
                                                    </div>
                                                </div>
                                            </td>
                                            <td className={`text-right font-mono text-lg ${colorClass}`}>{formatCompactNumber(ip.total_tokens)}</td>
                                            <td className="text-right font-mono text-gray-500 text-xs">{formatCompactNumber(ip.input_tokens)}</td>
                                            <td className="text-right font-mono text-gray-500 text-xs">{formatCompactNumber(ip.output_tokens)}</td>
                                            <td><RuleButtons ip={ip.client_ip} blocked={blocked} /></td>
                                        </tr>
                                    );
                                })}
                                {tokenStats.length === 0 && (
                                    <tr><td colSpan={8} className="text-center py-8 text-gray-500">{t('security.stats.no_data')}</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    );
};
