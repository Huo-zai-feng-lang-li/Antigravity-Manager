import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Search, Trash2, ShieldOff, ShieldCheck, AlertTriangle, X, Power } from 'lucide-react';
import ModalDialog from '../common/ModalDialog';
import { showToast } from '../common/ToastContainer';
import { request as invoke } from '../../utils/request';
import { useIpRuleList } from './useIpRuleList';
import { isValidIpPattern, remainingTime } from '../../utils/ipFormat';
import ClickableIp from './ClickableIp';
import { EXPIRY_PRESETS, type IpBlacklistEntry, type RuleListType, type IpWhitelistEntry, type SecurityMonitorConfig } from '../../types/security';

interface Props {
    type: RuleListType;
    refreshKey?: number;
}

/** 过期选择：预设值或 'custom' */
type ExpiryChoice = number | 'custom';

const AddRuleModal: React.FC<{
    type: RuleListType;
    busy: boolean;
    onClose: () => void;
    onSubmit: (params: { ipPattern: string; note: string | null; expiresAt: number | null }) => Promise<boolean>;
}> = ({ type, busy, onClose, onSubmit }) => {
    const { t } = useTranslation();
    const isBlack = type === 'blacklist';
    const [ip, setIp] = useState('');
    const [note, setNote] = useState('');
    const [choice, setChoice] = useState<ExpiryChoice>(0);
    const [customHours, setCustomHours] = useState(24);

    const ipValid = useMemo(() => isValidIpPattern(ip), [ip]);
    const showIpError = ip.trim().length > 0 && !ipValid;

    const buildExpiresAt = (): number | null => {
        if (!isBlack) return null;
        const hours = choice === 'custom' ? customHours : choice;
        if (!hours || hours <= 0) return null;
        return Math.floor(Date.now() / 1000) + hours * 3600;
    };

    const handleConfirm = async () => {
        if (!ipValid) {
            showToast(t('security.rules.error_invalid'), 'error');
            return;
        }
        const ok = await onSubmit({
            ipPattern: ip.trim(),
            note: note.trim() || null,
            expiresAt: buildExpiresAt(),
        });
        if (ok) onClose();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div className="bg-white dark:bg-base-100 rounded-lg shadow-xl w-full max-w-md p-6">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-lg font-bold">
                        {isBlack ? t('security.blacklist.add_title') : t('security.whitelist.add_title')}
                    </h3>
                    <button onClick={onClose} className="btn btn-ghost btn-sm btn-circle"><X size={18} /></button>
                </div>

                <div className="space-y-4">
                    <div>
                        <label className="label">{t('security.rules.ip_label')}</label>
                        <input
                            type="text"
                            className={`input input-bordered w-full font-mono ${showIpError ? 'input-error' : ''}`}
                            placeholder="192.168.1.0/24, 8.8.8.8, 240e::/32"
                            value={ip}
                            autoFocus
                            onChange={e => setIp(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleConfirm()}
                        />
                        {showIpError && (
                            <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
                                <AlertTriangle size={12} /> {t('security.rules.error_invalid')}
                            </p>
                        )}
                        <p className="text-xs text-gray-400 mt-1">{t('security.rules.ip_hint')}</p>
                    </div>

                    <div>
                        <label className="label">{isBlack ? t('security.rules.reason_label') : t('security.rules.description_label')}</label>
                        <input
                            type="text"
                            className="input input-bordered w-full"
                            value={note}
                            onChange={e => setNote(e.target.value)}
                        />
                    </div>

                    {isBlack && (
                        <div>
                            <label className="label">{t('security.rules.expiry_label')}</label>
                            <select
                                className="select select-bordered w-full"
                                value={String(choice)}
                                onChange={e => setChoice(e.target.value === 'custom' ? 'custom' : Number(e.target.value))}
                            >
                                {EXPIRY_PRESETS.map(p => (
                                    <option key={p.value} value={p.value}>{t(p.i18nKey)}</option>
                                ))}
                                <option value="custom">{t('security.rules.expiry_custom')}</option>
                            </select>
                            {choice === 'custom' && (
                                <div className="mt-2 flex items-center gap-2">
                                    <input
                                        type="number"
                                        min={1}
                                        className="input input-bordered input-sm w-28"
                                        value={customHours}
                                        onChange={e => setCustomHours(Math.max(1, Number(e.target.value) || 1))}
                                    />
                                    <span className="text-sm text-gray-500">{t('security.rules.expiry_hours_unit')}</span>
                                </div>
                            )}
                        </div>
                    )}

                    <div className="flex justify-end gap-3 mt-6">
                        <button className="px-4 py-2 bg-gray-100 dark:bg-base-200 text-gray-700 dark:text-gray-300 text-sm font-medium rounded-lg hover:bg-gray-200 dark:hover:bg-base-300" onClick={onClose}>
                            {t('security.rules.cancel')}
                        </button>
                        <button
                            className={`px-4 py-2 text-white text-sm font-medium rounded-lg shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed ${isBlack ? 'bg-red-500 hover:bg-red-600 shadow-red-500/20' : 'bg-emerald-500 hover:bg-emerald-600 shadow-emerald-500/20'}`}
                            onClick={handleConfirm}
                            disabled={!ipValid || busy}
                        >
                            {t('security.rules.add_btn')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export const IpRuleManager: React.FC<Props> = ({ type, refreshKey }) => {
    const { t } = useTranslation();
    const isBlack = type === 'blacklist';
    const { filtered, loading, busy, search, setSearch, addRule, removeRule, clearAll } =
        useIpRuleList(type, refreshKey);

    const [addOpen, setAddOpen] = useState(false);
    const [pendingDelete, setPendingDelete] = useState<string | null>(null);
    const [confirmClear, setConfirmClear] = useState(false);
    const [securityConfig, setSecurityConfig] = useState<SecurityMonitorConfig | null>(null);
    const [switching, setSwitching] = useState(false);

    const loadSecurityConfig = async () => {
        try {
            const data = await invoke<SecurityMonitorConfig>('get_security_config');
            setSecurityConfig(data);
        } catch (e) {
            console.error('Failed to load security config', e);
        }
    };

    useEffect(() => {
        loadSecurityConfig();
    }, [refreshKey]);

    const switchEnabled = async (enabled: boolean) => {
        if (!securityConfig) return;
        setSwitching(true);
        try {
            const next: SecurityMonitorConfig = {
                ...securityConfig,
                blacklist: { ...securityConfig.blacklist, enabled: isBlack ? enabled : securityConfig.blacklist.enabled },
                whitelist: { ...securityConfig.whitelist, enabled: !isBlack ? enabled : securityConfig.whitelist.enabled },
            };
            await invoke('update_security_config', { config: next });
            setSecurityConfig(next);
            showToast(t('security.config.save_success'), 'success');
        } catch (e) {
            console.error('Failed to toggle switch', e);
            showToast(t('security.rules.error_switch'), 'error');
        } finally {
            setSwitching(false);
        }
    };

    const switchOn = isBlack ? securityConfig?.blacklist.enabled : securityConfig?.whitelist.enabled;

    const accent = isBlack
        ? { border: 'border-red-100 dark:border-red-900/30', icon: <ShieldOff size={20} className="text-red-500" />, ip: 'text-red-700 dark:text-red-400' }
        : { border: 'border-green-100 dark:border-green-900/30', icon: <ShieldCheck size={20} className="text-green-500" />, ip: 'text-green-700 dark:text-green-400' };

    const confirmDelete = async () => {
        if (pendingDelete) {
            await removeRule(pendingDelete);
            setPendingDelete(null);
        }
    };

    return (
        <div className="flex flex-col h-full bg-white dark:bg-base-100 rounded-xl">
            {securityConfig && !switchOn && (
                <div className={`m-4 mb-0 border text-sm rounded-lg p-3 flex items-start gap-2 ${
                    isBlack
                        ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
                        : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300'
                }`}>
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                    <div className="flex-1">
                        {isBlack ? t('security.rules.blacklist_disabled_warning') : t('security.rules.whitelist_disabled_hint')}
                    </div>
                    <button
                        className="btn btn-sm btn-primary gap-1 shrink-0"
                        disabled={switching}
                        onClick={() => switchEnabled(true)}
                    >
                        <Power size={13} /> {t('security.rules.enable_now')}
                    </button>
                </div>
            )}
            {!isBlack && switchOn && filtered.length === 0 && !loading && (
                <div className="m-4 mb-0 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm rounded-lg p-3 flex items-start gap-2">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                    {t('security.rules.whitelist_empty_warning')}
                </div>
            )}

            <div className="p-5 border-b border-gray-100 dark:border-base-200 flex items-center gap-3 flex-wrap">
                <button
                    onClick={() => setAddOpen(true)}
                    className={`px-4 py-2 text-white text-sm font-medium rounded-lg flex items-center gap-2 shadow-sm ${isBlack ? 'bg-red-500 hover:bg-red-600' : 'bg-emerald-500 hover:bg-emerald-600'}`}
                >
                    <Plus size={16} /> {isBlack ? t('security.blacklist.add_ip') : t('security.whitelist.add_ip')}
                </button>

                <div className="relative flex-1 max-w-md min-w-[180px]">
                    <Search className="absolute left-3 top-2.5 text-gray-400" size={16} />
                    <input
                        type="text"
                        placeholder={t('security.rules.search_placeholder')}
                        className="input input-sm input-bordered w-full pl-9"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                    />
                </div>

                <div className="flex-1" />

                {filtered.length > 0 && (
                    <button
                        onClick={() => setConfirmClear(true)}
                        className="btn btn-sm btn-ghost text-red-500 gap-1"
                        disabled={busy}
                    >
                        <Trash2 size={15} /> {t('security.rules.clear_all')}
                    </button>
                )}
            </div>

            <div className="flex-1 overflow-auto p-4">
                {loading ? (
                    <div className="text-center py-10"><span className="loading loading-spinner" /></div>
                ) : filtered.length === 0 ? (
                    <div className="text-center py-12 text-gray-400">
                        {isBlack ? t('security.blacklist.no_data') : t('security.whitelist.no_data')}
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {filtered.map(entry => {
                            const black = isBlack ? (entry as IpBlacklistEntry) : null;
                            const white = !isBlack ? (entry as IpWhitelistEntry) : null;
                            const remaining = black ? remainingTime(black.expires_at) : null;
                            return (
                                <div key={entry.ip_pattern} className={`bg-white dark:bg-base-100 border ${accent.border} rounded-lg p-4 shadow-sm hover:shadow-md transition-shadow`}>
                                    <div className="flex items-start justify-between mb-2">
                                        <h3 className="break-all">
                                            <ClickableIp
                                                ip={entry.ip_pattern}
                                                compact={false}
                                                textClassName={`font-mono font-bold ${accent.ip}`}
                                            />
                                        </h3>
                                        <button
                                            onClick={() => setPendingDelete(entry.ip_pattern)}
                                            className="btn btn-ghost btn-xs text-red-500 shrink-0"
                                            title={t('security.rules.remove')}
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>

                                    {black?.reason && (
                                        <p className="text-sm text-gray-600 dark:text-gray-400 mb-1 break-all">{black.reason}</p>
                                    )}
                                    {white?.description && (
                                        <p className="text-sm text-gray-600 dark:text-gray-400 mb-1 break-all">{white.description}</p>
                                    )}

                                    <div className="text-xs text-gray-400 flex flex-col gap-1 mt-3 pt-3 border-t border-gray-50 dark:border-base-200">
                                        <span>{t('security.rules.added_at')}: {new Date(entry.created_at * 1000).toLocaleString()}</span>
                                        {isBlack && (
                                            <>
                                                <span>{t('security.rules.hit_count')}: {black?.hit_count ?? 0}</span>
                                                {black?.expires_at && (
                                                    remaining ? (
                                                        <span className="text-orange-500">{t('security.rules.remaining')}: {remaining}</span>
                                                    ) : (
                                                        <span className="text-gray-400">{t('security.rules.expired')}</span>
                                                    )
                                                )}
                                            </>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {addOpen && (
                <AddRuleModal
                    type={type}
                    busy={busy}
                    onClose={() => setAddOpen(false)}
                    onSubmit={async ({ ipPattern, note, expiresAt }) => {
                        const ok = isBlack
                            ? await addRule({ ipPattern, reason: note, expiresAt })
                            : await addRule({ ipPattern, description: note });
                        // 后端在新增黑名单时会自动开启总开关，刷新本地配置让警告条消失
                        if (ok) await loadSecurityConfig();
                        return ok;
                    }}
                />
            )}

            <ModalDialog
                isOpen={pendingDelete !== null}
                title={t('security.rules.remove_title')}
                message={t('security.rules.remove_confirm', { ip: pendingDelete ?? '' })}
                isDestructive
                confirmText={t('security.rules.remove')}
                onConfirm={confirmDelete}
                onCancel={() => setPendingDelete(null)}
            />

            <ModalDialog
                isOpen={confirmClear}
                title={t('security.rules.clear_title')}
                message={isBlack ? t('security.rules.clear_black_confirm') : t('security.rules.clear_white_confirm')}
                isDestructive
                confirmText={t('security.rules.clear_all')}
                onConfirm={async () => {
                    await clearAll();
                    setConfirmClear(false);
                }}
                onCancel={() => setConfirmClear(false)}
            />
        </div>
    );
};
