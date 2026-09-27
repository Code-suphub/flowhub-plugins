import type {Container, ImageSummary, Scope} from './api';

export const statusLabels: Record<string, string> = {
  running: '运行中', exited: '已停止', created: '未启动', restarting: '重启中',
  paused: '已暂停', dead: '异常', removing: '移除中',
};

export function isIssue(container: Container): boolean {
  return ['restarting', 'dead'].includes(container.state) || container.status.includes('unhealthy');
}

export function imageReference(image: ImageSummary): string {
  return image.Repository === '<none>' ? image.ID : image.Repository + ':' + image.Tag;
}

export function filterContainers(containers: Container[], scope: Exclude<Scope, 'images' | 'settings'>, query: string, onlyIssues: boolean): Container[] {
  const normalized = query.trim().toLowerCase();
  return containers.filter((container) => {
    if (scope === 'compose' && !container.project) return false;
    if (scope === 'standalone' && container.project) return false;
    if (onlyIssues && !isIssue(container)) return false;
    return !normalized || (container.name + ' ' + container.image + ' ' + container.project).toLowerCase().includes(normalized);
  });
}

export function groupContainers(rows: Container[]): Array<[string, Container[]]> {
  const groups = new Map<string, Container[]>();
  rows.forEach((row) => {
    const group = groups.get(row.project || '');
    if (group) group.push(row);
    else groups.set(row.project || '', [row]);
  });
  return [...groups.entries()];
}

export function sortGroups(groups: Array<[string, Container[]]>, order: string[]): Array<[string, Container[]]> {
  const positions = new Map(order.map((name, index) => [name, index]));
  return [...groups].sort((a, b) => (positions.get(a[0]) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b[0]) ?? Number.MAX_SAFE_INTEGER));
}

export function reorderGroups(groups: Array<[string, Container[]]>, order: string[], source: string, target: string): string[] {
  const names = sortGroups(groups, order).map(([name]) => name);
  const from = names.indexOf(source);
  const to = names.indexOf(target);
  if (from < 0 || to < 0 || from === to) return names;
  names.splice(to, 0, names.splice(from, 1)[0]);
  return names;
}

export function actionAvailability(container: Container | null) {
  return {
    start: Boolean(container && ['exited', 'created'].includes(container.state)),
    stop: Boolean(container && ['running', 'restarting'].includes(container.state)),
    restart: Boolean(container && ['running', 'restarting'].includes(container.state)),
    remove: Boolean(container && ['exited', 'created', 'dead'].includes(container.state)),
  };
}
