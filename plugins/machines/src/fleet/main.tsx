import './styles.css';
import './MachineShell.css';
import './themes.css';

import { resolveMachinesApi, resolveMachinesRun } from '../api/machines';
import { createRoot } from 'react-dom/client';
import type { BackupApi } from '../backup/BackupWorkspace';
import { FleetController } from './FleetController';

const workspaceContainer = document.querySelector('#machineAppRoot');
if (workspaceContainer) {
  const invoke = window.FlowHubPlugin?.invoke ?? window.__TAURI__?.core?.invoke;
  const backupApi: BackupApi | null = invoke
    ? (action, password, token) => invoke('backup_api', { action, password, token }) as ReturnType<BackupApi>
    : null;
  const root = createRoot(workspaceContainer);
  root.render(<FleetController api={resolveMachinesApi()} run={resolveMachinesRun()} backupApi={backupApi} />);
}

export { FleetPage, FleetPage as FleetApp } from './FleetPage';
export { mountFleet, type FleetMount } from './mount';
export type {
  FleetActiveJob,
  FleetActions,
  FleetConfig,
  FleetHost,
  FleetHostAction,
  FleetHostId,
  FleetMetric,
  FleetMetricResultStatus,
  FleetMetricStatus,
  FleetMetricValues,
  FleetMonitoringChange,
  FleetPageProps,
  FleetSnapshot,
} from './types';
