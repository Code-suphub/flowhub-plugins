import './styles.css';
import './MachineShell.css';

import { resolveMachinesApi, resolveMachinesRun } from '../api/machines';
import { HostEditorController, type HostEditorControllerHandle } from '../host-editor/HostEditorController';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { createRef } from 'react';
import type { BackupApi } from '../backup/BackupWorkspace';
import { FleetController } from './FleetController';

declare global {
  interface Window {
    FlowHubHostEditor?: { open: (hostId?: string, options?: { copy?: boolean }) => Promise<void>; close: () => void };
  }
}

const workspaceContainer = document.querySelector('#machineAppRoot');
if (workspaceContainer) {
  const invoke = window.FlowHubPlugin?.invoke ?? window.__TAURI__?.core?.invoke;
  const backupApi: BackupApi | null = invoke
    ? (action, password, token) => invoke('backup_api', { action, password, token }) as ReturnType<BackupApi>
    : null;
  const root = createRoot(workspaceContainer);
  flushSync(() => root.render(<FleetController api={resolveMachinesApi()} run={resolveMachinesRun()} backupApi={backupApi} />));
}

const hostEditorContainer = document.querySelector('#hostEditorReactRoot');
if (hostEditorContainer) {
  const controller = createRef<HostEditorControllerHandle>();
  const api = resolveMachinesApi();
  const root = createRoot(hostEditorContainer);
  flushSync(() => root.render(<HostEditorController
    ref={controller}
    api={api}
    onSaved={() => window.dispatchEvent(new CustomEvent('flowhub:hosts-changed'))}
  />));
  window.FlowHubHostEditor = {
    open: (hostId, options) => controller.current?.open(hostId, options) ?? Promise.resolve(),
    close: () => controller.current?.close(),
  };
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
