import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, AlertTriangle, Trash2, ChevronDown, ChevronRight, Power, RefreshCw } from 'lucide-react';
import { request as invoke } from '../../utils/request';
import Pagination from '../common/Pagination';
import ModalDialog from '../common/ModalDialog';
import { showToast } from '../common/ToastContainer';
import { describeIp, classifyIp, compactIp } from '../../utils/ipFormat';
import type { IpAccessLog, IpAccessLogResponse } from '../../types/security';

interface Props {
    /** 外部传入的只看拦截筛选（统计页跳转用） */
    initialBlockedOnly?: boolean;
    refreshKey?: number;
}

export const IpAccessLogs: React.FC<Props> = ({ initialBlockedOnly = false, refreshKey }) => {
    const { t } = useTranslation();
    const [logs, setLogs] = useState<IpAccessLog[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(50);
    const [searchInput, setSearchInput] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [blockedOnly, setBlockedOnly] = useState(initialBlockedOnly);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [confirmClear, setConfirmClear] = useState(false);
    const [loggingEnabled, setLoggingEnabled] = useState<boolean | null>(null);
    const [enabling, setEnabling] = useState(false);
    const enrichTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** 每个查询周期最多补刷一次归属地，离线/限流时不退化为轮询 */
    const enrichScheduledRef = useRef(false);

    // 外部跳转参数同步
    useEffect(() => {
        setBlockedOnly(initialBlockedOnly);
        setPage(1);
    }, [initialBlockedOnly]);

    // 350ms 防抖，避免 onBlur + 回车双发
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedSearch(searchInput.trim());
            setPage(1);
        }, 350);
        return () => clearTimeout(timer);
    }, [searchInput]);

    const loadLogs = useCallback(async (isEnrichRetry = false) => {
        setLoading(true);
        setError(null);
        try {
            const res = await invoke<IpAccessLogResponse>('get_ip_access_logs', {
                page,
                pageSize,
                search: debouncedSearch || undefined,
                blockedOnly,
            });
            setLogs(res.logs || []);
            setTotal(res.total || 0);

            // GeoIP 为后台异步补全：每个查询周期最多静默补刷一次，
            // 离线/限流导致仍缺归属地时不再重试（服务端失败缓存 1h），避免轮询。
            const hasPendingGeo = (res.logs || []).some(
                log => !log.geo && classifyIp(log.client_ip) === 'public',
            );
            if (hasPendingGeo && !isEnrichRetry && !enrichScheduledRef.current) {
                enrichScheduledRef.current = true;
                if (enrichTimer.current) clearTimeout(enrichTimer.current);
                enrichTimer.current = setTimeout(() => loadLogs(true), 1800);
            }
        } catch (e) {
            console.error('Failed to load logs', e);
            setError(String(e));
        } finally {
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [page, pageSize, debouncedSearch, blockedOnly, refreshKey]);

    useEffect(() => {
        enrichScheduledRef.current = false;
        loadLogs();
        return () => {
            if (enrichTimer.current) clearTimeout(enrichTimer.current);
        };
    }, [loadLogs]);

    // 读取日志总开关状态（用于空态引导）
    useEffect(() => {
        invoke<any>('load_config')
            .then(config => setLoggingEnabled(!!config?.proxy?.enable_logging))
            .catch(() => setLoggingEnabled(true));
    }, [refreshKey]);

    const enableLogging = async () => {
        setEnabling(true);
        try {
            const config = await invoke<any>('load_config');
            config.proxy.enable_logging = true;
            await invoke('save_config', { config });
            await invoke('set_proxy_monitor_enabled', { enabled: true });
            setLoggingEnabled(true);
            showToast(t('security.logs.logging_enabled'), 'success');
            loadLogs();
        } catch (e) {
            console.error(e);
            showToast(t('security.logs.logging_enable_failed'), 'error');
        } finally {
            setEnabling(false);
        }
    };

    const handleClear = async () => {
        try {
            await invoke('clear_ip_access_logs');
            setLogs([]);
            setTotal(0);
            setPage(1);
            setConfirmClear(false);
            showToast(t('security.logs.clear_success'), 'success');
        } catch (e) {
            showToast(String(e), 'error');
        }
    };

    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const emptyState = useMemo(() => {
        if (error) {
            return (
                <div className="text-center py-12 space-y-3">
                    <p className="text-red-500">{t('security.logs.load_failed')}</p>
                    <button className="btn btn-sm btn-primary gap-2" onClick={() => loadLogs()}>
                        <RefreshCw size={14} /> {t('security.logs.retry')}
                    </button>
                </div>
            );
        }
        if (loggingEnabled === false) {
            return (
                <div className="text-center py-12 space-y-3">
                    <Power size={36} className="mx-auto text-gray-300" />
                    <p className="text-gray-500">{t('security.logs.logging_off_tip')}</p>
                    <button className="btn btn-sm btn-primary" onClick={enableLogging} disabled={enabling}>
                        {enabling ? t('security.logs.enabling') : t('security.logs.enable_logging')}
                    </button>
                </div>
            );
        }
        if (debouncedSearch || blockedOnly) {
            return <div className="text-center py-12 text-gray-400">{t('security.logs.no_match')}</div>;
        }
        return <div className="text-center py-12 text-gray-400">{t('security.logs.no_logs')}</div>;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [error, loggingEnabled, debouncedSearch, blockedOnly, t, enabling]);

    return (
        <div className="flex flex-col h-full bg-white dark:bg-base-100 rounded-xl">
            <div className="p-4 border-b border-gray-100 dark:border-base-200 flex flex-wrap items-center gap-4">
                <div className="relative flex-1 min-w-[200px] max-w-md">
                    <Search className="absolute left-3 top-2.5 text-gray-400" size={16} />
                    <input
                        type="text"
                        placeholder={t('security.logs.search_placeholder')}
                        className="input input-sm input-bordered w-full pl-9"
                        value={searchInput}
                        onChange={e => setSearchInput(e.target.value)}
                    />
                </div>

                <label className="label cursor-pointer gap-2 shrink-0">
                    <span className="label-text text-xs font-bold text-gray-500 uppercase">{t('security.logs.show_blocked_only')}</span>
                    <input
                        type="checkbox"
                        className="toggle toggle-sm toggle-error"
                        checked={blockedOnly}
                        onChange={e => { setBlockedOnly(e.target.checked); setPage(1); }}
                    />
                </label>

                <div className="flex-1" />

                <button className="btn btn-sm btn-ghost text-red-500 gap-1" onClick={() => setConfirmClear(true)}>
                    <Trash2 size={15} /> {t('security.logs.clear')}
                </button>
            </div>

            <div className="flex-1 overflow-auto">
                <table className="table table-xs w-full">
                    <thead className="sticky top-0 bg-gray-100 dark:bg-base-200 z-10 shadow-sm text-gray-600 dark:text-gray-400">
                        <tr>
                            <th className="w-10" />
                            <th className="w-20">{t('security.logs.status')}</th>
                            <th className="w-64">{t('security.logs.ip_address')}</th>
                            <th className="w-24">{t('security.logs.username')}</th>
                            <th className="w-20">{t('security.logs.method')}</th>
                            <th>{t('security.logs.path')}</th>
                            <th className="w-24 text-right">{t('security.logs.duration')}</th>
                            <th className="w-40 text-right">{t('security.logs.time')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {logs.map(log => {
                            const desc = describeIp(log.client_ip, log.geo, t);
                            const open = expandedId === log.id;
                            return (
                                <React.Fragment key={log.id}>
                                    <tr
                                        className={`hover:bg-gray-50 dark:hover:bg-base-200 cursor-pointer ${open ? 'bg-gray-50 dark:bg-base-200' : ''}`}
                                        onClick={() => setExpandedId(open ? null : log.id)}
                                    >
                                        <td className="text-gray-400">
                                            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                        </td>
                                        <td>
                                            {log.blocked ? (
                                                <span className="badge badge-xs badge-error gap-1 text-white">
                                                    <AlertTriangle size={10} /> {t('security.logs.blocked')}
                                                </span>
                                            ) : (
                                                <span className={`badge badge-xs text-white border-none ${log.status && log.status < 400 ? 'badge-success' : 'badge-warning'}`}>
                                                    {log.status || '-'}
                                                </span>
                                            )}
                                        </td>
                                        <td>
                                            <div className="font-mono font-medium leading-tight" title={desc.ip}>{compactIp(desc.ip)}{desc.isIpv6 && <span className="ml-1 text-[10px] text-gray-400">v6</span>}</div>
                                            {desc.detail && <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate max-w-[220px]" title={desc.detail}>{desc.detail}</div>}
                                        </td>
                                        <td className="font-medium text-blue-600 dark:text-blue-400">{log.username || '-'}</td>
                                        <td className="font-bold text-xs">{log.method || '-'}</td>
                                        <td className="max-w-xs truncate text-gray-600 dark:text-gray-400" title={log.path}>{log.path || '-'}</td>
                                        <td className="text-right font-mono">{log.duration ? `${log.duration}ms` : '-'}</td>
                                        <td className="text-right text-xs text-gray-500">{new Date(log.timestamp * 1000).toLocaleString()}</td>
                                    </tr>
                                    {open && (
                                        <tr className="bg-gray-50 dark:bg-base-200">
                                            <td />
                                            <td colSpan={7} className="py-2">
                                                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
                                                    <div><span className="text-gray-400">{t('security.logs.user_agent')}: </span>{log.user_agent || '-'}</div>
                                                    <div><span className="text-gray-400">{t('security.logs.reason')}: </span><span className="text-red-500">{log.block_reason || '-'}</span></div>
                                                    <div className="md:col-span-2 break-all"><span className="text-gray-400">{t('security.logs.path')}: </span>{log.path || '-'}</div>
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            );
                        })}
                        {!loading && logs.length === 0 && (
                            <tr><td colSpan={8}>{emptyState}</td></tr>
                        )}
                    </tbody>
                </table>
                {loading && <div className="text-center py-6"><span className="loading loading-spinner loading-sm" /></div>}
            </div>

            <Pagination
                currentPage={page}
                totalPages={totalPages}
                totalItems={total}
                itemsPerPage={pageSize}
                onPageChange={setPage}
                onPageSizeChange={size => { setPageSize(size); setPage(1); }}
                pageSizeOptions={[20, 50, 100]}
            />

            <ModalDialog
                isOpen={confirmClear}
                title={t('security.logs.clear_title')}
                message={t('security.logs.clear_confirm')}
                isDestructive
                confirmText={t('security.logs.clear')}
                onConfirm={handleClear}
                onCancel={() => setConfirmClear(false)}
            />
        </div>
    );
};
