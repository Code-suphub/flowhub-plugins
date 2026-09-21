import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Tabs } from '@flowhub/plugin-common/react';
import { CommandWorkspace } from '../command/CommandWorkspace';
import { HistoryWorkspace } from '../history/HistoryWorkspace';
import type { MachinesApi, MachinesRun } from '../api/machines';

const pages = [
  { value: 'fleet', label: '机器', root: 'fleetReactRoot' },
  { value: 'command', label: '远程命令', root: 'commandReactRoot' },
  { value: 'history', label: '执行记录', root: 'historyReactRoot' },
] as const;

/** Keep the islands mounted so navigation cannot discard commands or running sessions. */
export function MachineWorkspace({ fleet, api, run, available }: { fleet: ReactNode; api: MachinesApi | null; run: MachinesRun | null; available: boolean }) {
  const [active, setActive] = useState('fleet');
  const triggers = useRef<Record<string, HTMLButtonElement | null>>({});
  useEffect(() => {
    const bridge = {
      show(name: string, focus = false) {
        if (!pages.some(page => page.value === name)) return;
        setActive(name);
        if (focus) triggers.current[name]?.focus();
      },
    };
    window.FlowHubMachineTabs = bridge;
    return () => {
      if (window.FlowHubMachineTabs === bridge) delete window.FlowHubMachineTabs;
    };
  }, []);
  useEffect(() => {
    const bridge = { mounted: true as const, setTargets: (hostIds: readonly string[]) => {
      window.dispatchEvent(new CustomEvent('flowhub:command-targets', { detail: { hostIds } }));
    } };
    window.FlowHubCommand = bridge;
    return () => { if (window.FlowHubCommand === bridge) delete window.FlowHubCommand; };
  }, []);

  return <Tabs value={active} onValueChange={setActive}>
    <Tabs.List className="machine-tabs" aria-label="机器管理页面">
      {pages.map(page => <Tabs.Trigger key={page.value} value={page.value} ref={node => { triggers.current[page.value] = node; }}>{page.label}</Tabs.Trigger>)}
    </Tabs.List>
    {pages.map(page => <Tabs.Panel key={page.value} value={page.value} forceMount>
      <div id={`${page.value}Panel`} hidden={active !== page.value}><div id={page.root}>{page.value === 'fleet' ? fleet : page.value === 'command'
        ? <CommandWorkspace api={api} run={run} active={available && active === 'command'} />
        : <HistoryWorkspace api={api} active={available && active === 'history'} />}</div></div>
    </Tabs.Panel>)}
  </Tabs>;
}
