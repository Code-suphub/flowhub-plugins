import { forwardRef, useImperativeHandle, useRef, useState } from 'react';

import { HostEditor } from './HostEditor';
import type {
  HostEditorActions,
  HostEditorAsyncState,
  HostEditorErrorField,
  HostEditorField,
  HostEditorMachineApi,
  HostEditorOption,
  HostEditorTab,
  HostEditorValue,
} from './types';

interface HostRecord {
  id: string;
  name: string;
  alias: string;
  group?: string;
  countryCode?: string;
  expiresAt?: number | null;
  readOnly?: boolean;
  bastion?: { script: string; target: string; command: string } | null;
}

interface MachineState {
  config: { hosts: readonly HostRecord[] };
}

interface SshProfile {
  alias: string;
  hostname: string;
  user: string;
  port: number;
  proxyJump: string;
  identityFile: string;
}

interface SshReadResult {
  profile: SshProfile;
  revision: string;
  passwordAuth?: boolean;
}

export interface HostEditorControllerHandle {
  open: (hostId?: string, options?: { copy?: boolean }) => Promise<void>;
  close: () => void;
}

interface HostEditorControllerProps {
  api: HostEditorMachineApi | null;
  countryOptions?: readonly HostEditorOption[];
  onSaved?: (host: HostRecord) => void;
}

interface MachineRegion {
  code: string;
  label: string;
}

const EMPTY_VALUE: HostEditorValue = {
  id: '', connectionType: 'ssh', name: '', alias: '', groupChoice: '', group: '', countryCode: '', expiresLocal: '', readOnly: false,
  sshAuth: 'key', sshPassword: '', sshHostname: '', sshUser: '', sshPort: '22', sshJump: '', sshIdentity: '', relayScript: '', relayCommand: 'n',
};

const idle = (message?: string): HostEditorAsyncState => ({ status: 'idle', message });
const errorText = (reason: unknown): string => String(reason instanceof Error ? reason.message : reason).replace(/^(?:Error:\s*)+/, '');
const validAlias = (value: string): boolean => value.length > 0 && value.length <= 128 && !value.startsWith('-') && /^[a-zA-Z0-9._:-]+$/.test(value);
const validToken = (value: string): boolean => value.length > 0 && value.length <= 253 && !value.startsWith('-') && /^[a-zA-Z0-9._:-]+$/.test(value);
const localExpiry = (value?: number | null): string => Number.isFinite(value) ? new Date(Number(value) - new Date(Number(value)).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';

function profileFrom(value: HostEditorValue): SshProfile {
  return { alias: value.alias.trim(), hostname: value.sshHostname.trim(), user: value.sshUser.trim(), port: Number(value.sshPort), proxyJump: value.sshJump.trim(), identityFile: value.sshIdentity.trim() };
}

function profileSignature(value: HostEditorValue): string {
  const profile = profileFrom(value);
  return JSON.stringify({ ...profile, alias: '', passwordAuth: value.sshAuth === 'password' });
}

function validate(value: HostEditorValue, requireProfile: boolean): Partial<Record<HostEditorErrorField, string>> {
  const errors: Partial<Record<HostEditorErrorField, string>> = {};
  if (!value.name.trim()) errors.name = '请输入显示名称';
  if (!validAlias(value.alias.trim())) errors.alias = 'SSH 别名只能包含字母、数字、点、下划线、冒号和连字符，不能以连字符开头';
  if (value.expiresLocal && !Number.isFinite(new Date(value.expiresLocal).getTime())) errors.expiresLocal = '到期时间无效';
  if (value.groupChoice === '__new' && !value.group.trim()) errors.group = '请输入新分组名称';
  if (value.connectionType === 'bastion' && !value.relayScript.trim()) errors.relayScript = '请输入本地 relay 脚本路径';
  if (value.connectionType === 'ssh' && requireProfile) {
    const profile = profileFrom(value);
    if (!validToken(profile.hostname)) errors.sshHostname = profile.hostname ? '请填写有效的 IP 或主机名，不要包含协议、空格或路径' : '请填写主机地址';
    if (!validToken(profile.user)) errors.sshUser = profile.user ? '登录用户名不能包含空格或特殊符号' : '请填写登录用户名，例如 root 或 ubuntu';
    if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) errors.sshPort = 'SSH 端口必须是 1–65535 之间的整数';
  }
  return errors;
}

