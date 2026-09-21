import type { MachinesApi, MachinesRun } from '../api/machines';

export interface CommandTemplate {
  name: string;
  command: string;
}

export interface CommandHost {
  id: string;
  name: string;
  alias: string;
  group?: string;
  readOnly?: boolean;
  bastion?: { script: string; target: string; command: string };
}

export interface CommandState {
  config: {
    enabled: boolean;
    hosts: readonly CommandHost[];
    templates?: readonly CommandTemplate[];
    installed?: { templates?: readonly CommandTemplate[] } | null;
    reuseConnections?: boolean;
    connectionIdleSeconds?: number;
  };
}

export type CommandJobStatus = 'queued' | 'running' | 'success' | 'failed' | 'timeout' | 'cancelled' | 'interrupted';

export interface CommandJob {
  id: string;
  hostId: string;
  name: string;
  alias: string;
  command: string;
  status: CommandJobStatus;
  startedAt: number;
  finishedAt?: number | null;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
}

export interface BastionState {
  connected: boolean;
  output: string;
}

export interface CommandWorkspaceProps {
  selectedHostIds: readonly string[];
  onSelectionChange: (hostIds: readonly string[]) => void;
  active?: boolean;
  api: MachinesApi | null;
  run: MachinesRun | null;
}
