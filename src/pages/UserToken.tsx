import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, RefreshCw, Copy, Activity, User, Settings, Shield, Clock, Users, HelpCircle, CalendarPlus, CheckCircle2, Search, ChevronRight, Filter } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { request as invoke } from '../utils/request';
import { showToast } from '../components/common/ToastContainer';
import { copyToClipboard } from '../utils/clipboard';
import { formatTokenCount } from '../utils/format';

interface UserToken {
    id: string;
    token: string;
    username: string;
    description?: string;
    enabled: boolean;
    expires_type: string;
    expires_at?: number;
    max_ips: number;
    curfew_start?: string;
    curfew_end?: string;
    daily_quota: number;
    monthly_quota: number;
    daily_used: number;
    monthly_used: number;
    created_at: number;
    updated_at: number;
    last_used_at?: number;
    total_requests: number;
    total_tokens_used: number;
}

interface UserTokenStats {
    total_tokens: number;
    active_tokens: number;
    total_users: number;
    today_requests: number;
}

// 额度预占量：必须与 Rust 后端 user_token_db.rs 的 QUOTA_HOLD_AMOUNT 保持一致。
const QUOTA_HOLD_AMOUNT = 8192;

// 额度填写建议（hover 问号显示）
const QUOTA_HELP_TEXT = `填多少合适？（经验估算，非精确）
• 一次普通短对话：几百 ~ 3000 Token
• 长上下文 / 生成代码：1万 ~ 5万 Token
• 8192 只够 1 次普通请求，适合测试账号
• 10万/天 ≈ 几十次普通对话，个人轻度使用
• 100万/月 ≈ 重度个人或小团队共享
不确定就先填大一点（如 100万），用几天看进度条再调`;

// 每日/每月额度快捷预设
const DAILY_QUOTA_PRESETS = [
    { label: '不限', value: 0 },
    { label: '测试 8192', value: 8192 },
    { label: '个人 10万/天', value: 100000 },
    { label: '重度 50万/天', value: 500000 },
];
const MONTHLY_QUOTA_PRESETS = [
    { label: '不限', value: 0 },
    { label: '10万/月', value: 100000 },
    { label: '团队 100万/月', value: 1000000 },
    { label: '企业 500万/月', value: 5000000 },
];

// Token 状态枚举
type TokenStatus = 'normal' | 'expiring' | 'expired' | 'quota_warning' | 'quota_danger';

// 筛选选项
const FILTER_OPTIONS = [
    { value: 'all', label: '全部' },
    { value: 'active', label: '正常' },
    { value: 'expired', label: '已过期' },
    { value: 'warning', label: '告警' },
] as const;

