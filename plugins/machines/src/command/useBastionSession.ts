import { useEffect, useMemo, useRef, useState } from 'react';
import type { MachinesApi } from '../api/machines';
import type { BastionState, CommandHost } from './types';

export function useBastionSession(api: MachinesApi | null, host: CommandHost | null, active: boolean, onError: (error: string) => void) {
  const key = host ? JSON.stringify([host.id, host.bastion]) : '';
  const scope = useMemo(() => ({ busy: false, version: 0, closed: false }), [api, key, active]);
  const current = useRef(scope);
  current.current = scope;
  const [result, setResult] = useState<{ scope: typeof scope; value: BastionState } | null>(null);
  const [busyScope, setBusyScope] = useState<typeof scope | null>(null);
  const empty: BastionState = { connected: false, output: host ? '尚未连接此机器的会话。' : '请选择一台机器。' };

  useEffect(() => {
    scope.closed = false;
    if (!api || !host || !active) return () => { scope.closed = true; };
    let timer: number | undefined;
    let initial = true;
    async function poll() {
      if (scope.closed) return;
      if (!scope.busy && (initial || !document.hidden)) {
        initial = false;
        const version = scope.version;
        try {
          const value = await api!('bastionState', { hostId: host!.id }) as BastionState;
          if (!scope.closed && current.current === scope && version === scope.version) setResult({ scope, value });
        } catch (error) {
          if (!scope.closed && current.current === scope && version === scope.version) onError(error instanceof Error ? error.message : String(error));
        }
      }
      if (!scope.closed) timer = window.setTimeout(() => void poll(), 1500);
    }
    void poll();
    return () => { scope.closed = true; scope.version++; window.clearTimeout(timer); };
  }, [api, key, active, scope, onError]);

  async function sessionAction(action: string, extra: Record<string, unknown> = {}) {
    if (!api || !host || !active || scope.busy || scope.closed) return;
    scope.busy = true;
    scope.version++;
    setBusyScope(scope);
    onError('');
    try {
      const value = await api(action, { hostId: host.id, ...extra }) as BastionState;
      if (!scope.closed && current.current === scope) setResult({ scope, value });
    } catch (error) {
      if (!scope.closed && current.current === scope) onError(error instanceof Error ? error.message : String(error));
    } finally {
      scope.busy = false;
      if (!scope.closed && current.current === scope) setBusyScope(null);
    }
  }
  return { key, bastion: result?.scope === scope ? result.value : empty, bastionBusy: busyScope === scope, sessionAction };
}
