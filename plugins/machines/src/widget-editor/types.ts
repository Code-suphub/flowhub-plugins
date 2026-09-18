export type MachineMetricKey =
  | 'traffic'
  | 'cpu'
  | 'memory'
  | 'disk'
  | 'rx'
  | 'tx'
  | 'load'
  | 'uptime';

export type DisplayOptionKey = MachineMetricKey | 'country' | 'expiry';

export interface MachineRow {
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface MachineSnapshot {
  rows?: MachineRow[];
  [key: string]: unknown;
}

export interface StoredMachineWidgetConfig {
  view?: string;
  row?: string;
  metrics?: MachineMetricKey[];
  showCountry?: boolean;
  showExpiry?: boolean;
}

export interface MachineWidgetConfig {
  view: 'machine';
  row: string;
  metrics: MachineMetricKey[];
  showCountry: boolean;
  showExpiry: boolean;
}

export interface FlowHubWidgetInitContext {
  config?: StoredMachineWidgetConfig;
  snapshot?: MachineSnapshot;
  title?: string;
  preview?: boolean;
}

export interface FlowHubWidgetBridge {
  onInit(callback: (context: FlowHubWidgetInitContext) => void): void;
  editor(validate: () => MachineWidgetConfig): void;
  validate?: () => MachineWidgetConfig;
  invoke<TResult = unknown>(params: Record<string, unknown>): Promise<TResult>;
}

export interface EditorState {
  row: string;
  rows: MachineRow[];
  selected: DisplayOptionKey[];
  initialized: boolean;
}

export type EditorStatusTone = 'muted' | 'success' | 'error';

export interface EditorStatus {
  message: string;
  tone: EditorStatusTone;
}

declare global {
  interface Window {
    FlowHubWidget: FlowHubWidgetBridge;
  }

  var FlowHubWidget: FlowHubWidgetBridge;
}

export {};
