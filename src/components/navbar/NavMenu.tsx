import { Link, useLocation } from 'react-router-dom';
import { NavigationDropdown } from './NavDropdowns';
import { isActive, getCurrentNavItem, type NavItem } from './constants';
import { useConfigStore } from '../../stores/useConfigStore';

interface NavMenuProps {
    navItems: NavItem[];
}

/**
 * 导航菜单组件 - 独立处理响应式
 * 
 * 响应式策略:
 * - ≥ 768px (md): 文字胶囊
 * - 640px - 768px: 图标胶囊 (Logo 显示文字)
 * - 480px - 640px: 图标胶囊 (Logo 隐藏文字)
 * - 375px - 480px: 图标+文字下拉
 * - < 375px: 图标下拉
 */
export function NavMenu({ navItems }: NavMenuProps) {
    const location = useLocation();
    const { isMenuItemHidden } = useConfigStore();

    // 过滤隐藏的菜单项
    const visibleNavItems = navItems.filter(item => !isMenuItemHidden(item.path));

    return (
        <>
            {/* 文字胶囊 (≥ 1120px) */}
            <nav className="max-[1119px]:hidden flex items-center gap-1 bg-gray-100 dark:bg-base-200 rounded-full p-1">
                {visibleNavItems.map((item) => {
                    const active = isActive(location.pathname, item.path);
                    return (
                        <Link
                            key={item.path}
                            to={item.path}
                            draggable="false"
                            className={`
                                px-4 xl:px-6
                                py-2 
                                rounded-full 
                                text-sm 
                                font-medium 
                                transition-all 
                                whitespace-nowrap
                                flex items-center gap-1.5
                                ${active
                                    ? 'bg-gray-900 text-white shadow-sm dark:bg-white dark:text-gray-900'
                                    : 'text-gray-700 hover:text-gray-900 hover:bg-gray-200 dark:text-gray-400 dark:hover:text-base-content dark:hover:bg-base-100'
                                }
                            `}
                        >
                            <span>{item.label}</span>
                            {item.badge && (
                                <span
                                    title={item.badgeLabel}
                                    className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full transition-colors ${
                                        active
                                            ? 'bg-blue-500 text-white dark:bg-blue-600 dark:text-white'
                                            : 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
                                    }`}
                                >
                                    {item.badge}
                                </span>
                            )}
                        </Link>
                    );
                })}
            </nav>

            {/* 图标胶囊 (880px - 1120px) - Logo 显示文字 */}
            <nav className="max-[879px]:hidden min-[1120px]:hidden flex items-center gap-1 bg-gray-100 dark:bg-base-200 rounded-full p-1">
                {visibleNavItems.map((item) => {
                    const active = isActive(location.pathname, item.path);
                    return (
                        <Link
                            key={item.path}
                            to={item.path}
                            draggable="false"
                            className={`
                                relative p-2
                                rounded-full
                                transition-all
                                ${active
                                    ? 'bg-gray-900 text-white shadow-sm dark:bg-white dark:text-gray-900'
                                    : 'text-gray-700 hover:text-gray-900 hover:bg-gray-200 dark:text-gray-400 dark:hover:text-base-content dark:hover:bg-base-100'
                                }
                            `}
                            title={item.badgeLabel ? `${item.label} (${item.badgeLabel})` : item.label}
                        >
                            <item.icon className="w-5 h-5" />
                            {item.badge && (
                                <span className="absolute -top-1 -right-1 flex h-4 min-w-[16px] px-1 items-center justify-center rounded-full bg-blue-500 text-[9px] font-bold text-white shadow-sm ring-1 ring-white dark:ring-base-200">
                                    {item.badge}
                                </span>
                            )}
                        </Link>
                    );
                })}
            </nav>

            {/* 图标胶囊 (640px - 880px) - Logo 隐藏文字 */}
            <nav className="max-[639px]:hidden min-[880px]:hidden flex items-center gap-1 bg-gray-100 dark:bg-base-200 rounded-full p-1">
                {visibleNavItems.map((item) => {
                    const active = isActive(location.pathname, item.path);
                    return (
                        <Link
                            key={item.path}
                            to={item.path}
                            draggable="false"
                            className={`
                                relative p-2
                                rounded-full
                                transition-all
                                ${active
                                    ? 'bg-gray-900 text-white shadow-sm dark:bg-white dark:text-gray-900'
                                    : 'text-gray-700 hover:text-gray-900 hover:bg-gray-200 dark:text-gray-400 dark:hover:text-base-content dark:hover:bg-base-100'
                                }
                            `}
                            title={item.badgeLabel ? `${item.label} (${item.badgeLabel})` : item.label}
                        >
                            <item.icon className="w-5 h-5" />
                            {item.badge && (
                                <span className="absolute -top-1 -right-1 flex h-4 min-w-[16px] px-1 items-center justify-center rounded-full bg-blue-500 text-[9px] font-bold text-white shadow-sm ring-1 ring-white dark:ring-base-200">
                                    {item.badge}
                                </span>
                            )}
                        </Link>
                    );
                })}
            </nav>

            {/* 图标胶囊 (480px - 640px) */}
            <nav className="max-[479px]:hidden min-[640px]:hidden flex items-center gap-1 bg-gray-100 dark:bg-base-200 rounded-full p-1">
                {visibleNavItems.map((item) => {
                    const active = isActive(location.pathname, item.path);
                    return (
                        <Link
                            key={item.path}
                            to={item.path}
                            draggable="false"
                            className={`
                                relative p-2
                                rounded-full
                                transition-all
                                ${active
                                    ? 'bg-gray-900 text-white shadow-sm dark:bg-white dark:text-gray-900'
                                    : 'text-gray-700 hover:text-gray-900 hover:bg-gray-200 dark:text-gray-400 dark:hover:text-base-content dark:hover:bg-base-100'
                                }
                            `}
                            title={item.badgeLabel ? `${item.label} (${item.badgeLabel})` : item.label}
                        >
                            <item.icon className="w-5 h-5" />
                            {item.badge && (
                                <span className="absolute -top-1 -right-1 flex h-4 min-w-[16px] px-1 items-center justify-center rounded-full bg-blue-500 text-[9px] font-bold text-white shadow-sm ring-1 ring-white dark:ring-base-200">
                                    {item.badge}
                                </span>
                            )}
                        </Link>
                    );
                })}
            </nav>

            {/* 图标+文字下拉 (375px - 480px) */}
            <div className="max-[374px]:hidden min-[480px]:hidden block">
                <NavigationDropdown
                    navItems={visibleNavItems}
                    isActive={(path) => isActive(location.pathname, path)}
                    getCurrentNavItem={() => getCurrentNavItem(location.pathname, visibleNavItems)}
                    onNavigate={() => { }}
                    showLabel={true}
                />
            </div>

            {/* 图标下拉 (< 375px) */}
            <div className="min-[375px]:hidden">
                <NavigationDropdown
                    navItems={visibleNavItems}
                    isActive={(path) => isActive(location.pathname, path)}
                    getCurrentNavItem={() => getCurrentNavItem(location.pathname, visibleNavItems)}
                    onNavigate={() => { }}
                    showLabel={false}
                />
            </div>
        </>
    );
}
