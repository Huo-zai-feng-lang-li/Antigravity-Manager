import React from 'react';
import { IpRuleManager } from './IpRuleManager';

interface Props {
    refreshKey?: number;
}

export const WhitelistManager: React.FC<Props> = ({ refreshKey }) => (
    <IpRuleManager type="whitelist" refreshKey={refreshKey} />
);
