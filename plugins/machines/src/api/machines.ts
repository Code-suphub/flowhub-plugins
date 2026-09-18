export type MachinesApi = (
  action: string,
  payload?: Record<string, unknown>,
) => Promise<unknown>;

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
