import './styles.css';

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
  }
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
