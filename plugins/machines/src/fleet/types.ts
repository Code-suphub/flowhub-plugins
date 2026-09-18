export type FleetHostId = string;

export interface FleetHost {
  id: FleetHostId;
  name: string;
  alias: string;
  group?: string;
  readOnly?: boolean;
}

export interface FleetMetricValues {
  cpu: number;
  memory: number;
  disk: number;
  load: number;
  uptime: number;
}

export type FleetMetricResultStatus =
  | 'success'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'interrupted'
  | 'unknown';

export interface FleetMetric {
  status: FleetMetricResultStatus;
  at: number;
  values?: FleetMetricValues;
  error?: string;
}

export type FleetMetricStatus = FleetMetricResultStatus | 'stale';

export type FleetJobStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'timeout'
  | 'cancelled';

export interface FleetActiveJob {
  id: string;
  hostId: FleetHostId;
  kind: 'collect' | 'command';
  status: 'queued' | 'running';
}

export interface FleetSnapshot {
  hosts: readonly FleetHost[];
  metrics: Readonly<Record<FleetHostId, FleetMetric | undefined>>;
  activeJobs: readonly FleetActiveJob[];
}

export interface FleetConfig {
  enabled: boolean;
  monitoring: boolean;
  intervalSeconds: number;
}

export type FleetHostAction = 'edit' | 'more';

export interface FleetMonitoringChange {
  enabled: boolean;
  intervalSeconds: number;
}

export interface FleetActions {
  onAddHost: () => void;
  onSelectionChange: (hostIds: readonly FleetHostId[]) => void;
  onCollectSelected: (hostIds: readonly FleetHostId[]) => void;
  onCollectHost: (hostId: FleetHostId) => void;
  onHostAction: (action: FleetHostAction, host: FleetHost) => void;
  onMonitoringChange: (next: FleetMonitoringChange) => void;
}

export interface FleetPageProps {
  snapshot: FleetSnapshot;
  config: FleetConfig;
  actions: FleetActions;
  initialSelectedHostIds?: readonly FleetHostId[];
  selectedHostIds?: readonly FleetHostId[];
  className?: string;
  now?: number;
}

export function fleetMetricStatus(
  metric: FleetMetric | undefined,
  intervalSeconds: number,
  now = Date.now(),
): FleetMetricStatus {
  if (!metric) return 'unknown';
  if (now - metric.at > Math.max(120_000, intervalSeconds * 2_000)) return 'stale';
  return metric.status;
}
