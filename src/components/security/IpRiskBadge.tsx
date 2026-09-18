import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { IpGeoInfo } from '../../types/security';
import { getRiskMeta, IpThreatCard } from './IpThreatCard';

interface Props {
    ip: string;
    geo?: IpGeoInfo | null;
    className?: string;
    showCardOnHover?: boolean;
    children?: React.ReactNode;
}

export const IpRiskBadge: React.FC<Props> = ({
    ip,
    geo,
    className = '',
    showCardOnHover = true,
    children,
}) => {
    const [popoverOpen, setPopoverOpen] = useState(false);
    const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
    const popoverRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLDivElement>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const rawScore = geo?.risk_score?.trim();
    const risk = getRiskMeta(rawScore);
    const RiskIcon = risk.icon;

    // 是否有可供展示画像的数据（地理位置、风险分、运营商等任意一项）
    const hasData = Boolean(rawScore || geo?.city || geo?.isp || geo?.scene || geo?.country);

    const updatePosition = () => {
        if (!triggerRef.current) return;
        const rect = triggerRef.current.getBoundingClientRect();
        const cardWidth = 360;
        const cardHeight = 210;

        // 优先定位在归属地右侧，留出 12px 间隙，彻底避免压着归属地文字
        let left = rect.right + 12;

        // 若右侧视口空间不足（超出屏幕右侧），则翻转展示在左侧
        if (left + cardWidth > window.innerWidth - 16) {
            left = Math.max(16, rect.left - cardWidth - 12);
        }

        // 垂直方向居中对齐触发区域，并做上下边缘保护
        let top = rect.top + rect.height / 2 - cardHeight / 2;
        if (top < 16) {
            top = 16;
        } else if (top + cardHeight > window.innerHeight - 16) {
            top = Math.max(16, window.innerHeight - cardHeight - 16);
        }

        setCoords({ top, left });
    };

    const handleOpen = () => {
        if (!hasData) return;
        if (timerRef.current) clearTimeout(timerRef.current);
        updatePosition();
        setPopoverOpen(true);
    };

    const handleClose = () => {
        timerRef.current = setTimeout(() => {
            setPopoverOpen(false);
        }, 150);
    };

    // 点击外部关闭
    useEffect(() => {
        if (!popoverOpen) return;
        const handleOutside = (e: MouseEvent) => {
            if (
                popoverRef.current &&
                !popoverRef.current.contains(e.target as Node) &&
                triggerRef.current &&
                !triggerRef.current.contains(e.target as Node)
            ) {
                setPopoverOpen(false);
            }
        };
        document.addEventListener('mousedown', handleOutside);
        return () => document.removeEventListener('mousedown', handleOutside);
    }, [popoverOpen]);

    // 监听滚动与窗口尺寸变化
    useEffect(() => {
        if (!popoverOpen) return;
        const handleScrollOrResize = () => {
            updatePosition();
        };
        window.addEventListener('scroll', handleScrollOrResize, true);
        window.addEventListener('resize', handleScrollOrResize);
        return () => {
            window.removeEventListener('scroll', handleScrollOrResize, true);
            window.removeEventListener('resize', handleScrollOrResize);
        };
    }, [popoverOpen]);

    return (
        <div
            ref={triggerRef}
            className={`relative inline-flex items-center ${className}`}
            onClick={(e) => {
                e.stopPropagation();
                if (popoverOpen) {
                    setPopoverOpen(false);
                } else {
                    handleOpen();
                }
            }}
            onMouseEnter={() => {
                if (showCardOnHover) handleOpen();
            }}
            onMouseLeave={() => {
                if (showCardOnHover) handleClose();
            }}
        >
            {/* 如果传入 children，则以 children 为触发内容 */}
            {children ? (
                children
            ) : (
                /* 默认徽标形态：仅在 risk_score 有值时渲染 */
                rawScore ? (
                    <span
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold border cursor-pointer select-none transition-all duration-150 hover:scale-105 active:scale-95 ${risk.badgeBg}`}
                    >
                        <RiskIcon size={12} className="shrink-0" />
                        <span>{rawScore}</span>
                    </span>
                ) : null
            )}

            {/* Portal 挂载的高性能画像悬停卡片 */}
            {popoverOpen && coords && hasData && createPortal(
                <div
                    ref={popoverRef}
                    style={{
                        position: 'fixed',
                        top: coords.top,
                        left: coords.left,
                        zIndex: 99999,
                    }}
                    className="animate-in fade-in zoom-in-95 duration-150 drop-shadow-2xl pointer-events-auto"
                    onClick={(e) => e.stopPropagation()}
                    onMouseEnter={() => {
                        if (timerRef.current) clearTimeout(timerRef.current);
                    }}
                    onMouseLeave={() => {
                        handleClose();
                    }}
                >
                    <IpThreatCard ip={ip} geo={geo} compact={false} />
                </div>,
                document.body
            )}
        </div>
    );
};

export default IpRiskBadge;