const UserToken: React.FC = () => {
    const { t } = useTranslation();
    const [tokens, setTokens] = useState<UserToken[]>([]);
    const [stats, setStats] = useState<UserTokenStats | null>(null);
    const [loading, setLoading] = useState(false);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [creating, setCreating] = useState(false);

    // Edit State
    const [showEditModal, setShowEditModal] = useState(false);
    const [editingToken, setEditingToken] = useState<UserToken | null>(null);
    const [editUsername, setEditUsername] = useState('');
    const [editDesc, setEditDesc] = useState('');
    const [editMaxIps, setEditMaxIps] = useState(0);
    const [editCurfewStart, setEditCurfewStart] = useState('');
    const [editCurfewEnd, setEditCurfewEnd] = useState('');
    const [editDailyQuota, setEditDailyQuota] = useState(0);
    const [editMonthlyQuota, setEditMonthlyQuota] = useState(0);
    const [updating, setUpdating] = useState(false);

    // 删除二次确认状态
    const [deletingToken, setDeletingToken] = useState<UserToken | null>(null);
    const [deleting, setDeleting] = useState(false);
    // 创建成功后暂存完整 Token（仅此一次展示完整值）
    const [createdToken, setCreatedToken] = useState<UserToken | null>(null);
    // 续期行内 loading
    const [renewingId, setRenewingId] = useState<string | null>(null);

    // 搜索与筛选
    const [searchQuery, setSearchQuery] = useState('');
    const [filterStatus, setFilterStatus] = useState<string>('all');
    // 展开行详情与已展开集合（支持平滑折叠动画与惰性渲染）
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [openedIds, setOpenedIds] = useState<Set<string>>(() => new Set());

    // Create Form State
    const [newUsername, setNewUsername] = useState('');
    const [newDesc, setNewDesc] = useState('');
    const [newExpiresType, setNewExpiresType] = useState('month');
    const [newMaxIps, setNewMaxIps] = useState(0);
    const [newCurfewStart, setNewCurfewStart] = useState('');
    const [newCurfewEnd, setNewCurfewEnd] = useState('');
    const [newDailyQuota, setNewDailyQuota] = useState(0);
    const [newMonthlyQuota, setNewMonthlyQuota] = useState(0);
    const [newCustomExpires, setNewCustomExpires] = useState('');

    const loadData = async () => {
        setLoading(true);
        try {
            const tokensData = await invoke<UserToken[]>('list_user_tokens');
            setTokens(tokensData);
            try {
                const statsData = await invoke<UserTokenStats>('get_user_token_summary');
                setStats(statsData);
            } catch (e) {
                console.error('Failed to load user token summary', e);
            }
        } catch (e) {
            console.error('Failed to load user tokens', e);
            showToast(t('common.load_failed') || 'Failed to load data', 'error');
        } finally {
            setLoading(false);
        }
    };

    const handleRefresh = async () => {
        await loadData();
        showToast(t('user_token.refresh_success') || 'Token list refreshed', 'success');
    };

    useEffect(() => {
        loadData();
    }, []);

    const handleCreate = async () => {
        if (!newUsername) {
            showToast(t('user_token.username_required') || 'Username is required', 'error');
            return;
        }
        if (newExpiresType === 'custom' && !newCustomExpires) {
            showToast(t('user_token.custom_expires_required') || 'Please select a custom expiration time', 'error');
            return;
        }
        if (newDailyQuota > 0 && newDailyQuota < QUOTA_HOLD_AMOUNT) {
            showToast(`每日额度不能小于 ${QUOTA_HOLD_AMOUNT}（或设为 0 不限制）`, 'error');
            return;
        }
        if (newMonthlyQuota > 0 && newMonthlyQuota < QUOTA_HOLD_AMOUNT) {
            showToast(`每月额度不能小于 ${QUOTA_HOLD_AMOUNT}（或设为 0 不限制）`, 'error');
            return;
        }

        setCreating(true);
        try {
            const customExpiresAt = newExpiresType === 'custom' && newCustomExpires
                ? Math.floor(new Date(newCustomExpires).getTime() / 1000)
                : undefined;

            const created = await invoke<UserToken>('create_user_token', {
                request: {
                    username: newUsername,
                    expires_type: newExpiresType,
                    description: newDesc || null,
                    max_ips: newMaxIps,
                    curfew_start: newCurfewStart || null,
                    curfew_end: newCurfewEnd || null,
                    custom_expires_at: customExpiresAt || null,
                    daily_quota: newDailyQuota,
                    monthly_quota: newMonthlyQuota
                }
            });
            showToast(t('common.create_success') || 'Created successfully', 'success');
            setCreatedToken(created);
            loadData();
        } catch (e) {
            console.error('Failed to create token', e);
            showToast(String(e), 'error');
        } finally {
            setCreating(false);
        }
    };

    const requestDelete = (token: UserToken) => setDeletingToken(token);

    const confirmDelete = async () => {
        if (!deletingToken) return;
        setDeleting(true);
        try {
            await invoke('delete_user_token', { id: deletingToken.id });
            showToast(t('common.delete_success') || 'Deleted successfully', 'success');
            setDeletingToken(null);
            loadData();
        } catch (e) {
            showToast(String(e), 'error');
        } finally {
            setDeleting(false);
        }
    };

    const handleEdit = (token: UserToken) => {
        setEditingToken(token);
        setEditUsername(token.username);
        setEditDesc(token.description || '');
        setEditMaxIps(token.max_ips ?? 0);
        setEditCurfewStart(token.curfew_start ?? '');
        setEditCurfewEnd(token.curfew_end ?? '');
        setEditDailyQuota(token.daily_quota ?? 0);
        setEditMonthlyQuota(token.monthly_quota ?? 0);
        setShowEditModal(true);
    };

    const handleUpdate = async () => {
        if (!editingToken) return;
        if (!editUsername) {
            showToast(t('user_token.username_required') || 'Username is required', 'error');
            return;
        }
        if (editDailyQuota > 0 && editDailyQuota < QUOTA_HOLD_AMOUNT) {
            showToast(`每日额度不能小于 ${QUOTA_HOLD_AMOUNT}（或设为 0 不限制）`, 'error');
            return;
        }
        if (editMonthlyQuota > 0 && editMonthlyQuota < QUOTA_HOLD_AMOUNT) {
            showToast(`每月额度不能小于 ${QUOTA_HOLD_AMOUNT}（或设为 0 不限制）`, 'error');
            return;
        }

        setUpdating(true);
        try {
            await invoke('update_user_token', {
                id: editingToken.id,
                request: {
                    username: editUsername,
                    description: editDesc || undefined,
                    max_ips: editMaxIps,
                    curfew_start: editCurfewStart === '' ? null : editCurfewStart,
                    curfew_end: editCurfewEnd === '' ? null : editCurfewEnd,
                    daily_quota: editDailyQuota,
                    monthly_quota: editMonthlyQuota
                }
            });
            showToast(t('common.update_success') || 'Updated successfully', 'success');
            setShowEditModal(false);
            setEditingToken(null);
            loadData();
        } catch (e) {
            console.error('Failed to update token', e);
            showToast(String(e), 'error');
        } finally {
            setUpdating(false);
        }
    };

    const handleRenew = async (id: string, type: string) => {
        setRenewingId(id);
        try {
            await invoke('renew_user_token', { id, expiresType: type });
            showToast(t('user_token.renew_success') || 'Renewed successfully', 'success');
            loadData();
        } catch (e) {
            showToast(String(e), 'error');
        } finally {
            (document.activeElement as HTMLElement | null)?.blur();
            setRenewingId(null);
        }
    };

    const openCreateModal = () => {
        setCreatedToken(null);
        setNewUsername('');
        setNewDesc('');
        setNewExpiresType('month');
        setNewMaxIps(0);
        setNewCurfewStart('');
        setNewCurfewEnd('');
        setNewDailyQuota(0);
        setNewMonthlyQuota(0);
        setNewCustomExpires('');
        setShowCreateModal(true);
    };

    const resetAndCloseCreateModal = () => {
        setShowCreateModal(false);
        setCreatedToken(null);
        setNewUsername('');
        setNewDesc('');
        setNewExpiresType('month');
        setNewMaxIps(0);
        setNewCurfewStart('');
        setNewCurfewEnd('');
        setNewDailyQuota(0);
        setNewMonthlyQuota(0);
        setNewCustomExpires('');
    };

    const handleCopyToken = async (text: string) => {
        const success = await copyToClipboard(text);
        if (success) {
            showToast(t('common.copied') || 'Copied to clipboard', 'success');
        } else {
            showToast(t('common.copy_failed') || 'Failed to copy to clipboard', 'error');
        }
    };

    const formatTime = (ts?: number) => {
        if (!ts) return '-';
        return new Date(ts * 1000).toLocaleString();
    };

    const getExpiresLabel = (type: string) => {
        switch (type) {
            case 'day': return t('user_token.expires_day', { defaultValue: '1 Day' });
            case 'week': return t('user_token.expires_week', { defaultValue: '1 Week' });
            case 'month': return t('user_token.expires_month', { defaultValue: '1 Month' });
            case 'never': return t('user_token.expires_never', { defaultValue: 'Never' });
            case 'custom': return t('user_token.expires_custom', { defaultValue: 'Custom' });
            default: return type;
        }
    };

    /**
     * 计算 Token 的综合状态（取最严重的状态）
     * 优先级：expired > quota_danger > expiring > quota_warning > normal
     */
    const getTokenStatus = (token: UserToken): TokenStatus => {
        const now = Date.now() / 1000;

        // 已过期
        if (token.expires_at && token.expires_at < now) {
            return 'expired';
        }

        // 额度危险（日或月用量 >= 90%）
        const dailyPct = token.daily_quota > 0 ? (token.daily_used / token.daily_quota) * 100 : 0;
        const monthlyPct = token.monthly_quota > 0 ? (token.monthly_used / token.monthly_quota) * 100 : 0;
        if (dailyPct >= 90 || monthlyPct >= 90) {
            return 'quota_danger';
        }

        // 即将过期（7天内）
        if (token.expires_at && token.expires_at - now < 86400 * 7) {
            return 'expiring';
        }

        // 额度警告（>= 70%）
        if (dailyPct >= 70 || monthlyPct >= 70) {
            return 'quota_warning';
        }

        return 'normal';
    };

    // 获取状态对应的徽章配置
    const getStatusBadge = (status: TokenStatus) => {
        switch (status) {
            case 'expired':
                return { label: '已过期', className: 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border-red-100 dark:border-red-900/30' };
            case 'quota_danger':
                return { label: '额度告急', className: 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border-red-100 dark:border-red-900/30' };
            case 'expiring':
                return { label: '即将过期', className: 'bg-orange-50 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400 border-orange-100 dark:border-orange-900/30' };
            case 'quota_warning':
                return { label: '额度预警', className: 'bg-orange-50 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400 border-orange-100 dark:border-orange-900/30' };
            default:
                return { label: '正常', className: 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 border-green-100 dark:border-green-900/30' };
        }
    };

    // 搜索 + 筛选后的列表
    const filteredTokens = useMemo(() => {
        let result = tokens;

        // 关键词搜索（用户名 + 描述 + token前缀）
        if (searchQuery.trim()) {
            const q = searchQuery.trim().toLowerCase();
            result = result.filter(token =>
                token.username.toLowerCase().includes(q) ||
                (token.description || '').toLowerCase().includes(q) ||
                token.token.toLowerCase().includes(q)
            );
        }

        // 状态筛选
        if (filterStatus !== 'all') {
            result = result.filter(token => {
                const status = getTokenStatus(token);
                switch (filterStatus) {
                    case 'active':
                        return status === 'normal';
                    case 'expired':
                        return status === 'expired';
                    case 'warning':
                        return status === 'expiring' || status === 'quota_warning' || status === 'quota_danger';
                    default:
                        return true;
                }
            });
        }

        return result;
    }, [tokens, searchQuery, filterStatus]);

    // 切换展开行
    const toggleExpand = useCallback((id: string) => {
        setExpandedId(prev => (prev === id ? null : id));
        setOpenedIds(prev => {
            if (prev.has(id)) return prev;
            const next = new Set(prev);
            next.add(id);
            return next;
        });
    }, []);

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="h-full flex flex-col p-5 gap-5 w-full"
        >
            {/* Header */}
            <div className="flex justify-between items-center">
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
                    <div className="p-2 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
                        <User className="text-purple-500 w-5 h-5" />
                    </div>
                    {t('user_token.title', { defaultValue: 'User Tokens' })}
                </h1>

                <div className="flex items-center gap-2">
                    <button
                        onClick={() => handleRefresh()}
                        className={`p-2 hover:bg-gray-100 dark:hover:bg-base-200 rounded-lg transition-colors ${loading ? 'text-blue-500' : 'text-gray-500'}`}
                        title={t('common.refresh') || 'Refresh'}
                    >
                        <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
                    </button>
                    <button
                        onClick={openCreateModal}
                        className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium rounded-lg transition-all flex items-center gap-2 shadow-sm shadow-blue-500/20"
                    >
                        <Plus size={16} />
                        <span>{t('user_token.create', { defaultValue: 'Create Token' })}</span>
                    </button>
                </div>
            </div>

            {/* Stats Cards Row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <motion.div
                    whileHover={{ y: -2 }}
                    className="bg-white dark:bg-base-100 rounded-xl p-4 shadow-sm border border-gray-100 dark:border-base-200"
                >
                    <div className="flex items-center justify-between mb-2">
                        <div className="p-1.5 bg-blue-50 dark:bg-blue-900/20 rounded-md">
                            <Users className="w-4 h-4 text-blue-500" />
                        </div>
                    </div>
                    <div className="text-2xl font-bold text-gray-900 dark:text-base-content mb-0.5">{stats?.total_users || 0}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">{t('user_token.total_users', { defaultValue: 'Total Users' })}</div>
                </motion.div>

                <motion.div
                    whileHover={{ y: -2 }}
                    className="bg-white dark:bg-base-100 rounded-xl p-4 shadow-sm border border-gray-100 dark:border-base-200"
                >
                    <div className="flex items-center justify-between mb-2">
                        <div className="p-1.5 bg-green-50 dark:bg-green-900/20 rounded-md">
                            <Activity className="w-4 h-4 text-green-500" />
                        </div>
                    </div>
                    <div className="text-2xl font-bold text-gray-900 dark:text-base-content mb-0.5">{stats?.active_tokens || 0}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">{t('user_token.active_tokens', { defaultValue: 'Active Tokens' })}</div>
                </motion.div>

                <motion.div
                    whileHover={{ y: -2 }}
                    className="bg-white dark:bg-base-100 rounded-xl p-4 shadow-sm border border-gray-100 dark:border-base-200"
                >
                    <div className="flex items-center justify-between mb-2">
                        <div className="p-1.5 bg-purple-50 dark:bg-purple-900/20 rounded-md">
                            <Clock className="w-4 h-4 text-purple-500" />
                        </div>
                    </div>
                    <div className="text-2xl font-bold text-gray-900 dark:text-base-content mb-0.5">{stats?.total_tokens || 0}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">{t('user_token.total_created', { defaultValue: 'Total Tokens' })}</div>
                </motion.div>

                <motion.div
                    whileHover={{ y: -2 }}
                    className="bg-white dark:bg-base-100 rounded-xl p-4 shadow-sm border border-gray-100 dark:border-base-200"
                >
                    <div className="flex items-center justify-between mb-2">
                        <div className="p-1.5 bg-orange-50 dark:bg-orange-900/20 rounded-md">
                            <Shield className="w-4 h-4 text-orange-500" />
                        </div>
                    </div>
                    <div className="text-2xl font-bold text-gray-900 dark:text-base-content mb-0.5">{stats?.today_requests || 0}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">{t('user_token.today_requests', { defaultValue: 'Today Requests' })}</div>
                </motion.div>
            </div>

            {/* 搜索与筛选栏 */}
            <div className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex-1">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        placeholder="搜索用户名、描述或 Token..."
                        className="w-full pl-9 pr-4 py-2 bg-white dark:bg-base-100 border border-gray-200 dark:border-base-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition-all"
                    />
                    {searchQuery && (
                        <button
                            onClick={() => setSearchQuery('')}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        >
                            ×
                        </button>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <Filter size={16} className="text-gray-400" />
                    <div className="flex bg-white dark:bg-base-100 border border-gray-200 dark:border-base-200 rounded-lg p-0.5">
                        {FILTER_OPTIONS.map(opt => (
                            <button
                                key={opt.value}
                                onClick={() => setFilterStatus(opt.value)}
                                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                                    filterStatus === opt.value
                                        ? 'bg-blue-500 text-white shadow-sm'
                                        : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                                }`}
                            >
                                {opt.label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* Token List */}
            <div className="flex-1 min-w-0 overflow-x-hidden overflow-y-auto bg-white dark:bg-base-100 rounded-2xl shadow-sm border border-gray-100 dark:border-base-200">
                <table className="table w-full">
                    <thead>
                        <tr className="bg-gray-50 dark:bg-base-200">
                            <th className="bg-transparent text-gray-500 font-medium py-4 w-10"></th>
                            <th className="bg-transparent text-gray-500 font-medium py-4">{t('user_token.username', { defaultValue: 'Username' })}</th>
                            <th className="bg-transparent text-gray-500 font-medium py-4">{t('user_token.token', { defaultValue: 'Token' })}</th>
                            <th className="bg-transparent text-gray-500 font-medium py-4">{t('user_token.expires', { defaultValue: 'Expires' })}</th>
                            <th className="bg-transparent text-gray-500 font-medium py-4">{t('user_token.usage', { defaultValue: 'Usage & Quota' })}</th>
                            <th className="bg-transparent text-gray-500 font-medium py-4 text-right">{t('common.actions', { defaultValue: 'Actions' })}</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-base-200">
                        <AnimatePresence>
                            {filteredTokens.map((token, index) => {
                                const status = getTokenStatus(token);
                                const badge = getStatusBadge(status);
                                const isExpanded = expandedId === token.id;
                                const isRendered = isExpanded || openedIds.has(token.id);
                                const dailyPct = token.daily_quota > 0 ? Math.min(100, (token.daily_used / token.daily_quota) * 100) : 0;
                                const monthlyPct = token.monthly_quota > 0 ? Math.min(100, (token.monthly_used / token.monthly_quota) * 100) : 0;

                                return (
                                    <React.Fragment key={token.id}>
                                        <motion.tr
                                            initial={{ opacity: 0, x: -10 }}
                                            animate={{ opacity: 1, x: 0 }}
                                            exit={{ opacity: 0, scale: 0.95 }}
                                            transition={{ delay: index * 0.03 }}
                                            className={`bg-white dark:bg-base-100 hover:bg-gray-50 dark:hover:bg-base-200/50 transition-colors group cursor-pointer ${isExpanded ? 'bg-gray-50 dark:bg-base-200/30' : ''}`}
                                            onClick={() => toggleExpand(token.id)}
                                        >
                                            {/* 展开箭头 */}
                                            <td className="py-4 w-10 text-gray-400">
                                                <div className="flex items-center justify-center">
                                                    <ChevronRight
                                                        size={16}
                                                        className={`transition-transform duration-200 ease-out ${isExpanded ? 'rotate-90 text-blue-500 dark:text-blue-400' : 'text-gray-400 group-hover:text-gray-600'}`}
                                                    />
                                                </div>
                                            </td>

                                            {/* 用户名 + 状态徽章 */}
                                            <td className="py-4">
                                                <div className="flex items-center gap-3">
                                                    <div className="w-8 h-8 rounded-full bg-purple-50 dark:bg-purple-900/20 flex items-center justify-center text-purple-600 font-bold text-xs flex-shrink-0">
                                                        {token.username.substring(0, 2).toUpperCase()}
                                                    </div>
                                                    <div className="min-w-0">
                                                        <div className="flex items-center gap-2">
                                                            <span className="font-semibold text-gray-900 dark:text-white uppercase tracking-wider text-sm truncate">{token.username}</span>
                                                            <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded-full border flex-shrink-0 ${badge.className}`}>
                                                                {badge.label}
                                                            </span>
                                                        </div>
                                                        <div className="text-xs text-gray-500 truncate">{token.description || '-'}</div>
                                                    </div>
                                                </div>
                                            </td>

                                            {/* Token */}
                                            <td onClick={e => e.stopPropagation()}>
                                                <div className="flex items-center gap-2 group/token">
                                                    <code className="bg-gray-50 dark:bg-base-200 px-2 py-1 rounded border border-gray-100 dark:border-base-300 text-xs font-mono text-gray-600 dark:text-gray-400">
                                                        {token.token.substring(0, 8)}••••••••
                                                    </code>
                                                    <button
                                                        onClick={() => handleCopyToken(token.token)}
                                                        className="p-1.5 hover:bg-gray-200 dark:hover:bg-base-300 rounded-md transition-all text-gray-400 hover:text-gray-600 dark:hover:text-white"
                                                    >
                                                        <Copy size={13} />
                                                    </button>
                                                </div>
                                            </td>

                                            {/* 有效期 */}
                                            <td onClick={e => e.stopPropagation()}>
                                                <div className={`text-sm font-medium mb-1 ${
                                                    status === 'expired' ? 'text-red-500 font-bold' :
                                                    status === 'expiring' ? 'text-orange-500' : 'text-green-500'
                                                }`}>
                                                    {token.expires_at ? formatTime(token.expires_at) : t('user_token.never', { defaultValue: 'Never' })}
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <span className="text-xs px-1.5 py-0.5 bg-gray-100 dark:bg-base-200 text-gray-500 rounded lowercase">
                                                        {getExpiresLabel(token.expires_type)}
                                                    </span>
                                                    {token.expires_at && token.expires_at < Date.now() / 1000 && (
                                                        <button
                                                            onClick={() => handleRenew(token.id, token.expires_type)}
                                                            className="text-xs text-blue-500 hover:underline font-medium"
                                                        >
                                                            {t('user_token.renew_button', { defaultValue: 'Renew' })}
                                                        </button>
                                                    )}
                                                </div>
                                            </td>

                                            {/* 用量与额度（核心列） */}
                                            <td>
                                                <div className="space-y-1.5 min-w-[180px]">
                                                    {/* 累计用量 */}
                                                    <div className="flex items-center justify-between whitespace-nowrap">
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">{token.total_requests}</span>
                                                            <span className="text-xs text-gray-500 dark:text-gray-400">次请求</span>
                                                        </div>
                                                        <span className="text-lg font-bold text-gray-900 dark:text-white tabular-nums" title={`累计 ${token.total_tokens_used.toLocaleString()} tokens`}>
                                                            {formatTokenCount(token.total_tokens_used)}
                                                        </span>
                                                    </div>

                                                    {/* 日额度进度条 */}
                                                    {token.daily_quota > 0 && (
                                                        <div
                                                            title={`日额度：已用 ${token.daily_used.toLocaleString()} / 总额 ${token.daily_quota.toLocaleString()}，剩余 ${Math.max(0, token.daily_quota - token.daily_used).toLocaleString()}（${dailyPct.toFixed(1)}%）`}
                                                        >
                                                            <div className="flex items-center gap-1.5 mb-0.5">
                                                                <span className="text-[10px] text-gray-700 dark:text-gray-300 w-10 whitespace-nowrap flex-shrink-0">日额度</span>
                                                                <div className="flex-1 h-1.5 bg-gray-100 dark:bg-base-200 rounded-full overflow-hidden">
                                                                    <div
                                                                        className={`h-full rounded-full transition-all ${dailyPct >= 90 ? 'bg-red-500' : dailyPct >= 70 ? 'bg-orange-500' : 'bg-blue-500'}`}
                                                                        style={{ width: `${dailyPct}%` }}
                                                                    />
                                                                </div>
                                                                <span className="text-xs font-semibold text-gray-600 dark:text-gray-400 tabular-nums w-24 text-right whitespace-nowrap flex-shrink-0">
                                                                    {formatTokenCount(token.daily_used)}/{formatTokenCount(token.daily_quota)}
                                                                </span>
                                                            </div>
                                                        </div>
                                                    )}

                                                    {/* 月额度进度条 */}
                                                    {token.monthly_quota > 0 && (
                                                        <div
                                                            title={`月额度：已用 ${token.monthly_used.toLocaleString()} / 总额 ${token.monthly_quota.toLocaleString()}，剩余 ${Math.max(0, token.monthly_quota - token.monthly_used).toLocaleString()}（${monthlyPct.toFixed(1)}%）`}
                                                        >
                                                            <div className="flex items-center gap-1.5">
                                                                <span className="text-[10px] text-gray-700 dark:text-gray-300 w-10 whitespace-nowrap flex-shrink-0">月额度</span>
                                                                <div className="flex-1 h-1.5 bg-gray-100 dark:bg-base-200 rounded-full overflow-hidden">
                                                                    <div
                                                                        className={`h-full rounded-full transition-all ${monthlyPct >= 90 ? 'bg-red-500' : monthlyPct >= 70 ? 'bg-orange-500' : 'bg-purple-500'}`}
                                                                        style={{ width: `${monthlyPct}%` }}
                                                                    />
                                                                </div>
                                                                <span className="text-xs font-semibold text-gray-600 dark:text-gray-400 tabular-nums w-24 text-right whitespace-nowrap flex-shrink-0">
                                                                    {formatTokenCount(token.monthly_used)}/{formatTokenCount(token.monthly_quota)}
                                                                </span>
                                                            </div>
                                                        </div>
                                                    )}

                                                    {/* 无额度限制提示 */}
                                                    {token.daily_quota === 0 && token.monthly_quota === 0 && (
                                                        <div className="text-[10px] text-gray-400">无额度限制</div>
                                                    )}
                                                </div>
                                            </td>

                                            {/* 操作 */}
                                            <td className="text-right" onClick={e => e.stopPropagation()}>
                                                <div className="flex justify-end items-center gap-1">
                                                    <button
                                                        onClick={() => handleEdit(token)}
                                                        className="p-1.5 flex items-center justify-center hover:bg-gray-100 dark:hover:bg-base-200 rounded-lg text-gray-500 hover:text-blue-500 transition-colors"
                                                        title={t('common.edit', { defaultValue: 'Edit' })}
                                                    >
                                                        <Settings size={15} />
                                                    </button>
                                                    <div className="dropdown dropdown-end">
                                                        <label tabIndex={0} className={`p-1.5 flex items-center justify-center hover:bg-gray-100 dark:hover:bg-base-200 rounded-lg transition-colors cursor-pointer ${renewingId === token.id ? 'text-green-500' : 'text-gray-500 hover:text-green-500'}`}>
                                                            <CalendarPlus size={15} className={renewingId === token.id ? 'animate-spin' : ''} />
                                                        </label>
                                                        <ul tabIndex={0} className="dropdown-content z-[10] menu p-2 shadow-xl bg-white dark:bg-base-100 rounded-xl w-32 border border-gray-100 dark:border-base-200 mt-1">
                                                            <div className="px-3 py-1.5 text-xs font-bold text-gray-400 uppercase tracking-widest">{t('user_token.renew')}</div>
                                                            <li><a className="text-sm py-2" onClick={() => handleRenew(token.id, 'day')}>{t('user_token.expires_day', { defaultValue: '1 Day' })}</a></li>
                                                            <li><a className="text-sm py-2" onClick={() => handleRenew(token.id, 'week')}>{t('user_token.expires_week', { defaultValue: '1 Week' })}</a></li>
                                                            <li><a className="text-sm py-2" onClick={() => handleRenew(token.id, 'month')}>{t('user_token.expires_month', { defaultValue: '1 Month' })}</a></li>
                                                        </ul>
                                                    </div>
                                                    <button
                                                        onClick={() => requestDelete(token)}
                                                        className="p-1.5 flex items-center justify-center hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg text-gray-400 hover:text-red-500 transition-colors"
                                                        title={t('common.delete', { defaultValue: 'Delete' })}
                                                    >
                                                        <Trash2 size={15} />
                                                    </button>
                                                </div>
                                            </td>
                                        </motion.tr>

                                        {/* 展开详情行（CSS Grid 平滑折叠动画，与流量/安全日志保持一致） */}
                                        <tr className="border-none">
                                            <td colSpan={6} className="p-0 border-none">
                                                <div
                                                    className={`grid transition-[grid-template-rows,opacity] duration-200 ease-in-out ${
                                                        isExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0 pointer-events-none'
                                                    }`}
                                                >
                                                    <div className="overflow-hidden">
                                                        {isRendered && (
                                                            <div className="py-3 px-6 bg-gray-50 dark:bg-base-200/30 border-b border-gray-100 dark:border-base-300">
                                                                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm pl-8">
                                                                    {/* IP 限制 */}
                                                                    <div>
                                                                        <div className="text-xs text-gray-400 mb-1 flex items-center gap-1">
                                                                            <Shield size={12} /> IP 限制
                                                                        </div>
                                                                        <div className="font-medium text-gray-700 dark:text-gray-300">
                                                                            {token.max_ips === 0 ? '不限制' : `${token.max_ips} 个 IP`}
                                                                        </div>
                                                                    </div>

                                                                    {/* 宵禁时间 */}
                                                                    <div>
                                                                        <div className="text-xs text-gray-400 mb-1 flex items-center gap-1">
                                                                            <Clock size={12} /> 服务时间
                                                                        </div>
                                                                        <div className="font-medium text-gray-700 dark:text-gray-300">
                                                                            {token.curfew_start && token.curfew_end
                                                                                ? `${token.curfew_start} - ${token.curfew_end}（UTC+8）`
                                                                                : '全天可用'}
                                                                        </div>
                                                                    </div>

                                                                    {/* 创建时间 */}
                                                                    <div>
                                                                        <div className="text-xs text-gray-400 mb-1">创建时间</div>
                                                                        <div className="font-medium text-gray-700 dark:text-gray-300">{formatTime(token.created_at)}</div>
                                                                    </div>

                                                                    {/* 最后使用 */}
                                                                    <div>
                                                                        <div className="text-xs text-gray-400 mb-1">最后使用</div>
                                                                        <div className="font-medium text-gray-700 dark:text-gray-300">
                                                                            {token.last_used_at ? formatTime(token.last_used_at) : '从未使用'}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </td>
                                        </tr>
                                    </React.Fragment>
                                );
                            })}
                        </AnimatePresence>

                        {/* 骨架屏 */}
                        {loading && filteredTokens.length === 0 && Array.from({ length: 4 }).map((_, i) => (
                            <tr key={`skeleton-${i}`} className="animate-pulse">
                                {Array.from({ length: 6 }).map((__, j) => (
                                    <td key={j} className="py-4">
                                        <div
                                            className="h-4 bg-gray-200 dark:bg-base-300 rounded"
                                            style={{ width: `${40 + ((i * 13 + j * 17) % 45)}%` }}
                                        ></div>
                                    </td>
                                ))}
                            </tr>
                        ))}

                        {/* 空状态 */}
                        {filteredTokens.length === 0 && !loading && (
                            <tr>
                                <td colSpan={6} className="py-20">
                                    <div className="flex flex-col items-center justify-center text-gray-400 gap-3">
                                        <div className="p-4 bg-gray-50 dark:bg-base-200 rounded-full">
                                            {searchQuery || filterStatus !== 'all'
                                                ? <Search size={40} className="opacity-20" />
                                                : <Users size={40} className="opacity-20" />
                                            }
                                        </div>
                                        <p className="text-sm">
                                            {searchQuery || filterStatus !== 'all'
                                                ? '没有找到匹配的 Token'
                                                : t('user_token.no_data', { defaultValue: 'No tokens found' })}
                                        </p>
                                        {searchQuery || filterStatus !== 'all' ? (
                                            <button
                                                onClick={() => { setSearchQuery(''); setFilterStatus('all'); }}
                                                className="text-xs text-blue-500 hover:underline"
                                            >
                                                清除筛选条件
                                            </button>
                                        ) : (
                                            <button
                                                onClick={openCreateModal}
                                                className="text-xs text-blue-500 hover:underline"
                                            >
                                                {t('user_token.create', { defaultValue: 'Create your first token' })}
                                            </button>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            {/* Create Modal */}
            {showCreateModal && (
                <div className="modal modal-open">
                    <div className="modal-box">
                        {createdToken ? (
                            <div className="py-2">
                                <div className="flex flex-col items-center text-center mb-4">
                                    <div className="w-14 h-14 rounded-full bg-green-50 dark:bg-green-900/20 flex items-center justify-center mb-3">
                                        <CheckCircle2 className="w-7 h-7 text-green-500" />
                                    </div>
                                    <h3 className="font-bold text-lg mb-1">Token 创建成功</h3>
                                    <p className="text-sm text-gray-500">请立即复制保存，关闭后将无法再次查看完整 Token</p>
                                </div>
                                <div className="relative bg-gray-50 dark:bg-base-200 rounded-lg p-3 pr-11 mb-3">
                                    <code className="text-xs font-mono break-all block text-gray-800 dark:text-gray-200">{createdToken.token}</code>
                                    <button
                                        onClick={() => handleCopyToken(createdToken.token)}
                                        className="absolute top-2 right-2 p-1.5 hover:bg-gray-200 dark:hover:bg-base-300 rounded-md text-gray-400 hover:text-blue-500 transition-colors"
                                        title={t('common.copy', { defaultValue: 'Copy' })}
                                    >
                                        <Copy size={15} />
                                    </button>
                                </div>
                                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-900/30 rounded-lg p-2.5 text-xs text-amber-700 dark:text-amber-400 mb-2">
                                    列表中仅显示掩码，这是唯一一次查看完整 Token 的机会
                                </div>
                                <div className="modal-action">
                                    <button
                                        className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium rounded-lg transition-all"
                                        onClick={resetAndCloseCreateModal}
                                    >
                                        已复制，完成
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <>
                        <h3 className="font-bold text-lg mb-4">{t('user_token.create_title', { defaultValue: 'Create New Token' })}</h3>

                        <div className="form-control w-full mb-3">
                            <label className="label">
                                <span className="label-text">{t('user_token.username', { defaultValue: 'Username' })} *</span>
                            </label>
                            <input
                                type="text"
                                className="input input-bordered w-full"
                                value={newUsername}
                                onChange={e => setNewUsername(e.target.value)}
                                placeholder={t('user_token.placeholder_username', { defaultValue: 'e.g. user1' })}
                            />
                        </div>

                        <div className="form-control w-full mb-3">
                            <label className="label">
                                <span className="label-text">{t('user_token.description', { defaultValue: 'Description' })}</span>
                            </label>
                            <input
                                type="text"
                                className="input input-bordered w-full"
                                value={newDesc}
                                onChange={e => setNewDesc(e.target.value)}
                                placeholder={t('user_token.placeholder_desc', { defaultValue: 'Optional notes' })}
                            />
                        </div>

                        <div className="grid grid-cols-2 gap-4 mb-3">
                            <div className="form-control w-full">
                                <label className="label">
                                    <span className="label-text">{t('user_token.expires', { defaultValue: 'Expires In' })}</span>
                                </label>
                                <select
                                    className="select select-bordered w-full"
                                    value={newExpiresType}
                                    onChange={e => setNewExpiresType(e.target.value)}
                                >
                                    <option value="day">{t('user_token.expires_day', { defaultValue: '1 Day' })}</option>
                                    <option value="week">{t('user_token.expires_week', { defaultValue: '1 Week' })}</option>
                                    <option value="month">{t('user_token.expires_month', { defaultValue: '1 Month' })}</option>
                                    <option value="custom">{t('user_token.expires_custom', { defaultValue: 'Custom' })}</option>
                                    <option value="never">{t('user_token.expires_never', { defaultValue: 'Never' })}</option>
                                </select>
                            </div>

                            <div className="form-control w-full">
                                <label className="label">
                                    <span className="label-text">{t('user_token.ip_limit', { defaultValue: 'Max IPs' })}</span>
                                </label>
                                <input
                                    type="number"
                                    className="input input-bordered w-full"
                                    value={newMaxIps}
                                    onChange={e => setNewMaxIps(parseInt(e.target.value) || 0)}
                                    min="0"
                                    placeholder={t('user_token.placeholder_max_ips', { defaultValue: '0 = Unlimited' })}
                                />
                                <label className="label">
                                    <span className="label-text-alt text-gray-500">{t('user_token.hint_max_ips', { defaultValue: '0 = Unlimited' })}</span>
                                </label>
                            </div>
                        </div>

                        {newExpiresType === 'custom' && (
                            <div className="form-control w-full mb-3">
                                <label className="label">
                                    <span className="label-text">{t('user_token.custom_expires_at', { defaultValue: 'Expiration Date & Time' })} *</span>
                                </label>
                                <input
                                    type="datetime-local"
                                    className="input input-bordered w-full"
                                    value={newCustomExpires}
                                    onChange={e => setNewCustomExpires(e.target.value)}
                                    min={new Date().toISOString().slice(0, 16)}
                                />
                                <label className="label">
                                    <span className="label-text-alt text-gray-500">{t('user_token.hint_custom_expires', { defaultValue: 'Select the exact date and hour when this token expires' })}</span>
                                </label>
                            </div>
                        )}

                        <div className="form-control w-full mb-3">
                            <label className="label">
                                <span className="label-text">{t('user_token.curfew', { defaultValue: 'Curfew (Service Unavailable Time)' })}</span>
                            </label>
                            <div className="flex gap-2 items-center">
                                <input
                                    type="time"
                                    className="input input-bordered w-full"
                                    value={newCurfewStart}
                                    onChange={e => setNewCurfewStart(e.target.value)}
                                />
                                <span className="text-gray-400">to</span>
                                <input
                                    type="time"
                                    className="input input-bordered w-full"
                                    value={newCurfewEnd}
                                    onChange={e => setNewCurfewEnd(e.target.value)}
                                />
                            </div>
                            <label className="label">
                                <span className="label-text-alt text-gray-500">{t('user_token.hint_curfew', { defaultValue: 'Leave empty to disable. Based on Beijing time (UTC+8).' })}</span>
                            </label>
                        </div>

                        <div className="form-control w-full mb-3">
                            <label className="label">
                                <span className="label-text flex items-center gap-1">{t('user_token.daily_quota', { defaultValue: 'Daily Token Quota' })}
                                    <div className="tooltip tooltip-right [&::after]:whitespace-pre-wrap [&::after]:max-w-[280px] [&::after]:text-left [&::after]:leading-relaxed [&::after]:text-xs" data-tip={QUOTA_HELP_TEXT}>
                                        <HelpCircle size={13} className="text-gray-400 hover:text-gray-600 cursor-help" />
                                    </div>
                                </span>
                            </label>
                            <input
                                type="number"
                                min={0}
                                className={`input input-bordered w-full ${newDailyQuota > 0 && newDailyQuota < QUOTA_HOLD_AMOUNT ? 'input-error' : ''}`}
                                value={newDailyQuota}
                                onChange={e => setNewDailyQuota(Math.max(0, parseInt(e.target.value) || 0))}
                                placeholder={t('user_token.placeholder_quota', { defaultValue: '0 = Unlimited' })}
                            />
                            {newDailyQuota > 0 && newDailyQuota < QUOTA_HOLD_AMOUNT ? (
                                <label className="label"><span className="label-text-alt text-red-500">非零额度不能小于 {QUOTA_HOLD_AMOUNT}（或填 0 不限制）</span></label>
                            ) : (
                                <label className="label">
                                    <span className="label-text-alt text-gray-500">{t('user_token.hint_daily_quota', { defaultValue: 'Max tokens per day (input + output). 0 = unlimited.' })}</span>
                                </label>
                            )}
                            <div className="flex flex-wrap gap-1.5">
                                {DAILY_QUOTA_PRESETS.map(p => (
                                    <button key={p.label} type="button" onClick={() => setNewDailyQuota(p.value)} className="px-2 py-0.5 text-xs border border-gray-200 dark:border-base-300 rounded-md text-gray-500 hover:border-blue-400 hover:text-blue-500 transition-colors">{p.label}</button>
                                ))}
                            </div>
                        </div>

                        <div className="form-control w-full mb-3">
                            <label className="label">
                                <span className="label-text flex items-center gap-1">{t('user_token.monthly_quota', { defaultValue: 'Monthly Token Quota' })}
                                    <div className="tooltip tooltip-right [&::after]:whitespace-pre-wrap [&::after]:max-w-[280px] [&::after]:text-left [&::after]:leading-relaxed [&::after]:text-xs" data-tip={QUOTA_HELP_TEXT}>
                                        <HelpCircle size={13} className="text-gray-400 hover:text-gray-600 cursor-help" />
                                    </div>
                                </span>
                            </label>
                            <input
                                type="number"
                                min={0}
                                className={`input input-bordered w-full ${newMonthlyQuota > 0 && newMonthlyQuota < QUOTA_HOLD_AMOUNT ? 'input-error' : ''}`}
                                value={newMonthlyQuota}
                                onChange={e => setNewMonthlyQuota(Math.max(0, parseInt(e.target.value) || 0))}
                                placeholder={t('user_token.placeholder_quota', { defaultValue: '0 = Unlimited' })}
                            />
                            {newMonthlyQuota > 0 && newMonthlyQuota < QUOTA_HOLD_AMOUNT ? (
                                <label className="label"><span className="label-text-alt text-red-500">非零额度不能小于 {QUOTA_HOLD_AMOUNT}（或填 0 不限制）</span></label>
                            ) : (
                                <label className="label">
                                    <span className="label-text-alt text-gray-500">{t('user_token.hint_monthly_quota', { defaultValue: 'Max tokens per calendar month. 0 = unlimited.' })}</span>
                                </label>
                            )}
                            <div className="flex flex-wrap gap-1.5">
                                {MONTHLY_QUOTA_PRESETS.map(p => (
                                    <button key={p.label} type="button" onClick={() => setNewMonthlyQuota(p.value)} className="px-2 py-0.5 text-xs border border-gray-200 dark:border-base-300 rounded-md text-gray-500 hover:border-blue-400 hover:text-blue-500 transition-colors">{p.label}</button>
                                ))}
                            </div>
                        </div>

                        <div className="modal-action">
                            <button className="px-4 py-2 hover:bg-gray-100 dark:hover:bg-base-200 rounded-lg text-sm transition-colors" onClick={resetAndCloseCreateModal}>
                                {t('common.cancel', { defaultValue: 'Cancel' })}
                            </button>
                            <button
                                className={`px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium rounded-lg transition-all shadow-sm shadow-blue-500/20 flex items-center gap-2 ${creating ? 'opacity-50 cursor-not-allowed' : ''}`}
                                onClick={handleCreate}
                                disabled={creating}
                            >
                                {creating && <RefreshCw size={14} className="animate-spin" />}
                                {t('common.create', { defaultValue: 'Create' })}
                            </button>
                        </div>
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* Edit Modal */}
            {showEditModal && editingToken && (
                <div className="modal modal-open">
                    <div className="modal-box">
                        <h3 className="font-bold text-lg mb-4">{t('user_token.edit_title', { defaultValue: 'Edit Token' })}</h3>

                        <div className="form-control w-full mb-3">
                            <label className="label">
                                <span className="label-text">{t('user_token.username', { defaultValue: 'Username' })} *</span>
                            </label>
                            <input
                                type="text"
                                className="input input-bordered w-full"
                                value={editUsername}
                                onChange={e => setEditUsername(e.target.value)}
                                placeholder={t('user_token.placeholder_username', { defaultValue: 'e.g. user1' })}
                            />
                        </div>

                        <div className="form-control w-full mb-3">
                            <label className="label">
                                <span className="label-text">{t('user_token.description', { defaultValue: 'Description' })}</span>
                            </label>
                            <input
                                type="text"
                                className="input input-bordered w-full"
                                value={editDesc}
                                onChange={e => setEditDesc(e.target.value)}
                                placeholder={t('user_token.placeholder_desc', { defaultValue: 'Optional notes' })}
                            />
                        </div>

                        <div className="form-control w-full mb-3">
                            <label className="label">
                                <span className="label-text">{t('user_token.ip_limit', { defaultValue: 'Max IPs' })}</span>
                            </label>
                            <input
                                type="number"
                                className="input input-bordered w-full"
                                value={editMaxIps}
                                onChange={e => setEditMaxIps(parseInt(e.target.value) || 0)}
                                min="0"
                                placeholder={t('user_token.placeholder_max_ips', { defaultValue: '0 = Unlimited' })}
                            />
                            <label className="label">
                                <span className="label-text-alt text-gray-500">{t('user_token.hint_max_ips', { defaultValue: '0 = Unlimited' })}</span>
                            </label>
                        </div>

                        <div className="form-control w-full mb-3">
                            <label className="label">
                                <span className="label-text">{t('user_token.curfew', { defaultValue: 'Curfew (Service Unavailable Time)' })}</span>
                            </label>
                            <div className="flex gap-2 items-center">
                                <input
                                    type="time"
                                    className="input input-bordered w-full"
                                    value={editCurfewStart}
                                    onChange={e => setEditCurfewStart(e.target.value)}
                                />
                                <span className="text-gray-400">to</span>
                                <input
                                    type="time"
                                    className="input input-bordered w-full"
                                    value={editCurfewEnd}
                                    onChange={e => setEditCurfewEnd(e.target.value)}
                                />
                            </div>
                            <label className="label">
                                <span className="label-text-alt text-gray-500">{t('user_token.hint_curfew', { defaultValue: 'Leave empty to disable. Based on Beijing time (UTC+8).' })}</span>
                            </label>
                        </div>

                        <div className="form-control w-full mb-3">
                            <label className="label">
                                <span className="label-text flex items-center gap-1">{t('user_token.daily_quota', { defaultValue: 'Daily Token Quota' })}
                                    <div className="tooltip tooltip-right [&::after]:whitespace-pre-wrap [&::after]:max-w-[280px] [&::after]:text-left [&::after]:leading-relaxed [&::after]:text-xs" data-tip={QUOTA_HELP_TEXT}>
                                        <HelpCircle size={13} className="text-gray-400 hover:text-gray-600 cursor-help" />
                                    </div>
                                </span>
                            </label>
                            <input
                                type="number"
                                min={0}
                                className={`input input-bordered w-full ${editDailyQuota > 0 && editDailyQuota < QUOTA_HOLD_AMOUNT ? 'input-error' : ''}`}
                                value={editDailyQuota}
                                onChange={e => setEditDailyQuota(Math.max(0, parseInt(e.target.value) || 0))}
                                placeholder={t('user_token.placeholder_quota', { defaultValue: '0 = Unlimited' })}
                            />
                            {editDailyQuota > 0 && editDailyQuota < QUOTA_HOLD_AMOUNT ? (
                                <label className="label"><span className="label-text-alt text-red-500">非零额度不能小于 {QUOTA_HOLD_AMOUNT}（或填 0 不限制）</span></label>
                            ) : (
                                <label className="label">
                                    <span className="label-text-alt text-gray-500">{t('user_token.hint_daily_quota', { defaultValue: 'Max tokens per day (input + output). 0 = unlimited.' })}</span>
                                </label>
                            )}
                            <div className="flex flex-wrap gap-1.5">
                                {DAILY_QUOTA_PRESETS.map(p => (
                                    <button key={p.label} type="button" onClick={() => setEditDailyQuota(p.value)} className="px-2 py-0.5 text-xs border border-gray-200 dark:border-base-300 rounded-md text-gray-500 hover:border-blue-400 hover:text-blue-500 transition-colors">{p.label}</button>
                                ))}
                            </div>
                        </div>

                        <div className="form-control w-full mb-3">
                            <label className="label">
                                <span className="label-text flex items-center gap-1">{t('user_token.monthly_quota', { defaultValue: 'Monthly Token Quota' })}
                                    <div className="tooltip tooltip-right [&::after]:whitespace-pre-wrap [&::after]:max-w-[280px] [&::after]:text-left [&::after]:leading-relaxed [&::after]:text-xs" data-tip={QUOTA_HELP_TEXT}>
                                        <HelpCircle size={13} className="text-gray-400 hover:text-gray-600 cursor-help" />
                                    </div>
                                </span>
                            </label>
                            <input
                                type="number"
                                min={0}
                                className={`input input-bordered w-full ${editMonthlyQuota > 0 && editMonthlyQuota < QUOTA_HOLD_AMOUNT ? 'input-error' : ''}`}
                                value={editMonthlyQuota}
                                onChange={e => setEditMonthlyQuota(Math.max(0, parseInt(e.target.value) || 0))}
                                placeholder={t('user_token.placeholder_quota', { defaultValue: '0 = Unlimited' })}
                            />
                            {editMonthlyQuota > 0 && editMonthlyQuota < QUOTA_HOLD_AMOUNT ? (
                                <label className="label"><span className="label-text-alt text-red-500">非零额度不能小于 {QUOTA_HOLD_AMOUNT}（或填 0 不限制）</span></label>
                            ) : (
                                <label className="label">
                                    <span className="label-text-alt text-gray-500">{t('user_token.hint_monthly_quota', { defaultValue: 'Max tokens per calendar month. 0 = unlimited.' })}</span>
                                </label>
                            )}
                            <div className="flex flex-wrap gap-1.5">
                                {MONTHLY_QUOTA_PRESETS.map(p => (
                                    <button key={p.label} type="button" onClick={() => setEditMonthlyQuota(p.value)} className="px-2 py-0.5 text-xs border border-gray-200 dark:border-base-300 rounded-md text-gray-500 hover:border-blue-400 hover:text-blue-500 transition-colors">{p.label}</button>
                                ))}
                            </div>
                        </div>

                        <div className="modal-action">
                            <button className="px-4 py-2 hover:bg-gray-100 dark:hover:bg-base-200 rounded-lg text-sm transition-colors" onClick={() => setShowEditModal(false)}>
                                {t('common.cancel', { defaultValue: 'Cancel' })}
                            </button>
                            <button
                                className={`px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium rounded-lg transition-all shadow-sm shadow-blue-500/20 flex items-center gap-2 ${updating ? 'opacity-50 cursor-not-allowed' : ''}`}
                                onClick={handleUpdate}
                                disabled={updating}
                            >
                                {updating && <RefreshCw size={14} className="animate-spin" />}
                                {t('common.update', { defaultValue: 'Update' })}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Delete Confirm Modal */}
            {deletingToken && (
                <div className="modal modal-open">
                    <div className="modal-box max-w-md">
                        <div className="flex flex-col items-center text-center">
                            <div className="w-14 h-14 rounded-full bg-red-50 dark:bg-red-900/20 flex items-center justify-center mb-3">
                                <Trash2 className="w-7 h-7 text-red-500" />
                            </div>
                            <h3 className="font-bold text-lg mb-1">确认删除该 Token？</h3>
                            <p className="text-sm text-gray-500 mb-4">删除后无法恢复，使用该 Token 的客户端将立即失效</p>
                        </div>
                        <div className="bg-gray-50 dark:bg-base-200 rounded-lg p-3 text-sm space-y-1.5 mb-2">
                            <div className="flex justify-between items-center">
                                <span className="text-gray-400">用户名</span>
                                <span className="font-medium">{deletingToken.username}</span>
                            </div>
                            <div className="flex justify-between items-center">
                                <span className="text-gray-400">Token</span>
                                <code className="font-mono text-xs">{deletingToken.token.substring(0, 8)}••••••••</code>
                            </div>
                            <div className="flex justify-between items-center">
                                <span className="text-gray-400">累计请求</span>
                                <span className="font-medium">{deletingToken.total_requests} 次</span>
                            </div>
                        </div>
                        <div className="modal-action">
                            <button
                                className="px-4 py-2 hover:bg-gray-100 dark:hover:bg-base-200 rounded-lg text-sm transition-colors"
                                onClick={() => setDeletingToken(null)}
                                disabled={deleting}
                            >
                                {t('common.cancel', { defaultValue: 'Cancel' })}
                            </button>
                            <button
                                className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white text-sm font-medium rounded-lg transition-all flex items-center gap-2 disabled:opacity-50"
                                onClick={confirmDelete}
                                disabled={deleting}
                            >
                                {deleting && <RefreshCw size={14} className="animate-spin" />}
                                确认删除
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </motion.div>
    );
};
export default UserToken;
