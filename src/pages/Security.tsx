import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, BarChart3, ShieldOff, ShieldCheck, Settings, RefreshCw } from 'lucide-react';
import { IpAccessLogs } from '../components/security/IpAccessLogs';
import { IpStatistics } from '../components/security/IpStatistics';
import { BlacklistManager } from '../components/security/BlacklistManager';
import { WhitelistManager } from '../components/security/WhitelistManager';
import { SecurityConfig } from '../components/security/SecurityConfig';

type SecurityTab = 'logs' | 'stats' | 'blacklist' | 'whitelist' | 'config';

const Security: React.FC = () => {
    const { t } = useTranslation();
    const [activeTab, setActiveTab] = useState<SecurityTab>('logs');
    const [refreshKey, setRefreshKey] = useState(0);
    /** 从统计页跳转日志时携带的拦截筛选 */
    const [logsBlockedOnly, setLogsBlockedOnly] = useState(false);

    const tabs: { id: SecurityTab; label: string; icon: React.ReactNode }[] = [
        { id: 'logs', label: t('security.tab_logs'), icon: <FileText size={18} /> },
        { id: 'stats', label: t('security.tab_stats'), icon: <BarChart3 size={18} /> },
        { id: 'blacklist', label: t('security.tab_blacklist'), icon: <ShieldOff size={18} /> },
        { id: 'whitelist', label: t('security.tab_whitelist'), icon: <ShieldCheck size={18} /> },
        { id: 'config', label: t('security.tab_config'), icon: <Settings size={18} /> },
    ];

    return (
        <div className="flex flex-col h-full bg-gray-50 dark:bg-base-100">
            <div className="bg-white dark:bg-base-200 border-b border-gray-200 dark:border-base-300 px-6 py-4 flex items-center justify-between shrink-0">
                <h1 className="text-2xl font-bold">{t('security.title')}</h1>
                {activeTab !== 'config' && (
                    <button
                        className="btn btn-sm btn-ghost gap-2"
                        onClick={() => setRefreshKey(k => k + 1)}
                    >
                        <RefreshCw size={16} />
                        {t('security.refresh')}
                    </button>
                )}
            </div>

            <div className="flex border-b border-gray-200 dark:border-base-300 bg-white dark:bg-base-200 px-6 shrink-0">
                {tabs.map(tab => (
                    <button
                        key={tab.id}
                        className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                            activeTab === tab.id
                                ? 'border-blue-500 text-blue-600'
                                : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                        }`}
                        onClick={() => {
                            setActiveTab(tab.id);
                            if (tab.id !== 'logs') setLogsBlockedOnly(false);
                        }}
                    >
                        {tab.icon}
                        {tab.label}
                    </button>
                ))}
            </div>

            <div className="flex-1 overflow-hidden">
                {activeTab === 'logs' && (
                    <div className="h-full p-4">
                        <IpAccessLogs initialBlockedOnly={logsBlockedOnly} refreshKey={refreshKey} />
                    </div>
                )}
                {activeTab === 'stats' && (
                    <IpStatistics
                        refreshKey={refreshKey}
                        onJumpBlocked={() => {
                            setLogsBlockedOnly(true);
                            setActiveTab('logs');
                        }}
                    />
                )}
                {activeTab === 'blacklist' && (
                    <div className="h-full p-4">
                        <BlacklistManager refreshKey={refreshKey} />
                    </div>
                )}
                {activeTab === 'whitelist' && (
                    <div className="h-full p-4">
                        <WhitelistManager refreshKey={refreshKey} />
                    </div>
                )}
                {activeTab === 'config' && <SecurityConfig />}
            </div>
        </div>
    );
};

export default Security;
