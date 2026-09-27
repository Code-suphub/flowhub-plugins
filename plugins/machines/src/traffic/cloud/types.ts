import type { ReactNode } from 'react';

export type CloudProviderId = 'tencent'|'bandwagon'|'aliyun'|'huawei'|'linode'|'vultr'|'aws'|'zgocloud'|'zgocloudCookie'|'localNet'|'localSsh';
export type CloudField = 'region'|'instanceId'|'secretId'|'secretKey'|'token'|'veid'|'apiKey'|'packageId'|'site'|'apiToken'|'cookie'|'xsrfToken'|'serverId'|'limitGB'|'netdataId'|'cycleStart'|'direction';
export type CloudTrafficDraft = { provider: CloudProviderId; clearToken: boolean } & Record<CloudField, string>;
export type CloudProvider = { id: CloudProviderId; name: string; fields: readonly CloudField[]; required: readonly CloudField[]; help: string };
export type CloudTrafficPackage = { TrafficPackageTotal?: number; TrafficUsed?: number; TrafficPackageRemaining?: number; TrafficOverflow?: number; RxBytes?: number; TxBytes?: number; TrafficDirection?: 'both'|'tx'; LimitGB?: number; PercentUsed?: number; DailyAverage?: number; PeriodDays?: number; DaysRemaining?: number; StartTime?: string; EndTime?: string; CoverageStartTime?: string; PartialHistory?: boolean; BootBaseline?: boolean; CycleType?: 'purchaseDay'|'calendarMonth' };
export type CloudTrafficResult = { provider: CloudProviderId; at: string; instanceName?: string; rows: readonly { InstanceId?: string; TrafficPackageSet?: readonly CloudTrafficPackage[] }[]; summary?: { divisor?: number; scope?: string; mode?: string } };
export type CloudTrafficState = { status: 'idle'|'loading'|'success'|'error'; message?: ReactNode; configured?: boolean };
export interface CloudTrafficPanelProps { machineName: string; draft: CloudTrafficDraft; providers?: readonly CloudProvider[]; netdataNodes: readonly { value: string; label: string; disabled?: boolean }[]; result?: CloudTrafficResult; state: CloudTrafficState; busy?: boolean; onChange: <K extends keyof CloudTrafficDraft>(field: K, value: CloudTrafficDraft[K]) => void; }
