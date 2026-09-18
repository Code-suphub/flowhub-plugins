import type { ReactNode } from 'react';

export type AsyncState = { status: 'idle' | 'loading' | 'success' | 'error'; message?: ReactNode };
export type NetdataInstance = { id: string; name: string; url: string; networkChart: string };
export type NetdataChart = { id: string; units?: string };
export type NetdataDraft = { id?: string; name: string; url: string; networkChart: string };
export type NetdataHistoryQuery = { instanceId: string; chartId: string; seconds: number };
export type NetdataHistory = { chartId: string; labels: readonly string[]; data: readonly (readonly (number | null)[])[]; units?: string };
export type NetdataInstallDraft = { hostId: string; port: number; bind: string; retentionDays: number; diskMiB: number };
export type NetdataInstallPreview = { alias?: string; name?: string; command: string };
export type NetdataSuggestion = { message: ReactNode; url?: string };

export interface NetdataPanelActions {
  onDraftChange: <K extends keyof NetdataDraft>(field: K, value: NetdataDraft[K]) => void;
  onEdit: (instance: NetdataInstance) => void;
  onRemove: (instance: NetdataInstance) => void;
  onTest: () => void;
  onSave: () => void;
  onReset: () => void;
  onHistoryChange: <K extends keyof NetdataHistoryQuery>(field: K, value: NetdataHistoryQuery[K]) => void;
  onQueryHistory: () => void;
  onInstallChange: <K extends keyof NetdataInstallDraft>(field: K, value: NetdataInstallDraft[K]) => void;
  onPreviewInstall: () => void;
  onConfirmInstall: () => void;
  onUseSuggestion: () => void;
}

export interface NetdataPanelProps {
  instances: readonly NetdataInstance[];
  charts: readonly NetdataChart[];
  draft: NetdataDraft;
  historyQuery: NetdataHistoryQuery;
  history?: NetdataHistory;
  installDraft: NetdataInstallDraft;
  installHosts: readonly { value: string; label: string; disabled?: boolean }[];
  installPreview?: NetdataInstallPreview;
  suggestion?: NetdataSuggestion;
  state: AsyncState;
  busy?: boolean;
  actions: NetdataPanelActions;
}
