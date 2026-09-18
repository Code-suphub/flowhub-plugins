import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

import { HostEditor } from './HostEditor';
import type { HostEditorMount, HostEditorProps } from './types';

/** Mounts a controlled host editor. It does not inspect or mutate surrounding DOM. */
export function mountHostEditor(container: Element, props: HostEditorProps): HostEditorMount {
  const root: Root = createRoot(container);
  flushSync(() => root.render(<HostEditor {...props} />));

  return {
    update(nextProps) {
      root.render(<HostEditor {...nextProps} />);
    },
    unmount() {
      root.unmount();
    },
  };
}
