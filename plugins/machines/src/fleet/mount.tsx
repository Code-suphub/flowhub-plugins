import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

import { FleetPage } from './FleetPage';
import type { FleetPageProps } from './types';

export interface FleetMount {
  update: (props: FleetPageProps) => void;
  unmount: () => void;
}

/** Mounts the fleet island without owning any host/configuration side effects. */
export function mountFleet(container: Element, props: FleetPageProps): FleetMount {
  const root: Root = createRoot(container);
  flushSync(() => root.render(<FleetPage {...props} />));

  return {
    update(nextProps) {
      root.render(<FleetPage {...nextProps} />);
    },
    unmount() {
      root.unmount();
    },
  };
}
