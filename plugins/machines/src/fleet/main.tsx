import './styles.css';

import { resolveMachinesApi, resolveMachinesRun } from '../api/machines';
import { mountCommand } from '../command/mount';
import { mountHistory } from '../history/mount';
import { mountCollections } from '../collections/mount';
import { MonitorSettings } from '../monitoring/MonitorSettings';
import { HostEditorController, type HostEditorControllerHandle } from '../host-editor/HostEditorController';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { createRef } from 'react';
import { BackupWorkspace, type BackupApi } from '../backup/BackupWorkspace';
import { FleetController } from './FleetController';

declare global {
  interface Window {
    FlowHubHostEditor?: { open: (hostId?: string, options?: { copy?: boolean }) => Promise<void>; close: () => void };
    FlowHubHistory?: { mounted: true };
    FlowHubCollections?: ReturnType<typeof mountCollections>;
    FlowHubCommand?: { mounted: true; setTargets: (hostIds: readonly string[]) => void };
  }
}

const commandContainer = document.querySelector('#commandReactRoot');
const monitorSettingsContainer = document.querySelector('#monitorSettingsReactRoot');
if (monitorSettingsContainer) createRoot(monitorSettingsContainer).render(<MonitorSettings api={resolveMachinesApi()} />);
const collectionsContainer = document.querySelector('#collectionsReactRoot');
if (collectionsContainer) window.FlowHubCollections = mountCollections(collectionsContainer, resolveMachinesApi());
const backupContainer = document.querySelector('#backupReactRoot');
if (backupContainer) {
  const invoke = window.FlowHubPlugin?.invoke ?? window.__TAURI__?.core?.invoke;
  const api: BackupApi | null = invoke
    ? (action, password, token) => invoke('backup_api', { action, password, token }) as ReturnType<BackupApi>
    : null;
  createRoot(backupContainer).render(<BackupWorkspace api={api} />);
}

if (commandContainer) {
  const mounted = mountCommand(commandContainer, { api: resolveMachinesApi(), run: resolveMachinesRun() });
  window.FlowHubCommand = { mounted: true, setTargets: mounted.setTargets };
}

const historyContainer = document.querySelector('#historyReactRoot');
if (historyContainer) {
  mountHistory(historyContainer, { api: resolveMachinesApi() });
  window.FlowHubHistory = { mounted: true };
}

const container = document.querySelector('#fleetReactRoot');
if (container) createRoot(container).render(<FleetController api={resolveMachinesApi()} run={resolveMachinesRun()} />);

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
