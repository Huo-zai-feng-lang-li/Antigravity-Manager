import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, RefreshCw, Copy, Activity, User, Settings, Shield, Clock, Users, HelpCircle, CalendarPlus, CheckCircle2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { request as invoke } from '../utils/request';
import { showToast } from '../components/common/ToastContainer';
import { copyToClipboard } from '../utils/clipboard';

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

// interface CreateTokenRequest omitted as it's not explicitly used for typing variables

// 额度预占量：必须与 Rust 后端 user_token_db.rs 的 QUOTA_HOLD_AMOUNT 保持一致。
// 非零额度若小于该值，单个请求在预占阶段就会被拒（完全不可用），故前端提前阻止提交。
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

    // Create Form State
    const [newUsername, setNewUsername] = useState('');
    const [newDesc, setNewDesc] = useState('');
    const [newExpiresType, setNewExpiresType] = useState('month'); // day, week, month, never, custom
    const [newMaxIps, setNewMaxIps] = useState(0);
    const [newCurfewStart, setNewCurfewStart] = useState('');
    const [newCurfewEnd, setNewCurfewEnd] = useState('');
    const [newDailyQuota, setNewDailyQuota] = useState(0);
    const [newMonthlyQuota, setNewMonthlyQuota] = useState(0);
    const [newCustomExpires, setNewCustomExpires] = useState(''); // datetime-local value

    const loadData = async () => {
        setLoading(true);
        try {
            // 列表与统计独立加载：即使统计接口失败，列表也必须完成刷新，避免“点了刷新没反应”
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

    // 手动点击刷新：本地 SQLite 查询毫秒级完成、数据无变化时视觉无感，补一个明确的成功反馈
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

        // 验证自定义时间
        if (newExpiresType === 'custom' && !newCustomExpires) {
            showToast(t('user_token.custom_expires_required') || 'Please select a custom expiration time', 'error');
            return;
        }

        // 验证额度：非零额度必须 >= 预占量，否则 Token 完全不可用
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
            // 计算自定义过期时间戳
            const customExpiresAt = newExpiresType === 'custom' && newCustomExpires
                ? Math.floor(new Date(newCustomExpires).getTime() / 1000)
                : undefined;

            // 后端返回完整 UserToken（含完整 token 明文），切换到成功视图供用户仅此一次复制
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

    // 打开删除二次确认弹窗（不再点击即删，防误删不可恢复）
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
        setEditMaxIps(token.max_ips ?? 0);  // 使用 ?? 确保 null/undefined 变为 0
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

        // 验证额度：非零额度必须 >= 预占量，否则 Token 完全不可用
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
                    // 使用双层包装: undefined = 不更新, null = 清空, string = 设置值
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
            // daisyUI dropdown 点选后不会自动收起，无论成败都主动 blur 关闭浮层
            (document.activeElement as HTMLElement | null)?.blur();
            setRenewingId(null);
        }
    };

    // 打开展示创建弹窗：清空上一次成功态与表单
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

    // 关闭创建弹窗并重置成功态与表单（成功视图"完成"与表单"取消"共用）
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

    // Calculate expiration status style
    const getExpiresStatus = (expiresAt?: number) => {
        if (!expiresAt) return 'text-green-500';
        const now = Date.now() / 1000;
        if (expiresAt < now) return 'text-red-500 font-bold';
        if (expiresAt - now < 86400 * 3) return 'text-orange-500'; // Less than 3 days
        return 'text-green-500';
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="h-full flex flex-col p-5 gap-5 max-w-7xl mx-auto w-full"
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

            {/* Token List */}
            <div className="flex-1 overflow-auto bg-white dark:bg-base-100 rounded-2xl shadow-sm border border-gray-100 dark:border-base-200">
                <table className="table table-pin-rows">
                    <thead>
                        <tr className="bg-gray-50/50 dark:bg-base-200/50">
                            <th className="bg-transparent text-gray-500 font-medium py-4">{t('user_token.username', { defaultValue: 'Username' })}</th>
                            <th className="bg-transparent text-gray-500 font-medium py-4">{t('user_token.token', { defaultValue: 'Token' })}</th>
                            <th className="bg-transparent text-gray-500 font-medium py-4">{t('user_token.expires', { defaultValue: 'Expires' })}</th>
                            <th className="bg-transparent text-gray-500 font-medium py-4">{t('user_token.usage', { defaultValue: 'Usage' })}</th>
                            <th className="bg-transparent text-gray-500 font-medium py-4">{t('user_token.ip_limit', { defaultValue: 'IP Limit' })}</th>
                            <th className="bg-transparent text-gray-500 font-medium py-4">{t('user_token.created', { defaultValue: 'Created' })}</th>
                            <th className="bg-transparent text-gray-500 font-medium py-4 text-right">{t('common.actions', { defaultValue: 'Actions' })}</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-base-200">
                        <AnimatePresence mode="popLayout">
                            {tokens.map((token, index) => (
                                <motion.tr
                                    key={token.id}
                                    initial={{ opacity: 0, x: -10 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0, scale: 0.95 }}
                                    transition={{ delay: index * 0.03 }}
                                    className="hover:bg-gray-50/80 dark:hover:bg-base-200/50 transition-colors group"
                                >
                                    <td className="py-4">
                                        <div className="flex items-center gap-3">
                                            <div className="w-8 h-8 rounded-full bg-purple-50 dark:bg-purple-900/20 flex items-center justify-center text-purple-600 font-bold text-xs">
                                                {token.username.substring(0, 2).toUpperCase()}
                                            </div>
                                            <div>
                                                <div className="font-semibold text-gray-900 dark:text-white uppercase tracking-wider text-sm">{token.username}</div>
                                                <div className="text-xs text-gray-500">{token.description || '-'}</div>
                                            </div>
                                        </div>
                                    </td>
                                    <td>
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
                                    <td>
                                        <div className={`text-sm font-medium mb-1 ${getExpiresStatus(token.expires_at)}`}>
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
                                    <td>
                                        <div className="text-sm font-semibold text-gray-700 dark:text-gray-300">{token.total_requests} <span className="text-xs font-normal text-gray-400">reqs</span></div>
                                        <div className="text-xs text-gray-400 mt-0.5">
                                            {(token.total_tokens_used / 1000).toFixed(1)}k tokens
                                        </div>
                                    </td>
                                    <td>
                                        {token.max_ips === 0
                                            ? <span className="px-2 py-0.5 bg-gray-100 dark:bg-base-200 text-gray-500 text-xs rounded-full">{t('user_token.unlimited', { defaultValue: 'Unlimited' })}</span>
                                            : <span className="px-2 py-0.5 bg-orange-50 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400 text-xs font-medium rounded-full border border-orange-100 dark:border-orange-900/30">{token.max_ips} IPs</span>
                                        }
                                        {token.curfew_start && token.curfew_end && (
                                            <div className="text-xs text-gray-400 mt-1.5 flex items-center gap-1 bg-gray-50 dark:bg-base-200 w-fit px-1.5 py-0.5 rounded">
                                                <Clock size={10} className="text-orange-500" />
                                                <span>{token.curfew_start} - {token.curfew_end}</span>
                                            </div>
                                        )}
                                        {(token.daily_quota > 0 || token.monthly_quota > 0) && (
                                            <div className="mt-1.5 space-y-1">
                                                {token.daily_quota > 0 && (() => {
                                                    const pct = Math.min(100, (token.daily_used / token.daily_quota) * 100);
                                                    return (
                                                        <div className="flex items-center gap-1.5">
                                                            <span className="text-xs text-gray-400 w-4">日</span>
                                                            <div
                                                                className="tooltip tooltip-right flex-1"
                                                                data-tip={`日额度：已用 ${token.daily_used.toLocaleString()} / 总额 ${token.daily_quota.toLocaleString()}，剩余 ${Math.max(0, token.daily_quota - token.daily_used).toLocaleString()}（${pct.toFixed(1)}%）`}
                                                            >
                                                                <div className="h-2 bg-gray-100 dark:bg-base-200 rounded-full overflow-hidden min-w-[40px]">
                                                                    <div
                                                                        className={`h-full rounded-full transition-all ${pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-orange-500' : 'bg-blue-500'}`}
                                                                        style={{ width: `${pct}%` }}
                                                                    />
                                                                </div>
                                                            </div>
                                                            <span className="text-xs text-gray-400 tabular-nums">{(token.daily_used / 1000).toFixed(1)}k/{(token.daily_quota / 1000).toFixed(1)}k</span>
                                                        </div>
                                                    );
                                                })()}
                                                {token.monthly_quota > 0 && (() => {
                                                    const pct = Math.min(100, (token.monthly_used / token.monthly_quota) * 100);
                                                    return (
                                                        <div className="flex items-center gap-1.5">
                                                            <span className="text-xs text-gray-400 w-4">月</span>
                                                            <div
                                                                className="tooltip tooltip-right flex-1"
                                                                data-tip={`月额度：已用 ${token.monthly_used.toLocaleString()} / 总额 ${token.monthly_quota.toLocaleString()}，剩余 ${Math.max(0, token.monthly_quota - token.monthly_used).toLocaleString()}（${pct.toFixed(1)}%）`}
                                                            >
                                                                <div className="h-2 bg-gray-100 dark:bg-base-200 rounded-full overflow-hidden min-w-[40px]">
                                                                    <div
                                                                        className={`h-full rounded-full transition-all ${pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-orange-500' : 'bg-purple-500'}`}
                                                                        style={{ width: `${pct}%` }}
                                                                    />
                                                                </div>
                                                            </div>
                                                            <span className="text-xs text-gray-400 tabular-nums">{(token.monthly_used / 1000).toFixed(1)}k/{(token.monthly_quota / 1000).toFixed(1)}k</span>
                                                        </div>
                                                    );
                                                })()}
                                            </div>
                                        )}
                                    </td>
                                    <td className="text-sm text-gray-500">
                                        {formatTime(token.created_at)}
                                    </td>
                                    <td className="text-right">
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
                            ))}
                        </AnimatePresence>
                        {/* 骨架屏仅首次加载（无数据）时显示；刷新已有数据时行保留原位，内容原地更新 */}
                        {loading && tokens.length === 0 && Array.from({ length: 4 }).map((_, i) => (
                            <tr key={`skeleton-${i}`} className="animate-pulse">
                                {Array.from({ length: 7 }).map((__, j) => (
                                    <td key={j} className="py-4">
                                        <div
                                            className="h-4 bg-gray-200 dark:bg-base-300 rounded"
                                            style={{ width: `${40 + ((i * 13 + j * 17) % 45)}%` }}
                                        ></div>
                                    </td>
                                ))}
                            </tr>
                        ))}
                        {tokens.length === 0 && !loading && (
                            <tr>
                                <td colSpan={7} className="py-20">
                                    <div className="flex flex-col items-center justify-center text-gray-400 gap-3">
                                        <div className="p-4 bg-gray-50 dark:bg-base-200 rounded-full">
                                            <Users size={40} className="opacity-20" />
                                        </div>
                                        <p className="text-sm">{t('user_token.no_data', { defaultValue: 'No tokens found' })}</p>
                                        <button
                                            onClick={openCreateModal}
                                            className="text-xs text-blue-500 hover:underline"
                                        >
                                            {t('user_token.create', { defaultValue: 'Create your first token' })}
                                        </button>
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

                        {/* Custom Expiration Time Picker */}
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
