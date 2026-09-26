import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  Button,
  Checkbox,
  Combobox,
  DialogShell,
  Field,
  HelpPopover,
  Input,
  Select,
  Tabs,
  cx,
} from '@flowhub/plugin-common/react';

import './styles.css';
import type {
  HostAuthMethod,
  HostConnectionType,
  HostEditorActions,
  HostEditorAsyncState,
  HostEditorOption,
  HostEditorProps,
  HostEditorTab,
  HostEditorValue,
} from './types';
import { MonitoringWorkspace } from '../monitoring/MonitoringWorkspace';

const DEFAULT_COUNTRIES: readonly HostEditorOption[] = [
  { value: '', label: '不设置' },
  { value: 'cn', label: '中国大陆' },
  { value: 'sg', label: '新加坡' },
  { value: 'jp', label: '日本' },
  { value: 'us', label: '美国' },
  { value: 'de', label: '德国' },
];

const TAB_LABELS: Record<HostEditorTab, string> = {
  basic: '基础信息',
  connection: '连接配置',
  monitoring: '监控与流量',
};

function StatusLine({ state, label }: { state: HostEditorAsyncState; label: string }) {
  const role = state.status === 'error' ? 'alert' : 'status';
  const message = state.message ?? {
    idle: '尚未测试',
    loading: '正在加载配置…',
    success: '连接测试通过',
    error: '操作失败',
  }[state.status];

  return (
    <p className={cx('host-editor__status', `host-editor__status--${state.status}`)} role={role} aria-live="polite">
      <span className="host-editor__status-dot" aria-hidden="true" />
      <span>{label}：{message}</span>
    </p>
  );
}

