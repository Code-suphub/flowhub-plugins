import './styles.css';

import { resolveMachinesApi } from '../api/machines';
import { mountHistory } from '../history/mount';
import { mountHostEditor } from '../host-editor/mount';
import type {
  HostEditorActions,
  HostEditorField,
  HostEditorProps,
  HostEditorTab,
  HostEditorValue,
} from '../host-editor/types';
import type { FleetActions, FleetPageProps } from './types';
import { mountFleet } from './mount';

type FleetBridgeProps = Omit<FleetPageProps, 'actions'>;
type HostEditorBridgeProps = Omit<HostEditorProps, 'actions'>;
type FleetAction =
  | { type: 'add' }
  | { type: 'selection'; hostIds: readonly string[] }
  | { type: 'collect-selected'; hostIds: readonly string[] }
  | { type: 'collect-host'; hostId: string }
  | { type: 'host-action'; action: 'edit' | 'more'; hostId: string }
  | { type: 'monitor'; enabled: boolean; intervalSeconds: number };
type HostEditorAction =
  | { type: 'change'; field: HostEditorField; value: HostEditorValue[HostEditorField] }
  | { type: 'tab'; tab: HostEditorTab }
  | { type: 'close' }
  | { type: 'save' }
  | { type: 'retry-ssh' }
  | { type: 'probe-ssh' }
  | { type: 'choose-identity' }
  | { type: 'open-cloud-traffic' }
  | { type: 'open-netdata' };

declare global {
  interface Window {
    FlowHubFleet?: { update: (props: FleetBridgeProps) => void };
    FlowHubHostEditor?: { update: (props: HostEditorBridgeProps) => void };
    FlowHubHistory?: { mounted: true };
  }
}

const historyContainer = document.querySelector('#historyReactRoot');
if (historyContainer) {
  mountHistory(historyContainer, { api: resolveMachinesApi() });
  window.FlowHubHistory = { mounted: true };
  const legacyHistory = document.querySelector<HTMLElement>('#historyLegacy');
  if (legacyHistory) legacyHistory.hidden = true;
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

function dispatchHostEditor(detail: HostEditorAction): void {
  window.dispatchEvent(new CustomEvent('flowhub:host-editor-action', { detail }));
}

const hostEditorActions: HostEditorActions = {
  onChange: (field, value) => dispatchHostEditor({ type: 'change', field, value }),
  onTabChange: (tab) => dispatchHostEditor({ type: 'tab', tab }),
  onClose: () => dispatchHostEditor({ type: 'close' }),
  onSave: () => dispatchHostEditor({ type: 'save' }),
  onRetrySsh: () => dispatchHostEditor({ type: 'retry-ssh' }),
  onProbeSsh: () => dispatchHostEditor({ type: 'probe-ssh' }),
  onChooseIdentity: () => dispatchHostEditor({ type: 'choose-identity' }),
  onOpenCloudTraffic: () => dispatchHostEditor({ type: 'open-cloud-traffic' }),
  onOpenNetdata: () => dispatchHostEditor({ type: 'open-netdata' }),
};

const emptyHostEditorValue: HostEditorValue = {
  id: '',
  connectionType: 'ssh',
  name: '',
  alias: '',
  groupChoice: '',
  group: '',
  countryCode: '',
  expiresLocal: '',
  readOnly: false,
  sshAuth: 'key',
  sshPassword: '',
  sshHostname: '',
  sshUser: '',
  sshPort: '22',
  sshJump: '',
  sshIdentity: '',
  relayScript: '',
  relayCommand: 'n',
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

  // The checked-in HTML remains a no-JavaScript fallback. Once React mounts,
  // retain only the machine editor dialog and remove the duplicated fleet UI.
  const panel = container.closest('#fleetPanel');
  const legacyOverview = panel?.querySelector(':scope > .overview');
  const legacyFleet = panel?.querySelector(':scope > .panel.fleet');
  const hostDialog = legacyFleet?.querySelector(':scope > #hostDialog');
  if (panel && hostDialog) panel.append(hostDialog);
  legacyOverview?.remove();
  legacyFleet?.remove();
}

const hostEditorContainer = document.querySelector('#hostEditorReactRoot');
if (hostEditorContainer) {
  const mounted = mountHostEditor(hostEditorContainer, {
    open: false,
    value: emptyHostEditorValue,
    activeTab: 'basic',
    actions: hostEditorActions,
  });
  window.FlowHubHostEditor = {
    update: (props) => mounted.update({ ...props, actions: hostEditorActions }),
  };

  // The checked-in dialog remains as a no-JavaScript fallback and temporary
  // protocol adapter. React is the only visible editor once this island mounts.
  const legacyHostDialog = document.querySelector<HTMLDialogElement>('#hostDialog');
  if (legacyHostDialog) legacyHostDialog.hidden = true;
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
