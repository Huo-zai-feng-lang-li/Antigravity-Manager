import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, AlertTriangle, Shield, ShieldCheck, Globe, Network, Plus } from 'lucide-react';
import { request as invoke } from '../../utils/request';
import { showToast } from '../common/ToastContainer';
import ModalDialog from '../common/ModalDialog';
import { displayIp } from '../../utils/ipFormat';
import type { SecurityMonitorConfig, WhoAmIResponse, IpWhitelistEntry } from '../../types/security';

/** 兼容旧版本配置（缺少新字段时补默认值） */
function withDefaults(data: Partial<SecurityMonitorConfig>): SecurityMonitorConfig {
    return {
        blacklist: { enabled: false, block_message: '', ...data.blacklist },
        whitelist: { enabled: false, whitelist_priority: true, ...data.whitelist },
        trust_proxy_headers: data.trust_proxy_headers ?? false,
        geoip_enabled: data.geoip_enabled ?? true,
    };
}

export const SecurityConfig: React.FC = () => {
    const { t } = useTranslation();
    const [config, setConfig] = useState<SecurityMonitorConfig | null>(null);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [whoami, setWhoami] = useState<WhoAmIResponse | null>(null);
    const [whitelistCount, setWhitelistCount] = useState(0);
    const [confirmWhitelist, setConfirmWhitelist] = useState(false);

    const loadConfig = async () => {
        setLoading(true);
        try {
            const data = await invoke<SecurityMonitorConfig>('get_security_config');
            setConfig(withDefaults(data || {}));
        } catch (e) {
            console.error('Failed to load security config', e);
            showToast(t('security.config.load_error'), 'error');
        } finally {
            setLoading(false);
        }
    };

    const loadExtras = async () => {
        try {
            const [who, list] = await Promise.all([
                invoke<WhoAmIResponse>('get_my_ip'),
                invoke<IpWhitelistEntry[]>('get_ip_whitelist'),
            ]);
            setWhoami(who);
            setWhitelistCount(list?.length ?? 0);
        } catch (e) {
            console.error('Failed to load whoami/whitelist', e);
        }
    };

    useEffect(() => {
        loadConfig();
        loadExtras();
    }, []);

    const handleSave = async () => {
        if (!config) return;
        setSaving(true);
        try {
            await invoke('update_security_config', { config });
            showToast(t('security.config.save_success'), 'success');
        } catch (e) {
            console.error('Failed to save security config', e);
            showToast(t('security.config.save_error'), 'error');
        } finally {
            setSaving(false);
        }
    };

    const toggleWhitelist = (checked: boolean) => {
        if (!config) return;
        if (checked && whitelistCount === 0) {
            setConfirmWhitelist(true);
            return;
        }
        setConfig({ ...config, whitelist: { ...config.whitelist, enabled: checked } });
    };

    const addMyIpToWhitelist = async () => {
        if (!whoami) return;
        try {
            await invoke('add_ip_to_whitelist', {
                request: { ipPattern: whoami.ip, description: t('security.config.my_ip_desc') },
            });
            showToast(t('security.rules.add_success'), 'success');
            const list = await invoke<IpWhitelistEntry[]>('get_ip_whitelist');
            setWhitelistCount(list?.length ?? 0);
        } catch (e) {
            showToast(String(e), 'error');
        }
    };

    if (loading) {
        return <div className="p-10 text-center"><span className="loading loading-spinner" /></div>;
    }
    if (!config) {
        return <div className="p-10 text-center text-error">{t('security.config.load_error')}</div>;
    }

    return (
        <div className="p-6 max-w-4xl mx-auto space-y-6 h-full overflow-y-auto">
            <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold">{t('security.config.title')}</h2>
                <button onClick={handleSave} className="btn btn-primary gap-2" disabled={saving}>
                    {saving ? <span className="loading loading-spinner loading-xs" /> : <Save size={18} />}
                    {saving ? t('security.config.saving') : t('security.config.save')}
                </button>
            </div>

            {/* 黑名单 */}
            <div className="card bg-base-100 border border-gray-200 dark:border-base-300 shadow-sm">
                <div className="card-body">
                    <h3 className="card-title flex items-center gap-2 text-red-500">
                        <Shield size={24} />
                        {t('security.config.blacklist_title')}
                    </h3>
                    <p className="text-sm text-gray-500">{t('security.config.blacklist_desc')}</p>

                    <label className="label cursor-pointer justify-start gap-4">
                        <input
                            type="checkbox"
                            className="toggle toggle-error"
                            checked={config.blacklist.enabled}
                            onChange={e => setConfig({ ...config, blacklist: { ...config.blacklist, enabled: e.target.checked } })}
                        />
                        <span className="label-text font-medium">{t('security.config.enable_blacklist')}</span>
                    </label>

                    <div className="form-control w-full mt-2">
                        <label className="label">
                            <span className="label-text">{t('security.config.block_msg_label')}</span>
                        </label>
                        <input
                            type="text"
                            className="input input-bordered w-full"
                            value={config.blacklist.block_message}
                            placeholder={t('security.config.block_msg_placeholder')}
                            onChange={e => setConfig({ ...config, blacklist: { ...config.blacklist, block_message: e.target.value } })}
                        />
                        <label className="label">
                            <span className="label-text-alt text-gray-400">{t('security.config.block_msg_desc')}</span>
                        </label>
                    </div>
                </div>
            </div>

            {/* 白名单 */}
            <div className="card bg-base-100 border border-gray-200 dark:border-base-300 shadow-sm">
                <div className="card-body">
                    <h3 className="card-title flex items-center gap-2 text-green-500">
                        <ShieldCheck size={24} />
                        {t('security.config.whitelist_title')}
                    </h3>
                    <p className="text-sm text-gray-500">{t('security.config.whitelist_desc')}</p>

                    {/* whoami 防自锁卡片 */}
                    {whoami && (
                        <div className="flex items-center justify-between gap-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-3">
                            <div className="text-sm">
                                <div className="font-medium">{t('security.config.your_ip')}</div>
                                <div className="font-mono text-green-700 dark:text-green-300">
                                    {displayIp(whoami.ip)}
                                    <span className="ml-2 text-xs text-gray-500">{whoami.ipVersion}{whoami.loopback ? ` · ${t('security.ip_kind.loopback')}` : ''}</span>
                                </div>
                            </div>
                            {!whoami.loopback && (
                                <button className="btn btn-sm btn-success gap-1" onClick={addMyIpToWhitelist}>
                                    <Plus size={14} /> {t('security.config.add_my_ip')}
                                </button>
                            )}
                        </div>
                    )}

                    <label className="label cursor-pointer justify-start gap-4">
                        <input
                            type="checkbox"
                            className="toggle toggle-success"
                            checked={config.whitelist.enabled}
                            onChange={e => toggleWhitelist(e.target.checked)}
                        />
                        <span className="label-text font-medium">{t('security.config.enable_whitelist')}</span>
                    </label>
                    {config.whitelist.enabled && whitelistCount === 0 && (
                        <div className="text-xs text-red-600 dark:text-red-400 ml-14 bg-red-50 dark:bg-red-900/20 p-2 rounded flex items-start gap-2">
                            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                            {t('security.config.whitelist_empty_danger')}
                        </div>
                    )}

                    <label className="label cursor-pointer justify-start gap-4 mt-2">
                        <input
                            type="checkbox"
                            className="checkbox checkbox-success"
                            checked={config.whitelist.whitelist_priority}
                            disabled={!config.whitelist.enabled}
                            onChange={e => setConfig({ ...config, whitelist: { ...config.whitelist, whitelist_priority: e.target.checked } })}
                        />
                        <span className="label-text font-medium">{t('security.config.whitelist_priority')}</span>
                    </label>
                    <p className="text-xs text-gray-400 ml-9">{t('security.config.whitelist_priority_desc')}</p>
                </div>
            </div>

            {/* 网络与归属地 */}
            <div className="card bg-base-100 border border-gray-200 dark:border-base-300 shadow-sm">
                <div className="card-body space-y-4">
                    <h3 className="card-title flex items-center gap-2 text-blue-500">
                        <Network size={24} />
                        {t('security.config.network_title')}
                    </h3>

                    <label className="flex items-start gap-4 cursor-pointer">
                        <input
                            type="checkbox"
                            className="toggle toggle-sm mt-1"
                            checked={config.trust_proxy_headers}
                            onChange={e => setConfig({ ...config, trust_proxy_headers: e.target.checked })}
                        />
                        <div>
                            <div className="label-text font-medium flex items-center gap-2">
                                <Network size={15} /> {t('security.config.trust_proxy_title')}
                            </div>
                            <p className="text-xs text-gray-400 mt-1">{t('security.config.trust_proxy_desc')}</p>
                        </div>
                    </label>

                    <label className="flex items-start gap-4 cursor-pointer">
                        <input
                            type="checkbox"
                            className="toggle toggle-sm mt-1"
                            checked={config.geoip_enabled}
                            onChange={e => setConfig({ ...config, geoip_enabled: e.target.checked })}
                        />
                        <div>
                            <div className="label-text font-medium flex items-center gap-2">
                                <Globe size={15} /> {t('security.config.geoip_title')}
                            </div>
                            <p className="text-xs text-gray-400 mt-1">{t('security.config.geoip_desc')}</p>
                        </div>
                    </label>
                </div>
            </div>

            <ModalDialog
                isOpen={confirmWhitelist}
                title={t('security.config.whitelist_confirm_title')}
                message={t('security.config.whitelist_confirm_message')}
                isDestructive
                confirmText={t('common.confirm')}
                onConfirm={() => {
                    setConfig(prev => prev ? { ...prev, whitelist: { ...prev.whitelist, enabled: true } } : prev);
                    setConfirmWhitelist(false);
                }}
                onCancel={() => setConfirmWhitelist(false)}
            />
        </div>
    );
};
