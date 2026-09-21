import './styles.css';

import { resolveMachinesApi, resolveMachinesRun } from '../api/machines';
import { mountCommand } from '../command/mount';
import { mountHistory } from '../history/mount';
import { mountCollections } from '../collections/mount';
import { HostEditorController, type HostEditorControllerHandle } from '../host-editor/HostEditorController';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { createRef } from 'react';
import { BackupWorkspace, type BackupApi } from '../backup/BackupWorkspace';
import type { FleetActions, FleetPageProps } from './types';
import { mountFleet } from './mount';

type FleetBridgeProps = Omit<FleetPageProps, 'actions'>;
type FleetAction =
  | { type: 'add' }
  | { type: 'selection'; hostIds: readonly string[] }
  | { type: 'collect-selected'; hostIds: readonly string[] }
  | { type: 'collect-host'; hostId: string }
  | { type: 'host-action'; action: 'edit' | 'more'; hostId: string }
  | { type: 'monitor'; enabled: boolean; intervalSeconds: number };
declare global {
  interface Window {
    FlowHubFleet?: { update: (props: FleetBridgeProps) => void };
    FlowHubHostEditor?: { open: (hostId?: string, options?: { copy?: boolean }) => Promise<void>; close: () => void };
    FlowHubHistory?: { mounted: true };
    FlowHubCollections?: ReturnType<typeof mountCollections>;
    FlowHubCommand?: { mounted: true; setTargets: (hostIds: readonly string[]) => void };
  }
}

const commandContainer = document.querySelector('#commandReactRoot');
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

function dispatch(detail: FleetAction): void {
  window.dispatchEvent(new CustomEvent('flowhub:fleet-action', { detail }));
}

const actions: FleetActions = {
  onAddHost: () => dispatch({ type: 'add' }),
  onSelectionChange: (hostIds) => dispatch({ type: 'selection', hostIds }),
  onCollectSelected: (hostIds) => dispatch({ type: 'collect-selected', hostIds }),
  onCollectHost: (hostId) => dispatch({ type: 'collect-host', hostId }),
  onHostAction: (action, host) => dispatch({ type: 'host-action', action, hostId: host.id }),
  onMonitoringChange: ({ enabled, intervalSeconds }) => dispatch({ type: 'monitor', enabled, intervalSeconds }),
};

const container = document.querySelector('#fleetReactRoot');
if (container) {
  const mounted = mountFleet(container, {
    snapshot: { hosts: [], metrics: {}, activeJobs: [] },
    config: { enabled: false, monitoring: false, intervalSeconds: 60 },
    selectedHostIds: [],
    actions,
  });
  window.FlowHubFleet = {
    update: (props) => mounted.update({ ...props, actions }),
  };

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
    onOpenCloudTraffic={(hostId, hostName) => (window as Window & { FlowHubCloudTraffic?: { open: (id: string, name: string) => void } }).FlowHubCloudTraffic?.open(hostId, hostName)}
    onOpenNetdata={(hostId, hostName) => (window as Window & { FlowHubNetdata?: { open: (id: string, name: string) => void } }).FlowHubNetdata?.open(hostId, hostName)}
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