function Section({ title, hint, action, children }: { title: string; hint?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="host-editor__section">
      <div className={cx('host-editor__section-head', action ? 'host-editor__section-head--action' : undefined)}>
        <h3>{title}</h3>
        {action}
        {hint ? <p>{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function ConnectionStatus({
  loadState,
  testState,
  actions,
}: {
  loadState: HostEditorAsyncState;
  testState: HostEditorAsyncState;
  actions: HostEditorActions;
}) {
  return (
    <div className="host-editor__status-stack" aria-label="连接状态">
      {loadState.status !== 'idle' ? <StatusLine state={loadState} label="配置" /> : null}
      <StatusLine state={testState} label="测试" />
      <div className="host-editor__status-actions">
        {loadState.status === 'error' && actions.onRetrySsh ? (
          <Button size="sm" variant="ghost" onClick={() => void actions.onRetrySsh?.()}>
            重试加载
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function BasicPanel({
  value,
  groups,
  countryOptions,
  errors,
  change,
  nameRef,
}: {
  value: HostEditorValue;
  groups: readonly string[];
  countryOptions: readonly HostEditorOption[];
  errors: HostEditorProps['errors'];
  change: HostEditorActions['onChange'];
  nameRef: RefObject<HTMLInputElement | null>;
}) {
  const groupOptions = useMemo(
    () => [
      { value: '', label: '未分组' },
      ...groups
        .filter((group) => group.length > 0)
        .filter((group, index, all) => all.indexOf(group) === index)
        .map((group) => ({ value: group, label: group })),
      { value: '__new', label: '＋ 新建分组' },
    ],
    [groups],
  );

  return (
    <div className="host-editor__panel-grid">
      <div className="host-editor__basic">
        <div className="host-editor__grid host-editor__grid--two">
          <Field label="显示名称" htmlFor="host-editor-name" error={errors?.name} required>
            <Input ref={nameRef} id="host-editor-name" name="machine-display-name" autoComplete="off" value={value.name} required onChange={(event) => change('name', event.currentTarget.value)} placeholder="应用服务 01" />
          </Field>
          <Field label="分组" htmlFor="host-editor-group" error={errors?.groupChoice}>
            <Combobox
              placeholder="搜索分组"
              id="host-editor-group"
              value={value.groupChoice}
              options={groupOptions}
              onChange={(next) => change('groupChoice', next)}
            />
          </Field>
          <Field label="国家 / 地区" htmlFor="host-editor-country" error={errors?.countryCode}>
            <Combobox
              placeholder="搜索国家 / 地区或代码"
              emptyMessage="没有匹配的国家 / 地区"
              id="host-editor-country"
              value={value.countryCode}
              options={[...countryOptions]}
              onChange={(next) => change('countryCode', next)}
            />
          </Field>
          {value.groupChoice === '__new' ? (
            <Field label="新分组名称" htmlFor="host-editor-group-name" error={errors?.group} required>
              <Input id="host-editor-group-name" name="machine-group-name" autoComplete="off" value={value.group} required onChange={(event) => change('group', event.currentTarget.value)} autoFocus />
            </Field>
          ) : null}
          <Field label="到期时间" htmlFor="host-editor-expires-local" error={errors?.expiresLocal}>
            <Input
              id="host-editor-expires-local"
              type="datetime-local"
              value={value.expiresLocal}
              onChange={(event) => change('expiresLocal', event.currentTarget.value)}
              onClick={(event) => {
                try {
                  event.currentTarget.showPicker?.();
                } catch {
                  // Some browsers restrict programmatic pickers; keep native editing available.
                }
              }}
            />
          </Field>
        </div>
        <Checkbox
          id="host-editor-read-only"
          label="仅允许查询"
          checked={value.readOnly}
          onChange={(checked) => change('readOnly', checked)}
          className="host-editor__checkbox"
          containerClassName="host-editor__check-row"
          aria-describedby="host-editor-read-only-hint"
        />
        <p id="host-editor-read-only-hint" className="host-editor__hint">启用后不会执行远程写入命令。</p>
      </div>

    </div>
  );
}

function EndpointFields({
  value,
  errors,
  change,
  usesJumpHost,
  onJumpHostChange,
}: {
  value: HostEditorValue;
  errors: HostEditorProps['errors'];
  change: HostEditorActions['onChange'];
  usesJumpHost: boolean;
  onJumpHostChange: (usesJumpHost: boolean) => void;
}) {
  return (
    <div className="host-editor__grid host-editor__grid--two">
      <Field label="主机地址" htmlFor="host-editor-hostname" error={errors?.sshHostname} required>
        <Input id="host-editor-hostname" value={value.sshHostname} required onChange={(event) => change('sshHostname', event.currentTarget.value)} placeholder="192.168.1.100" />
      </Field>
      <Field label="登录用户" htmlFor="host-editor-user" error={errors?.sshUser} required>
        <Input id="host-editor-user" value={value.sshUser} required onChange={(event) => change('sshUser', event.currentTarget.value)} autoComplete="off" placeholder="root 或 ubuntu" />
      </Field>
      <Field label="SSH 端口" htmlFor="host-editor-port" error={errors?.sshPort} required>
        <Input
          id="host-editor-port"
          value={value.sshPort}
          required
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={5}
          placeholder="22"
          onChange={(event) => change('sshPort', event.currentTarget.value.replace(/\D/g, '').slice(0, 5))}
        />
      </Field>
      <Field label="连接路径" htmlFor="host-editor-path">
        <Select
          id="host-editor-path"
          value={usesJumpHost ? 'jump' : 'direct'}
          options={[
            { value: 'direct', label: '直接连接' },
            { value: 'jump', label: '经 SSH 跳板机' },
          ]}
          onChange={(next) => onJumpHostChange(next === 'jump')}
        />
      </Field>
      {usesJumpHost ? (
        <Field label="跳板机 SSH 别名" htmlFor="host-editor-proxy-jump" error={errors?.sshJump} className="host-editor__jump-field">
          <Input id="host-editor-proxy-jump" value={value.sshJump} onChange={(event) => change('sshJump', event.currentTarget.value)} placeholder="例如 bastion" />
        </Field>
      ) : null}
    </div>
  );
}

function SshPanel({ value, errors, actions, change, usesJumpHost, onJumpHostChange }: { value: HostEditorValue; errors: HostEditorProps['errors']; actions: HostEditorActions; change: HostEditorActions['onChange']; usesJumpHost: boolean; onJumpHostChange: (usesJumpHost: boolean) => void }) {
  return (
    <>
      <Section title="目标主机">
        <EndpointFields value={value} errors={errors} change={change} usesJumpHost={usesJumpHost} onJumpHostChange={onJumpHostChange} />
      </Section>
      <Section title="认证方式" action={
        <div className="host-editor__auth-switch" role="radiogroup" aria-label="认证方式">
          {(['key', 'password'] as const).map((method: HostAuthMethod) => (
            <button
              key={method}
              type="button"
              role="radio"
              aria-checked={value.sshAuth === method}
              className={cx('host-editor__choice', value.sshAuth === method && 'host-editor__choice--selected')}
              onClick={() => change('sshAuth', method)}
            >
              {method === 'key' ? '私钥' : '密码'}
            </button>
          ))}
        </div>
      }>
        {value.sshAuth === 'password' ? (
          <Field label="登录密码" htmlFor="host-editor-password" error={errors?.sshPassword}>
            <Input id="host-editor-password" type="password" value={value.sshPassword} onChange={(event) => change('sshPassword', event.currentTarget.value)} autoComplete="off" placeholder="留空保留已保存密码" />
          </Field>
        ) : (
          <Field label="私钥路径" htmlFor="host-editor-private-key" error={errors?.sshIdentity}>
            <div className="host-editor__input-action">
              <Input id="host-editor-private-key" value={value.sshIdentity} onChange={(event) => change('sshIdentity', event.currentTarget.value)} placeholder="~/.ssh/id_ed25519" autoComplete="off" />
              {actions.onChooseIdentity ? <Button size="sm" variant="secondary" onClick={() => void actions.onChooseIdentity?.()}>选择文件</Button> : null}
            </div>
          </Field>
        )}
      </Section>
    </>
  );
}

function BastionPanel({ value, errors, change }: { value: HostEditorValue; errors: HostEditorProps['errors']; change: HostEditorActions['onChange'] }) {
  return (
    <Section title="堡垒机连接" hint="机器 Alias 作为目标参数；连接时只发送一次所选指令。">
      <div className="host-editor__bastion-fields">
        <Field label="脚本路径或内容" htmlFor="host-editor-relay-script" error={errors?.relayScript} required>
          <Input id="host-editor-relay-script" value={value.relayScript} required onChange={(event) => change('relayScript', event.currentTarget.value)} placeholder="/Users/you/.ssh/relay.sh" />
        </Field>
        <Field label="目标连接指令" htmlFor="host-editor-command" error={errors?.relayCommand}>
          <Select
            id="host-editor-command"
            className="host-editor__bastion-command"
            value={value.relayCommand}
            options={[
              { value: 'n', label: 'n · 私有云' },
              { value: 's', label: 's · 物理机' },
              { value: 'v', label: 'v · 虚拟机' },
              { value: 'c', label: 'c · 公有云' },
              { value: 'k', label: 'k · Kerberos' },
              { value: 'o', label: 'o · 办公室服务器' },
            ]}
            onChange={(next) => change('relayCommand', next)}
          />
        </Field>
      </div>
    </Section>
  );
}

function ConnectionPanel({ value, errors, actions, loadState, testState, change }: { value: HostEditorValue; errors: HostEditorProps['errors']; actions: HostEditorActions; loadState: HostEditorAsyncState; testState: HostEditorAsyncState; change: HostEditorActions['onChange'] }) {
  const isSsh = value.connectionType === 'ssh';
  const [usesJumpHost, setUsesJumpHost] = useState(Boolean(value.sshJump.trim()));

  useEffect(() => {
    setUsesJumpHost(Boolean(value.sshJump.trim()));
  }, [value.id]);

  useEffect(() => {
    if (value.sshJump.trim()) setUsesJumpHost(true);
  }, [value.sshJump]);

  function handleJumpHostChange(nextUsesJumpHost: boolean): void {
    setUsesJumpHost(nextUsesJumpHost);
    if (!nextUsesJumpHost && value.sshJump) change('sshJump', '');
  }

  return (
    <div className="host-editor__panel-grid">
      <section className="host-editor__section host-editor__section--connection">
        <div className="host-editor__section-head host-editor__section-head--control">
          <h3>连接方式</h3>
          <Select
            id="host-editor-connection-type"
            className="host-editor__connection-select"
            ariaLabel="连接方式"
            ariaDescribedBy={errors?.connectionType ? 'host-editor-connection-type-error' : undefined}
            value={value.connectionType}
            options={[
              { value: 'ssh', label: '普通 SSH' },
              { value: 'bastion', label: '堡垒机交互会话' },
            ]}
            onChange={(next) => change('connectionType', next as HostConnectionType)}
          />
        </div>
        {errors?.connectionType ? <p id="host-editor-connection-type-error" className="host-editor__connection-error" role="alert">{errors.connectionType}</p> : null}
        {!isSsh ? <div className="host-editor__grid host-editor__grid--two host-editor__connection-fields">
          <Field label="堡垒机目标" htmlFor="host-editor-alias" error={errors?.alias} required>
            <Input id="host-editor-alias" value={value.alias} required onChange={(event) => change('alias', event.currentTarget.value)} placeholder="prod-app-01" />
          </Field>
        </div> : null}
      </section>
      {isSsh ? <SshPanel value={value} errors={errors} actions={actions} change={change} usesJumpHost={usesJumpHost} onJumpHostChange={handleJumpHostChange} /> : <BastionPanel value={value} errors={errors} change={change} />}
      {isSsh ? (
        <div className="host-editor__test-bar">
          <ConnectionStatus loadState={loadState} testState={testState} actions={actions} />
        </div>
      ) : null}
    </div>
  );
}

function MonitoringPanel({ saved, hostId, hostName, api, footerTarget }: { saved: boolean; hostId: string; hostName: string; api?: HostEditorProps['monitoringApi']; footerTarget: HTMLElement | null }) {
  if (saved && api) return <MonitoringWorkspace hostId={hostId} hostName={hostName} api={api} footerTarget={footerTarget} />;
  return <p className="host-editor__locked-note" role="status">{saved ? '当前环境无法配置监控，请在 FlowHub 中打开。' : '请先保存机器，才能配置监控与流量。'}</p>;
}

export function HostEditor({
  open,
  value,
  activeTab,
  actions,
  groups = [],
  countryOptions = DEFAULT_COUNTRIES,
  errors = {},
  loadState = { status: 'idle' },
  testState = { status: 'idle' },
  operationState = { status: 'idle' },
  saving = false,
  saved = Boolean(value.id),
  monitoringApi,
  title = value.id ? '编辑机器' : '添加机器',
  description = '显示名称用于机器列表和监控卡片。普通 SSH 填写主机地址与登录用户即可；堡垒机模式还需填写目标标识，用于指定连接脚本要访问的机器。',
  className,
}: HostEditorProps) {
  const initialFocusRef = useRef<HTMLInputElement | null>(null);
  const [monitoringFooterTarget, setMonitoringFooterTarget] = useState<HTMLElement | null>(null);
  const change: HostEditorActions['onChange'] = (field, next) => actions.onChange(field, next);

  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen) actions.onClose();
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={handleOpenChange}
      title={<span className="host-editor__title">{title}{description ? <HelpPopover label="机器字段说明">{description}</HelpPopover> : null}</span>}
      initialFocusRef={initialFocusRef}
      initialFocusSelection="end"
      className={cx('host-editor', className)}
      contentClassName="host-editor__shell"
      aria-label="机器编辑器"
      footer={
        activeTab === 'monitoring' ? <><div ref={setMonitoringFooterTarget} className="host-editor__monitoring-actions" /><Button variant="primary" onClick={actions.onClose}>完成</Button></> : <>
          {activeTab === 'connection' && value.connectionType === 'ssh' ? <Button variant="secondary" disabled={testState.status === 'loading' || loadState.status === 'loading'} onClick={() => void actions.onProbeSsh()}>{testState.status === 'loading' ? '测试中…' : '测试连接'}</Button> : null}
          <Button variant="ghost" onClick={actions.onClose}>取消</Button>
          <Button variant="primary" disabled={saving || loadState.status === 'loading'} onClick={() => void actions.onSave()}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="host-editor__body">
        <Tabs value={activeTab} onValueChange={(next) => actions.onTabChange(next as HostEditorTab)}>
          <div className="host-editor__tabs-bar">
            <Tabs.List aria-label="机器编辑器分区" className="host-editor__tabs-list">
              {(Object.keys(TAB_LABELS) as HostEditorTab[]).map((tab) =>
                <Tabs.Trigger key={tab} value={tab} className="host-editor__tab-trigger">{TAB_LABELS[tab]}</Tabs.Trigger>
              )}
            </Tabs.List>
            <HelpPopover className="host-editor__tab-help" label="监控与流量说明">每台机器配置一个 Netdata Agent，历史保留在 Agent 上。旧版未归属节点可手动关联；云流量配置独立保存在当前机器下。</HelpPopover>
          </div>
          <Tabs.Panel value="basic" className="host-editor__tab-panel">
            <BasicPanel value={value} groups={groups} countryOptions={countryOptions} errors={errors} change={change} nameRef={initialFocusRef} />
          </Tabs.Panel>
          <Tabs.Panel value="connection" className="host-editor__tab-panel">
            <ConnectionPanel value={value} errors={errors} actions={actions} loadState={loadState} testState={testState} change={change} />
          </Tabs.Panel>
          <Tabs.Panel value="monitoring" className="host-editor__tab-panel">
            <MonitoringPanel saved={saved} hostId={value.id ?? ''} hostName={value.name || value.alias} api={monitoringApi} footerTarget={monitoringFooterTarget} />
          </Tabs.Panel>
        </Tabs>
        {loadState.status === 'loading' ? <span className="host-editor__sr-status" role="status" aria-live="polite">正在加载机器配置</span> : null}
        {operationState.status !== 'idle' ? <StatusLine state={operationState} label="保存" /> : null}
      </div>
    </DialogShell>
  );
}
