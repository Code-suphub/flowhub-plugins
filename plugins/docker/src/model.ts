import type {Container, ImageSummary, Scope} from './api';

export function formatDate(value?: string | null, fallback = '尚未启动'): string {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toLocaleString() : fallback;
}

export const statusLabels: Record<string, string> = {
  running: '运行中', exited: '已停止', created: '未启动', restarting: '重启中',
  paused: '已暂停', dead: '异常', removing: '移除中',
};

export function isIssue(container: Container): boolean {
  return ['restarting', 'dead'].includes(container.state) || container.status.includes('unhealthy');
}

export function imageReference(image: ImageSummary): string {
  if (!image.Repository || image.Repository === '<none>') return image.ID;
  if (image.Tag && image.Tag !== '<none>') return image.Repository + ':' + image.Tag;
  return image.Digest?.startsWith('sha256:') ? image.Repository + '@' + image.Digest : image.ID;
}

export function imageLabel(image: ImageSummary): string {
  return image.Repository && image.Repository !== '<none>' && (!image.Tag || image.Tag === '<none>')
    ? image.Repository + '（无标签）' : imageReference(image);
}

export function imageDeleteLabel(reference: string): string {
  return reference.startsWith('sha256:') ? '删除无标签镜像' : reference.includes('@') ? '删除镜像摘要引用' : '删除镜像标签';
}

export function formatImageBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '未知';
  const unit = Math.min(4, Math.max(0, Math.floor(Math.log10(bytes || 1) / 3)));
  return (bytes / 1000 ** unit).toFixed(unit ? 2 : 0) + ' ' + ['B', 'kB', 'MB', 'GB', 'TB'][unit];
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
