import { useEffect, useRef, useState } from 'react';
import { MachineShell } from './MachineShell';
import type { MachinesApi, MachinesRun } from '../api/machines';
import type { HistoryJob } from '../history/types';
import { FleetPage } from './FleetPage';
import type { FleetActions, FleetActiveJob, FleetHost, FleetSnapshot } from './types';

interface MachineState {
  config: { hosts: (FleetHost & { bastion?: unknown })[]; enabled: boolean; installed: { version: string } | null; monitoring?: boolean; interval: number };
  metrics: FleetSnapshot['metrics'];
  active: (FleetActiveJob & HistoryJob)[];
  history: HistoryJob[];
}
const emptyState: MachineState = { config: { hosts: [], enabled: false, installed: null, interval: 60 }, metrics: {}, active: [], history: [] };

/** Owns application state and supplies the shell through React props. */
export function FleetController({ api, run }: { api: MachinesApi | null; run: MachinesRun | null }) {
  const [state, setState] = useState(emptyState);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState({ text: '', error: false });
  const current = useRef(state);
  const alive = useRef(false);
  const busy = useRef(false);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const message = (text: string, error = false) => {
    if (alive.current) setNotice({ text: text.replace(/^(?:Error:\s*)+/, ''), error });
  };

  useEffect(() => {
    let disposed = false;
    let pending = false;
    let flight: Promise<void> | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    alive.current = true;
    const report = (error: unknown) => { if (!disposed) message(String(error), true); };
    const request = (): Promise<void> => {
      if (disposed || !api) return Promise.resolve();
      pending = true;
      if (flight) return flight;
      flight = (async () => {
        await window.machineSettingsReady;
        while (pending && !disposed) {
          pending = false;
          const next = await api('state') as MachineState;
          if (disposed) return;
          // A mutation during this request requires a fresh response before publishing.
          if (pending) continue;
          current.current = next;
          setState(next);
          setSelected(ids => ids.filter(id => next.config.hosts.some(host => host.id === id)));
          window.FlowHubCollections?.update([...next.active, ...next.history]);
        }
      })().finally(() => { flight = null; });
      return flight;
    };
    refresh.current = request;
    const changed = () => { void request().catch(report); };
    const poll = async () => {
      try { if (!document.hidden) await request(); } catch (error) { report(error); }
      if (!disposed) timer = setTimeout(poll, 2000);
    };
    window.addEventListener('flowhub:hosts-changed', changed);
    void (async () => {
      try {
        await request();
        if (disposed) return;
        if (window.machineSettingsReady) {
          const id = window.machineSettingsContext?.config?.row || new URLSearchParams(location.search).get('row') || (window.parent === window ? current.current.config.hosts[0]?.id : '');
          if (!id || !current.current.config.hosts.some(host => host.id === id)) throw new Error('目标机器已移除');
          await window.FlowHubHostEditor?.open(id);
        }
        if (!api) message('只读浏览器预览 · 安装、机器配置和 SSH 执行请使用 FlowHub 桌面版。此页面没有连接任何机器。');
      } catch (error) { report(error); }
      if (!disposed && api) timer = setTimeout(poll, 2000);
    })();
    return () => {
      disposed = true;
      alive.current = false;
      clearTimeout(timer);
      window.removeEventListener('flowhub:hosts-changed', changed);
    };
  }, [api]);

  const enabled = !!api && !!state.config.installed && state.config.enabled;

  const operate = async (operation: () => Promise<unknown>) => {
    if (!enabled || busy.current) return;
    busy.current = true;
    try { await operation(); await refresh.current(); }
    catch (error) { message(String(error), true); }
    finally { busy.current = false; }
  };
  const select = (ids: readonly string[]) => {
    const valid = ids.filter(id => current.current.config.hosts.some(host => host.id === id));
    setSelected(valid);
  };
  const collect = async (ids: readonly string[]) => {
    if (!enabled || !run) return;
    const hosts = current.current.config.hosts.filter(host => ids.includes(host.id));
    if (!hosts.length || hosts.length > 16) { message('请选择 1–16 台机器', true); return; }
    message(`正在提交 ${hosts.length} 台机器的采集任务…`);
    const results = await Promise.allSettled(hosts.map(host => run({ hostId: host.id, expectedAlias: host.alias, id: crypto.randomUUID(), kind: 'collect', command: null })));
    const rejected = results.filter(result => result.status === 'rejected');
    const failed = results.filter(result => result.status === 'fulfilled' && (result.value as { status?: string })?.status !== 'success');
    const errors = rejected.map(result => String(result.reason)).join('；');
    message(`任务结束：${results.length - rejected.length - failed.length} 成功，${failed.length} 未成功，${rejected.length} 未提交。${errors ? ` ${errors}` : ''}`, !!rejected.length || !!failed.length);
    try { await refresh.current(); } catch (error) { message(String(error), true); }
  };
  const actions: FleetActions = {
    onSelectionChange: select,
    onAddHost: () => { if (enabled) void window.FlowHubHostEditor?.open().catch(error => message(String(error), true)); },
    onCollectSelected: ids => { void collect(ids); },
    onCollectHost: id => { void collect([id]); },
    onMonitoringChange: next => { void operate(() => api!('monitor', { enabled: next.enabled, interval: next.intervalSeconds || 60 })); },
    onHostAction: (action, item) => {
      const host = current.current.config.hosts.find(host => host.id === item.id);
      if (!host) return;
      if (action === 'collections') { window.FlowHubCollections?.open(host); return; }
      if (!enabled) return;
      if (action === 'terminal' && host.readOnly) return;
      if (action === 'edit' || action === 'copy') { void window.FlowHubHostEditor?.open(host.id, { copy: action === 'copy' }).catch(error => message(String(error), true)); return; }
      if (action === 'command') { select([host.id]); window.FlowHubMachineTabs?.show('command', true); return; }
      void operate(async () => {
        if (action === 'terminal') await api!(host.bastion ? 'bastionTerminal' : 'terminal', { hostId: host.id });
        if (action === 'delete') {
          const latest = await api!('state') as MachineState;
          if (!latest.config.enabled || !latest.config.installed) return;
          await api!('hosts', { hosts: latest.config.hosts.filter(item => item.id !== host.id) });
        }
      });
    },
  };
  return <MachineShell
    selectedHostIds={selected}
    onSelectionChange={select}
    api={api}
    run={run}
    available={!!state.config.installed && state.config.enabled}
    version={state.config.installed ? `v${state.config.installed.version}${state.config.enabled ? '' : ' · 已停用'}` : '未安装'}
    notice={notice}
    fleet={<FleetPage snapshot={{ hosts: state.config.hosts, metrics: state.metrics, activeJobs: state.active }} config={{ enabled, monitoring: !!state.config.monitoring, intervalSeconds: state.config.interval || 60 }} selectedHostIds={selected} actions={actions} now={Date.now()} />}
  />;
}

declare global {
  interface Window {
    machineSettingsContext?: { config?: { row?: string } };
    FlowHubMachineTabs?: { show: (name: string, focus?: boolean) => void };
  }
}
