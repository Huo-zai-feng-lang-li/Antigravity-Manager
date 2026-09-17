import React, { useEffect, useState } from 'react';
import { request as invoke } from '../../utils/request';
import { IpRuleManager } from './IpRuleManager';
import type { SecurityMonitorConfig } from '../../types/security';

interface Props {
    refreshKey?: number;
}

export const WhitelistManager: React.FC<Props> = ({ refreshKey }) => {
    const [enabled, setEnabled] = useState(false);

    useEffect(() => {
        invoke<SecurityMonitorConfig>('get_security_config')
            .then(config => setEnabled(config?.whitelist?.enabled ?? false))
            .catch(() => undefined);
    }, [refreshKey]);

    return <IpRuleManager type="whitelist" refreshKey={refreshKey} whitelistEnabled={enabled} />;
};