export const HostEditorController = forwardRef<HostEditorControllerHandle, HostEditorControllerProps>(function HostEditorController({ api, countryOptions, onSaved }, ref) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<HostEditorValue>(EMPTY_VALUE);
  const [tab, setTab] = useState<HostEditorTab>('basic');
  const [groups, setGroups] = useState<readonly string[]>([]);
  const [resolvedCountryOptions, setResolvedCountryOptions] = useState<readonly HostEditorOption[] | undefined>(countryOptions);
  const [errors, setErrors] = useState<Partial<Record<HostEditorErrorField, string>>>({});
  const [loadState, setLoadState] = useState<HostEditorAsyncState>(idle());
  const [testState, setTestState] = useState<HostEditorAsyncState>(idle('尚未测试当前连接'));
  const [operationState, setOperationState] = useState<HostEditorAsyncState>(idle());
  const [saving, setSaving] = useState(false);
  const revision = useRef('');
  const loadedAlias = useRef('');
  const baseline = useRef(profileSignature(EMPTY_VALUE));
  const loadVersion = useRef(0);

  async function readSsh(alias: string, current: HostEditorValue): Promise<HostEditorValue> {
    if (!api) return current;
    setLoadState({ status: 'loading', message: '正在加载这台机器的 SSH 配置…' });
    const result = await api('sshRead', { alias }) as SshReadResult;
    revision.current = result.revision;
    loadedAlias.current = alias;
    const next: HostEditorValue = {
      ...current, sshAuth: result.passwordAuth ? 'password' : 'key', sshPassword: '', sshHostname: result.profile.hostname,
      sshUser: result.profile.user, sshPort: String(result.profile.port), sshJump: result.profile.proxyJump, sshIdentity: result.profile.identityFile,
    };
    baseline.current = profileSignature(next);
    setLoadState({ status: 'success', message: '已加载连接配置。未修改的字段继续沿用现有 SSH 配置。' });
    return next;
  }

  async function openEditor(hostId?: string, options?: { copy?: boolean }): Promise<void> {
    const version = ++loadVersion.current;
    setOpen(true); setTab('basic'); setErrors({}); setTestState(idle('尚未测试当前连接')); setOperationState(idle()); setSaving(false);
    revision.current = ''; loadedAlias.current = ''; baseline.current = profileSignature(EMPTY_VALUE);
    const regions = window.FlowHubMachineRegions;
    setResolvedCountryOptions(countryOptions ?? (regions?.length ? [{ value: '', label: '不设置' }, ...regions.map((region) => ({ value: region.code, label: region.label }))] : undefined));
    if (!api) { setValue(EMPTY_VALUE); return; }
    try {
      const state = await api('state') as MachineState;
      if (version !== loadVersion.current) return;
      setGroups([...new Set(state.config.hosts.map((host) => host.group).filter((group): group is string => Boolean(group)))]);
      const host = hostId ? state.config.hosts.find((item) => item.id === hostId) : undefined;
      if (hostId && !host) throw new Error('目标机器已移除');
      let next: HostEditorValue = host ? {
        ...EMPTY_VALUE, id: options?.copy ? '' : host.id, connectionType: host.bastion ? 'bastion' : 'ssh',
        name: options?.copy ? `${host.name} 副本` : host.name, alias: options?.copy ? '' : host.alias,
        groupChoice: host.group ?? '', group: host.group ?? '', countryCode: host.countryCode ?? '', expiresLocal: localExpiry(host.expiresAt),
        readOnly: Boolean(host.readOnly), relayScript: host.bastion?.script ?? '', relayCommand: host.bastion?.command ?? 'n',
      } : { ...EMPTY_VALUE };
      setValue(next);
      if (host && !host.bastion) {
        try {
          next = await readSsh(host.alias, next);
          if (version !== loadVersion.current) return;
          if (options?.copy) { next = { ...next, id: '', alias: '' }; loadedAlias.current = ''; }
          setValue(next);
        } catch (reason) {
          if (version === loadVersion.current) setLoadState({ status: 'error', message: `配置加载失败：${errorText(reason)}。请重试后保存。` });
        }
      } else setLoadState(idle());
    } catch (reason) {
      if (version === loadVersion.current) setOperationState({ status: 'error', message: errorText(reason) });
    }
  }

  function close(): void { ++loadVersion.current; setOpen(false); setValue((current) => ({ ...current, sshPassword: '' })); }
  useImperativeHandle(ref, () => ({ open: openEditor, close }));

  const change: HostEditorActions['onChange'] = (field, next) => {
    setValue((current) => {
      const updated = { ...current, [field]: next } as HostEditorValue;
      if (field === 'groupChoice' && next !== '__new') updated.group = String(next);
      if (field === 'connectionType') { setLoadState(idle()); setTestState(idle('尚未测试当前连接')); }
      return updated;
    });
    setErrors((current) => { const updated = { ...current }; delete updated[field]; return updated; });
    setOperationState(idle());
  };

  async function save(): Promise<void> {
    if (!api || saving) return;
    const changedProfile = value.connectionType === 'ssh' && (profileSignature(value) !== baseline.current || Boolean(value.id && loadedAlias.current !== value.alias.trim()) || Boolean(value.sshPassword));
    const nextErrors = validate(value, changedProfile);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) { setTab(nextErrors.relayScript || nextErrors.sshHostname || nextErrors.sshUser || nextErrors.sshPort ? 'connection' : 'basic'); return; }
    if (value.connectionType === 'ssh' && loadState.status === 'loading') return;
    if (value.connectionType === 'ssh' && value.id && loadState.status === 'error') { setOperationState({ status: 'error', message: '请先重新加载 SSH 配置。' }); setTab('connection'); return; }
    setSaving(true); setOperationState({ status: 'loading', message: '正在保存机器配置…' });
    let savedSsh = false;
    try {
      if (value.connectionType === 'ssh' && changedProfile) {
        if (!revision.current || loadedAlias.current !== value.alias.trim()) {
          const current = await api('sshRead', { alias: value.alias.trim() }) as SshReadResult;
          revision.current = current.revision;
        }
        const result = await api('sshSave', { profile: profileFrom(value), revision: revision.current, passwordAuth: value.sshAuth === 'password', password: value.sshPassword || null }) as { revision: string };
        revision.current = result.revision; loadedAlias.current = value.alias.trim(); savedSsh = true;
      }
      const state = await api('state') as MachineState;
      const id = value.id || crypto.randomUUID();
      const host: HostRecord = {
        id, name: value.name.trim(), alias: value.alias.trim(), group: value.group.trim(), countryCode: value.countryCode,
        expiresAt: value.expiresLocal ? new Date(value.expiresLocal).getTime() : null, readOnly: value.readOnly,
        bastion: value.connectionType === 'bastion' ? { script: value.relayScript.trim(), target: value.alias.trim(), command: value.relayCommand } : null,
      };
      await api('hosts', { hosts: [...state.config.hosts.filter((item) => item.id !== id), host] });
      const nextValue = { ...value, id, sshPassword: '' };
      setValue(nextValue); baseline.current = profileSignature(nextValue);
      setOperationState({ status: 'success', message: savedSsh ? '机器连接配置已保存。' : '机器已保存。' });
      onSaved?.(host);
      if (!window.machineSettingsReady) setOpen(false);
    } catch (reason) { setOperationState({ status: 'error', message: `${savedSsh ? 'SSH 配置已保存，但机器清单保存失败：' : ''}${errorText(reason)}` }); }
    finally { setSaving(false); }
  }

  async function probe(): Promise<void> {
    if (!api || testState.status === 'loading') return;
    const changedProfile = profileSignature(value) !== baseline.current;
    const nextErrors = validate(value, changedProfile);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) { setTab('connection'); return; }
    if (value.sshPassword || (changedProfile && value.sshAuth === 'password')) { setTestState({ status: 'error', message: '请先保存密码和连接配置，再测试连接。' }); return; }
    setTestState({ status: 'loading', message: '正在执行 SSH 握手与认证…' });
    try {
      const result = await api('sshProbe', changedProfile ? { alias: value.alias.trim(), profile: profileFrom(value) } : { alias: value.alias.trim() }) as { reason: string; durationMs: number };
      setTestState({ status: 'success', message: `${result.reason}（${result.durationMs} ms）` });
    } catch (reason) { setTestState({ status: 'error', message: errorText(reason) }); }
  }

  const actions: HostEditorActions = {
    onChange: change, onTabChange: setTab, onClose: close, onSave: save, onProbeSsh: probe,
    onRetrySsh: async () => {
      try { setValue(await readSsh(value.alias.trim(), value)); } catch (reason) { setLoadState({ status: 'error', message: `配置加载失败：${errorText(reason)}。请重试后保存。` }); }
    },
    onChooseIdentity: async () => {
      if (!api) return;
      try { const result = await api('chooseIdentity') as { canceled?: boolean; path?: string }; if (!result.canceled && result.path) change('sshIdentity', result.path); }
      catch (reason) { setOperationState({ status: 'error', message: errorText(reason) }); }
    },
  };

  return <HostEditor open={open} value={value} activeTab={tab} actions={actions} groups={groups} countryOptions={resolvedCountryOptions} errors={errors} loadState={loadState} testState={testState} operationState={operationState} saving={saving} saved={Boolean(value.id)} monitoringApi={api ?? undefined} />;
});

declare global {
  interface Window {
    machineSettingsReady?: Promise<unknown>;
    FlowHubMachineRegions?: readonly MachineRegion[];
  }
}
