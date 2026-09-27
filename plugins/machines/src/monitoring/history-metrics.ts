export const HISTORY_METRICS = {
  load: '负载',
  cpu: 'CPU',
  memory: '内存',
  disk: '磁盘',
  rx: '下载速度',
  tx: '上传速度',
} as const;

export type HistoryMetric = keyof typeof HISTORY_METRICS;
export const HISTORY_METRIC_KEYS = Object.keys(HISTORY_METRICS) as HistoryMetric[];

export const HISTORY_RANGES = [
  { value: '3600', label: '最近 1 小时' },
  { value: '86400', label: '最近 1 天' },
  { value: '604800', label: '最近 7 天' },
  { value: '2592000', label: '最近 30 天' },
  { value: '7776000', label: '最近 90 天' },
];
