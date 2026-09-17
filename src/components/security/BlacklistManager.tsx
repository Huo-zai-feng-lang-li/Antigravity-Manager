import React from 'react';
import { IpRuleManager } from './IpRuleManager';

interface Props {
    refreshKey?: number;
}

export const BlacklistManager: React.FC<Props> = ({ refreshKey }) => (
    <IpRuleManager type="blacklist" refreshKey={refreshKey} />
);
