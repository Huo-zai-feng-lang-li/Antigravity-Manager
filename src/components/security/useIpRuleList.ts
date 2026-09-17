import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request as invoke } from '../../utils/request';
import { showToast } from '../common/ToastContainer';
import type { IpBlacklistEntry, IpWhitelistEntry, RuleListType } from '../../types/security';

export interface AddRuleParams {
    ipPattern: string;
    reason?: string | null;
    description?: string | null;
    /** Unix 秒；null/undefined 表示永久 */
    expiresAt?: number | null;
}

/**
 * 黑白名单共用的数据层：加载、增删、清空、本地过滤。
 * 写操作成功后后端会热刷新内存快照，前端只需重新拉取列表。
 */
export function useIpRuleList(type: RuleListType, refreshKey?: number) {
    const { t } = useTranslation();
    const isBlack = type === 'blacklist';

    const [entries, setEntries] = useState<Array<IpBlacklistEntry | IpWhitelistEntry>>([]);
    const [loading, setLoading] = useState(false);
    const [search, setSearch] = useState('');
    const [busy, setBusy] = useState(false);

    const loadCmd = isBlack ? 'get_ip_blacklist' : 'get_ip_whitelist';
    const addCmd = isBlack ? 'add_ip_to_blacklist' : 'add_ip_to_whitelist';
    const removeCmd = isBlack ? 'remove_ip_from_blacklist' : 'remove_ip_from_whitelist';
    const clearCmd = isBlack ? 'clear_ip_blacklist' : 'clear_ip_whitelist';

    const reload = useCallback(async () => {
        setLoading(true);
        try {
            const data = await invoke<Array<IpBlacklistEntry | IpWhitelistEntry>>(loadCmd);
            setEntries(data || []);
        } catch (e) {
            console.error(`Failed to load ${type}`, e);
            showToast(t('security.rules.load_failed'), 'error');
        } finally {
            setLoading(false);
        }
    }, [loadCmd, t, type]);

    useEffect(() => {
        reload();
    }, [reload, refreshKey]);

    const addRule = useCallback(async (params: AddRuleParams): Promise<boolean> => {
        setBusy(true);
        try {
            const payload = isBlack
                ? { ipPattern: params.ipPattern, reason: params.reason ?? null, expiresAt: params.expiresAt ?? null }
                : { ipPattern: params.ipPattern, description: params.description ?? null };
            await invoke(addCmd, { request: payload });
            await reload();
            showToast(t('security.rules.add_success'), 'success');
            return true;
        } catch (e) {
            console.error(`Failed to add to ${type}`, e);
            const msg = String(e);
            if (msg.includes('UNIQUE')) {
                showToast(t('security.rules.error_duplicate'), 'error');
            } else if (msg.includes('Invalid IP pattern') || msg.includes('400')) {
                showToast(t('security.rules.error_invalid'), 'error');
            } else {
                showToast(t('security.rules.error_add'), 'error');
            }
            return false;
        } finally {
            setBusy(false);
        }
    }, [addCmd, isBlack, reload, t, type]);

    const removeRule = useCallback(async (ipPattern: string): Promise<boolean> => {
        setBusy(true);
        try {
            await invoke(removeCmd, { ipPattern });
            setEntries(prev => prev.filter(e => e.ip_pattern !== ipPattern));
            showToast(t('security.rules.remove_success'), 'success');
            return true;
        } catch (e) {
            console.error(`Failed to remove from ${type}`, e);
            showToast(t('security.rules.error_remove'), 'error');
            await reload();
            return false;
        } finally {
            setBusy(false);
        }
    }, [removeCmd, reload, t, type]);

    const clearAll = useCallback(async (): Promise<boolean> => {
        setBusy(true);
        try {
            await invoke(clearCmd);
            setEntries([]);
            showToast(t('security.rules.clear_success'), 'success');
            return true;
        } catch (e) {
            console.error(`Failed to clear ${type}`, e);
            showToast(t('security.rules.error_clear'), 'error');
            await reload();
            return false;
        } finally {
            setBusy(false);
        }
    }, [clearCmd, reload, t, type]);

    const filtered = useMemo(() => {
        const keyword = search.trim().toLowerCase();
        if (!keyword) return entries;
        return entries.filter(e => {
            if (e.ip_pattern.toLowerCase().includes(keyword)) return true;
            const note = isBlack
                ? (e as IpBlacklistEntry).reason
                : (e as IpWhitelistEntry).description;
            return !!note && note.toLowerCase().includes(keyword);
        });
    }, [entries, search, isBlack]);

    return {
        entries,
        filtered,
        loading,
        busy,
        search,
        setSearch,
        reload,
        addRule,
        removeRule,
        clearAll,
    };
}
