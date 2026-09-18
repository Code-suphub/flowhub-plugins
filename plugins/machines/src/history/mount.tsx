import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { HistoryWorkspace } from './HistoryWorkspace';
import type { HistoryWorkspaceProps } from './types';

export interface HistoryMount {
  unmount: () => void;
}

export function mountHistory(container: Element, props: HistoryWorkspaceProps): HistoryMount {
  const root: Root = createRoot(container);
  root.render(<HistoryWorkspace {...props} />);
  return { unmount: () => root.unmount() };
}
