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

export function actionAvailability(container: Container | null) {
  return {
    start: Boolean(container && ['exited', 'created'].includes(container.state)),
    stop: Boolean(container && ['running', 'restarting'].includes(container.state)),
    restart: Boolean(container && ['running', 'restarting'].includes(container.state)),
    remove: Boolean(container && ['exited', 'created', 'dead'].includes(container.state)),
  };
}
