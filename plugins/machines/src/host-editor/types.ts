import type { ReactNode } from 'react';

export type HostEditorTab = 'basic' | 'connection' | 'monitoring';
export type HostConnectionType = 'ssh' | 'bastion';
export type HostAuthMethod = 'key' | 'password';

export interface HostEditorValue {
  id?: string;
  connectionType: HostConnectionType;
  name: string;
  alias: string;
  groupChoice: string;
  group: string;
  countryCode: string;
  expiresLocal: string;
  readOnly: boolean;
  sshAuth: HostAuthMethod;
  sshPassword: string;
  sshHostname: string;
  sshUser: string;
  sshPort: string;
  sshJump: string;
  sshIdentity: string;
  relayScript: string;
  relayCommand: string;
}

export type HostEditorField =
  | 'connectionType'
  | 'name'
  | 'alias'
  | 'groupChoice'
  | 'group'
  | 'countryCode'
  | 'expiresLocal'
  | 'readOnly'
  | 'sshAuth'
  | 'sshPassword'
  | 'sshHostname'
  | 'sshUser'
  | 'sshPort'
  | 'sshJump'
  | 'sshIdentity'
  | 'relayScript'
  | 'relayCommand';

export type HostEditorFieldValue<Field extends HostEditorField> = HostEditorValue[Field];

export type HostEditorErrorField = HostEditorField;

export interface HostEditorAsyncState {
  status: 'idle' | 'loading' | 'success' | 'error';
  message?: string;
}

export interface HostEditorOption {
  search?: string;
  value: string;
  label: string;
  disabled?: boolean;
}

export type HostEditorMachineApi = (
  action: string,
  payload?: Record<string, unknown>,
) => Promise<unknown>;

export interface HostEditorActions {
  onChange: <Field extends HostEditorField>(field: Field, value: HostEditorFieldValue<Field>) => void;
  onTabChange: (tab: HostEditorTab) => void;
  onClose: () => void;
  onSave: () => void | Promise<void>;
  onProbeSsh: () => void | Promise<void>;
  onRetrySsh?: () => void | Promise<void>;
  onChooseIdentity?: () => void | Promise<void>;
}

export interface HostEditorProps {
  open: boolean;
  value: HostEditorValue;
  activeTab: HostEditorTab;
  actions: HostEditorActions;
  groups?: readonly string[];
  countryOptions?: readonly HostEditorOption[];
  errors?: Partial<Record<HostEditorErrorField, ReactNode>>;
  loadState?: HostEditorAsyncState;
  testState?: HostEditorAsyncState;
  operationState?: HostEditorAsyncState;
  saving?: boolean;
  saved?: boolean;
  monitoringApi?: HostEditorMachineApi;
  title?: ReactNode;
  description?: ReactNode;
  className?: string;
}

export interface HostEditorMount {
  update: (props: HostEditorProps) => void;
  unmount: () => void;
}
