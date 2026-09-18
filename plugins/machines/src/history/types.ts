import type { MachinesApi } from '../api/machines';

export type HistoryStatus = 'queued' | 'running' | 'success' | 'failed' | 'timeout' | 'cancelled' | 'interrupted';

export interface HistoryJob {
  id: string;
  hostId: string;
  alias: string;
  kind: 'command' | 'collect';
  status: HistoryStatus;
  startedAt: number;
  finishedAt?: number | null;
  exitCode?: number | null;
}

export interface HistoryJobDetail extends HistoryJob {
  command?: string;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
}

export interface HistoryResponse {
  items: readonly HistoryJob[];
  total: number;
  pages: number;
  page: number;
  pageSize: number;
  instances?: readonly { hostId: string; alias: string }[];
}

export interface HistoryHost {
  id: string;
  name: string;
  alias: string;
}

export interface HistoryWorkspaceProps {
  api: MachinesApi | null;
}
