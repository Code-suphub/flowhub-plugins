import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  Button,
  Checkbox,
  DialogShell,
  Field,
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

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="host-editor__section">
      <div className="host-editor__section-head">
        <h3>{title}</h3>
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
        {testState.status === 'error' ? (
          <Button size="sm" variant="ghost" onClick={() => void actions.onProbeSsh()}>
            重试测试
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
      <Section title="身份">
        <div className="host-editor__grid host-editor__grid--two">
          <Field label="名称" htmlFor="host-editor-name" error={errors?.name}>
            <Input ref={nameRef} id="host-editor-name" value={value.name} onChange={(event) => change('name', event.currentTarget.value)} placeholder="应用服务 01" />
          </Field>
          <Field label="Alias" htmlFor="host-editor-alias" error={errors?.alias}>
            <Input id="host-editor-alias" value={value.alias} onChange={(event) => change('alias', event.currentTarget.value)} placeholder="prod-app-01" />
          </Field>
        </div>
      </Section>

      <Section title="归属与生命周期">
        <div className="host-editor__grid host-editor__grid--two">
          <Field label="分组" htmlFor="host-editor-group" error={errors?.groupChoice}>
            <Select
              id="host-editor-group"
              value={value.groupChoice}
              options={groupOptions}
              onChange={(next) => change('groupChoice', next)}
            />
          </Field>
          <Field label="国家 / 地区" htmlFor="host-editor-country" error={errors?.countryCode}>
            <Select
              id="host-editor-country"
              value={value.countryCode}
              options={[...countryOptions]}
              onChange={(next) => change('countryCode', next)}
            />
          </Field>
          {value.groupChoice === '__new' ? (
            <Field label="新分组名称" htmlFor="host-editor-group-name" error={errors?.group}>
              <Input id="host-editor-group-name" value={value.group} onChange={(event) => change('group', event.currentTarget.value)} autoFocus />
            </Field>
          ) : null}
          <Field label="到期时间（可选）" htmlFor="host-editor-expires-local" error={errors?.expiresLocal}>
            <Input id="host-editor-expires-local" type="datetime-local" value={value.expiresLocal} onChange={(event) => change('expiresLocal', event.currentTarget.value)} />
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
      </Section>

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
      <Field label="主机地址" htmlFor="host-editor-hostname" error={errors?.sshHostname}>
        <Input id="host-editor-hostname" value={value.sshHostname} onChange={(event) => change('sshHostname', event.currentTarget.value)} placeholder="192.168.1.100" />
      </Field>
      <Field label="登录用户" htmlFor="host-editor-user" error={errors?.sshUser}>
        <Input id="host-editor-user" value={value.sshUser} onChange={(event) => change('sshUser', event.currentTarget.value)} autoComplete="username" placeholder="root 或 ubuntu" />
      </Field>
      <Field label="SSH 端口" htmlFor="host-editor-port" error={errors?.sshPort}>
        <Input
          id="host-editor-port"
          value={value.sshPort}
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
      <Section title="认证方式" hint="凭证只由上层受控状态管理，本组件不会记录或打印密钥。">
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
        {value.sshAuth === 'password' ? (
          <Field label="登录密码" htmlFor="host-editor-password" error={errors?.sshPassword}>
            <Input id="host-editor-password" type="password" value={value.sshPassword} onChange={(event) => change('sshPassword', event.currentTarget.value)} autoComplete="new-password" placeholder="留空保留已保存密码" />
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
        <Field label="脚本路径或内容" htmlFor="host-editor-relay-script" error={errors?.relayScript}>
          <Input id="host-editor-relay-script" value={value.relayScript} onChange={(event) => change('relayScript', event.currentTarget.value)} placeholder="/Users/you/.ssh/relay.sh" />
        </Field>
        <Field label="目标连接指令" htmlFor="host-editor-command" error={errors?.relayCommand}>
          <Select
            id="host-editor-command"
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
    </Section>
  );
}

function ConnectionPanel({ value, errors, actions, loadState, testState, change }: { value: HostEditorValue; errors: HostEditorProps['errors']; actions: HostEditorActions; loadState: HostEditorAsyncState; testState: HostEditorAsyncState; change: HostEditorActions['onChange'] }) {
  const testing = testState.status === 'loading';
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
      <Section title="连接方式">
        <div className="host-editor__connection-type">
          <Field label="连接类型" htmlFor="host-editor-connection-type" error={errors?.connectionType}>
            <Select
              id="host-editor-connection-type"
              value={value.connectionType}
              options={[
                { value: 'ssh', label: '普通 SSH' },
                { value: 'bastion', label: '堡垒机交互会话' },
              ]}
              onChange={(next) => change('connectionType', next as HostConnectionType)}
            />
          </Field>
        </div>
      </Section>
      {isSsh ? <SshPanel value={value} errors={errors} actions={actions} change={change} usesJumpHost={usesJumpHost} onJumpHostChange={handleJumpHostChange} /> : <BastionPanel value={value} errors={errors} change={change} />}
      {isSsh ? (
        <div className="host-editor__test-bar">
          <ConnectionStatus loadState={loadState} testState={testState} actions={actions} />
          <Button variant="secondary" disabled={testing || loadState.status === 'loading'} onClick={() => void actions.onProbeSsh()}>
            {testing ? '测试中…' : '测试连接'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function MonitoringPanel({ saved, actions, hostId, hostName, api }: { saved: boolean; actions: HostEditorActions; hostId: string; hostName: string; api?: HostEditorProps['monitoringApi'] }) {
  if (saved && api) return <MonitoringWorkspace hostId={hostId} hostName={hostName} api={api} />;
  const monitoringHint = saved ? '保存后由机器管理器定时采集。' : '请先保存机器，才能配置监控与流量。';

  return (
    <div className="host-editor__panel-grid">
      <Section title="数据源" hint={monitoringHint}>
        <div className="host-editor__monitor-grid">
          <div className={cx('host-editor__monitor-card', !saved && 'host-editor__monitor-card--locked')}>
            <div className="host-editor__monitor-card-head">
              <strong>云流量</strong>
              <span className="host-editor__monitor-chip">TRAFFIC</span>
            </div>
            <p>按已保存的云服务商配置查询自然月用量。</p>
            <Button size="sm" variant="ghost" disabled={!saved || !actions.onOpenCloudTraffic} onClick={actions.onOpenCloudTraffic}>配置云流量</Button>
          </div>
          <div className={cx('host-editor__monitor-card', !saved && 'host-editor__monitor-card--locked')}>
            <div className="host-editor__monitor-card-head">
              <strong>Netdata</strong>
              <span className="host-editor__monitor-chip">AGENT</span>
            </div>
            <p>读取机器上的 Netdata 节点，展示 CPU、内存、磁盘与流量。</p>
            <Button size="sm" variant="ghost" disabled={!saved || !actions.onOpenNetdata} onClick={actions.onOpenNetdata}>配置 Netdata</Button>
          </div>
        </div>
      </Section>
      {!saved ? <p className="host-editor__locked-note" role="status" aria-live="polite">监控设置将在首次保存后启用。</p> : null}
    </div>
  );
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
  description = '维护机器身份、连接方式与监控入口。所有字段由上层受控保存。',
  className,
}: HostEditorProps) {
  const initialFocusRef = useRef<HTMLInputElement | null>(null);
  const change: HostEditorActions['onChange'] = (field, next) => actions.onChange(field, next);

  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen) actions.onClose();
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={handleOpenChange}
      title={title}
      description={description}
      eyebrow="MACHINE / HOST EDITOR"
      initialFocusRef={initialFocusRef}
      className={cx('host-editor', className)}
      contentClassName="host-editor__shell"
      aria-label="机器编辑器"
      footer={
        activeTab === 'monitoring' ? <Button variant="primary" onClick={actions.onClose}>完成</Button> : <>
          <Button variant="ghost" onClick={actions.onClose}>取消</Button>
          <Button variant="primary" disabled={saving || loadState.status === 'loading'} onClick={() => void actions.onSave()}>
            {saving ? '保存中…' : '保存机器'}
          </Button>
        </>
      }
    >
      <div className="host-editor__body">
        <Tabs value={activeTab} onValueChange={(next) => actions.onTabChange(next as HostEditorTab)}>
          <Tabs.List aria-label="机器编辑器分区" className="host-editor__tabs-list">
            {(Object.keys(TAB_LABELS) as HostEditorTab[]).map((tab) => (
              <Tabs.Trigger key={tab} value={tab} className="host-editor__tab-trigger">
                {TAB_LABELS[tab]}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          <Tabs.Panel value="basic" className="host-editor__tab-panel">
            <BasicPanel value={value} groups={groups} countryOptions={countryOptions} errors={errors} change={change} nameRef={initialFocusRef} />
          </Tabs.Panel>
          <Tabs.Panel value="connection" className="host-editor__tab-panel">
            <ConnectionPanel value={value} errors={errors} actions={actions} loadState={loadState} testState={testState} change={change} />
          </Tabs.Panel>
          <Tabs.Panel value="monitoring" className="host-editor__tab-panel">
            <MonitoringPanel saved={saved} actions={actions} hostId={value.id ?? ''} hostName={value.name || value.alias} api={monitoringApi} />
          </Tabs.Panel>
        </Tabs>
        {loadState.status === 'loading' ? <span className="host-editor__sr-status" role="status" aria-live="polite">正在加载机器配置</span> : null}
        {operationState.status !== 'idle' ? <StatusLine state={operationState} label="保存" /> : null}
      </div>
    </DialogShell>
  );
}
