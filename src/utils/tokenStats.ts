export const TOKEN_STATS_TIME_RANGES = ['hourly', 'daily', 'weekly'] as const;

export type TokenStatsTimeRange = (typeof TOKEN_STATS_TIME_RANGES)[number];

export const DEFAULT_TOKEN_STATS_TIME_RANGE: TokenStatsTimeRange = 'daily';

const TOKEN_STATS_RANGE_STORAGE_KEY = 'antigravity_token_stats_range';

export function parseTokenStatsTimeRange(value: string | null): TokenStatsTimeRange {
    if (value && TOKEN_STATS_TIME_RANGES.includes(value as TokenStatsTimeRange)) {
        return value as TokenStatsTimeRange;
    }
    return getStoredTokenStatsTimeRange();
}

export function getStoredTokenStatsTimeRange(): TokenStatsTimeRange {
    try {
        const stored = localStorage.getItem(TOKEN_STATS_RANGE_STORAGE_KEY);
        if (stored && TOKEN_STATS_TIME_RANGES.includes(stored as TokenStatsTimeRange)) {
            return stored as TokenStatsTimeRange;
        }
    } catch {
        // ignore
    }
    return DEFAULT_TOKEN_STATS_TIME_RANGE;
}

export function setStoredTokenStatsTimeRange(range: TokenStatsTimeRange): void {
    try {
        localStorage.setItem(TOKEN_STATS_RANGE_STORAGE_KEY, range);
    } catch {
        // ignore
    }
}

export function getTimeRangeShortBadge(range: TokenStatsTimeRange): string {
    switch (range) {
        case 'hourly': return 'H';
        case 'daily': return 'D';
        case 'weekly': return 'W';
    }
}
