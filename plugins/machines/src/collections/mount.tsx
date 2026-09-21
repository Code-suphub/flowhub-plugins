import { createRoot } from 'react-dom/client';
import type { MachinesApi } from '../api/machines';
import type { HistoryHost, HistoryJob } from '../history/types';
import { CollectionWorkspace } from './CollectionWorkspace';

export function mountCollections(container: Element, api: MachinesApi | null) {
  const root = createRoot(container);
  let host: HistoryHost | null = null;
  let jobs: readonly HistoryJob[] = [];
  function render() {
    root.render(<CollectionWorkspace host={host} jobs={jobs} api={api} onClose={() => { host = null; render(); }} />);
  }
  render();
  return {
    open(next: HistoryHost) { host = next; render(); },
    update(next: readonly HistoryJob[]) {
      jobs = next;
      if (host) render();
    },
  };
}
