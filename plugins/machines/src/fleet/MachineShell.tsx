import type { ReactNode } from 'react';
import type { MachinesApi, MachinesRun } from '../api/machines';
import { MachineWorkspace } from './MachineWorkspace';
import { MonitorSettings } from '../monitoring/MonitorSettings';
import { BackupWorkspace, type BackupApi } from '../backup/BackupWorkspace';

export interface MachineShellProps {
  editor: ReactNode;
  backupApi: BackupApi | null;
  collections: ReactNode;
  selectedHostIds: readonly string[];
  onSelectionChange: (hostIds: readonly string[]) => void;
  onMonitorSaved: () => void;
  api: MachinesApi | null;
  run: MachinesRun | null;
  available: boolean;
  version: string;
  notice: { text: string; error: boolean };
  fleet: ReactNode;
}

export function MachineShell({ available, version, notice, fleet, api, run, selectedHostIds, onSelectionChange, onMonitorSaved, backupApi, collections, editor }: MachineShellProps) {
  const embedded = window.parent !== window && new URLSearchParams(location.search).has('embedded');
  return <div className={embedded ? 'machine-shell embedded' : 'machine-shell'}>
    <header className="masthead">
      <div><span className="eyebrow">FLOWHUB / LOCAL OPERATIONS</span><h1>机器管理<span className="version" id="version">{version}</span></h1></div>
      <div className="actions"><div id="monitorSettingsReactRoot"><MonitorSettings api={api} onSaved={onMonitorSaved} /></div><div id="backupReactRoot"><BackupWorkspace api={backupApi} /></div></div>
    </header>
    <div id="notice" className={`notice${notice.error ? ' error' : ''}`} role="status" aria-live="polite">{notice.text}</div>
    <div id="unavailable" className="empty" hidden={available}><h2>机器插件尚未启用</h2><p>请在 FlowHub 设置的「插件市场」中安装或启用。</p></div>
    <main hidden={!available}><div id="machineWorkspaceRoot"><MachineWorkspace fleet={fleet} api={api} run={run} available={available} selectedHostIds={selectedHostIds} onSelectionChange={onSelectionChange} /></div></main>
    <div id="collectionsReactRoot">{collections}</div>
    <div id="hostEditorReactRoot">{editor}</div>
  </div>;
}
