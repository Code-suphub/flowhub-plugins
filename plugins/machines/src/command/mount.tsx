import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

import { CommandWorkspace } from './CommandWorkspace';
import type { CommandWorkspaceProps } from './types';

export interface CommandMount {
  setTargets: (hostIds: readonly string[]) => void;
  unmount: () => void;
}

export function mountCommand(container: Element, props: CommandWorkspaceProps): CommandMount {
  const root: Root = createRoot(container);
  flushSync(() => root.render(<CommandWorkspace {...props} />));

  return {
    setTargets(hostIds) {
      window.dispatchEvent(new CustomEvent('flowhub:command-targets', { detail: { hostIds } }));
    },
    unmount() {
      root.unmount();
    },
  };
}

