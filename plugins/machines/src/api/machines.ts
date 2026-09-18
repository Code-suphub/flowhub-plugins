export type MachinesApi = (
  action: string,
  payload?: Record<string, unknown>,
) => Promise<unknown>;

export interface MachinesRunRequest {
  hostId: string;
  expectedAlias: string;
  id: string;
  kind: 'command' | 'collect';
  command?: string | null;
}

export type MachinesRun = (request: MachinesRunRequest) => Promise<unknown>;

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

declare global {
  interface Window {
    FlowHubPlugin?: { invoke?: Invoke };
    __TAURI__?: { core?: { invoke?: Invoke } };
  }
}

export function resolveMachinesApi(): MachinesApi | null {
  const invoke = window.FlowHubPlugin?.invoke ?? window.__TAURI__?.core?.invoke;
  if (!invoke) return null;
  return (action, payload = {}) => invoke('machines_api', { action, payload });
}

export function resolveMachinesRun(): MachinesRun | null {
  const invoke = window.FlowHubPlugin?.invoke ?? window.__TAURI__?.core?.invoke;
  if (!invoke) return null;
  return (request) => invoke('machines_run', request as unknown as Record<string, unknown>);
}
