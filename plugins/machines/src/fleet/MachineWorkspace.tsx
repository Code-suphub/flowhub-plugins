import { useEffect, useRef, type ReactNode } from 'react';
import { Tabs } from '@flowhub/plugin-common/react';
import { CommandWorkspace } from '../command/CommandWorkspace';
import { HistoryWorkspace } from '../history/HistoryWorkspace';
import type { MachinesApi, MachinesRun } from '../api/machines';

const pages = [
  { value: 'fleet', label: '机器', root: 'fleetReactRoot', help: '管理机器、连接配置与监控；选择机器后可切换到远程命令批量操作。' },
  { value: 'command', label: '远程命令', root: 'commandReactRoot', help: '选择目标、输入命令并查看会话输出。每条命令独立执行，不保留目录或环境变量；每批最多 16 台，超时 60 秒。取消本地 SSH 后，远端进程仍可能继续。' },
  { value: 'history', label: '执行记录', root: 'historyReactRoot', help: '按机器和执行状态筛选历史记录。命令输出保存在本机，展开记录时读取完整详情。' },
] as const;

export type MachineTab = typeof pages[number]['value'];

/** Keep the islands mounted so navigation cannot discard commands or running sessions. */
export function MachineWorkspace({ fleet, api, run, available, selectedHostIds, onSelectionChange, activeTab, onTabChange, focusTab }: { fleet: ReactNode; api: MachinesApi | null; run: MachinesRun | null; available: boolean; selectedHostIds: readonly string[]; onSelectionChange: (hostIds: readonly string[]) => void; activeTab: MachineTab; onTabChange: (tab: MachineTab) => void; focusTab: MachineTab | null }) {
  const triggers = useRef<Record<string, HTMLButtonElement | null>>({});
  useEffect(() => {
    if (focusTab === activeTab) triggers.current[activeTab]?.focus();
  }, [activeTab, focusTab]);

  return <Tabs value={activeTab} onValueChange={value => onTabChange(value as MachineTab)}>
    <Tabs.List className="machine-tabs" aria-label="机器管理页面">
      {pages.map(page => <Tabs.Trigger key={page.value} value={page.value} title={page.help} aria-description={page.help} ref={node => { triggers.current[page.value] = node; }}>{page.label}</Tabs.Trigger>)}
    </Tabs.List>
    {pages.map(page => <Tabs.Panel key={page.value} value={page.value} forceMount>
      <div id={`${page.value}Panel`} hidden={activeTab !== page.value}><div id={page.root}>{page.value === 'fleet' ? fleet : page.value === 'command'
        ? <CommandWorkspace api={api} run={run} active={available && activeTab === 'command'} selectedHostIds={selectedHostIds} onSelectionChange={onSelectionChange} />
        : <HistoryWorkspace api={api} active={available && activeTab === 'history'} />}</div></div>
    </Tabs.Panel>)}
  </Tabs>;
}
