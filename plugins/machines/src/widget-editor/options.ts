import type {
  DisplayOptionKey,
  MachineMetricKey,
  StoredMachineWidgetConfig,
} from './types';

export interface DisplayOption {
  value: DisplayOptionKey;
  label: string;
}

export const DISPLAY_OPTIONS: readonly DisplayOption[] = [
  { value: 'traffic', label: '剩余流量（云服务商）' },
  { value: 'cpu', label: 'CPU' },
  { value: 'memory', label: '内存' },
  { value: 'disk', label: '磁盘' },
  { value: 'rx', label: '下载速度' },
  { value: 'tx', label: '上传速度' },
  { value: 'load', label: '负载' },
  { value: 'uptime', label: '运行时间' },
  { value: 'country', label: '地区国旗' },
  { value: 'expiry', label: '到期倒计时' },
] as const;

export const DEFAULT_METRICS: readonly MachineMetricKey[] = [
  'cpu',
  'memory',
  'disk',
];

export const EDITOR_LABELS = {
  machine: '目标机器',
  metrics: '显示指标',
  trafficHint: '剩余流量需先在机器管理 → 云流量中保存该机器的配置。每 5 分钟更新。',
  loading: '正在读取组件配置…',
  noMachines: '没有可用机器，请先在机器管理中添加机器。',
  loaded: (count: number) => `已载入 ${count} 台机器`,
  changed: '配置已修改，保存时将再次验证。',
  valid: '配置有效，可以保存。',
  selectMachine: '请选择目标机器',
  selectMetric: '至少选择一个显示指标',
} as const;

export function selectedOptionsFromConfig(
  config: StoredMachineWidgetConfig | undefined,
): DisplayOptionKey[] {
  const metrics = config?.metrics ?? DEFAULT_METRICS;

  return DISPLAY_OPTIONS.flatMap(({ value }) => {
    if (value === 'country') {
      return config?.showCountry !== false ? [value] : [];
    }
    if (value === 'expiry') {
      return config?.showExpiry !== false ? [value] : [];
    }
    return metrics.includes(value) ? [value] : [];
  });
}
