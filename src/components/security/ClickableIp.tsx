import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Check } from 'lucide-react';
import { copyToClipboard } from '../../utils/clipboard';
import { showToast } from '../common/ToastContainer';
import { displayIp, compactIp, isIpv6 } from '../../utils/ipFormat';

interface ClickableIpProps {
    /** 原始完整 IP 或 CIDR 模式 */
    ip: string;
    /** 是否压缩超长 IPv6（默认 true） */
    compact?: boolean;
    /** 是否在右侧展示 v6 小徽标（默认 false） */
    showV6Badge?: boolean;
    /** 容器的 className */
    className?: string;
    /** 文字样式的 className（默认 "font-mono font-medium"） */
    textClassName?: string;
    /** 自定义复制成功的提示文案 */
    copyNotice?: string;
}

export const ClickableIp: React.FC<ClickableIpProps> = ({
    ip,
    compact = true,
    showV6Badge = false,
    className = '',
    textClassName = 'font-mono font-medium',
    copyNotice,
}) => {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);

    if (!ip) return <span className="text-gray-400">-</span>;

    const fullIp = displayIp(ip);
    const displayText = compact ? compactIp(fullIp) : fullIp;
    const v6 = isIpv6(fullIp);

    const handleCopy = async (e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();

        const success = await copyToClipboard(fullIp);
        if (success) {
            setCopied(true);
            const prefix = t('common.copied', '已复制到剪贴板');
            const msg = copyNotice || `${prefix}: ${fullIp}`;
            showToast(msg, 'success');
            setTimeout(() => setCopied(false), 1500);
        }
    };

    return (
        <span
            role="button"
            tabIndex={0}
            onClick={handleCopy}
            onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation();
                    handleCopy(e as unknown as React.MouseEvent);
                }
            }}
            className={`group inline-flex items-center gap-1 cursor-pointer transition-colors duration-150 hover:text-blue-600 dark:hover:text-blue-400 select-none ${className}`}
        >
            <span className={`${textClassName} group-hover:underline underline-offset-2`}>
                {displayText}
            </span>
            {showV6Badge && v6 && (
                <span className="text-[10px] text-gray-400 font-mono">v6</span>
            )}
            <span className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 group-hover:text-blue-500">
                {copied ? (
                    <Check size={12} className="text-emerald-500 stroke-[2.5]" />
                ) : (
                    <Copy size={12} />
                )}
            </span>
        </span>
    );
};

export default ClickableIp;
