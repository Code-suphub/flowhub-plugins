import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  Button,
  Checkbox,
  Combobox,
  DialogShell,
  MultiCombobox,
  EmptyState,
  HelpPopover,
  Input,
  Select,
  Tabs,
  Textarea,
} from '@flowhub/plugin-common/react';

import { bastionCommandOptions } from './bastionCommands';
import { useBastionSession } from './useBastionSession';

import type {
  CommandHost,
  CommandJob,
  CommandJobStatus,
  CommandState,
  CommandTemplate,
  CommandWorkspaceProps,
} from './types';
import './styles.css';

const STATUS_LABELS: Record<CommandJobStatus, string> = {
  queued: '排队', running: '执行中', success: '成功', failed: '失败', timeout: '超时', cancelled: '已取消', interrupted: '结果未知',
};
const IDLE_OPTIONS = [
  { value: '3600', label: '1 小时' }, { value: '28800', label: '8 小时' },
  { value: '86400', label: '24 小时' }, { value: '604800', label: '7 天' },
];

function errorText(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/^(?:Error:\s*)+/, '');
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function TemplateManager({ initial, busy, onSave }: {
  initial: readonly CommandTemplate[];
  busy: boolean;
  onSave: (templates: readonly CommandTemplate[]) => Promise<void>;
}) {
  const [editing, setEditing] = useState<{ index: number; original: string; draft: CommandTemplate } | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const locked = busy || pending;
  const operation = useRef(false);
  const templateNameRef = useRef<HTMLInputElement>(null);

  function edit(index: number) {
    setError(''); setRemoving(null);
    setEditing({ index, original: JSON.stringify(initial[index]), draft: index < 0 ? { name: '', command: '' } : { ...initial[index] } });
  }

  async function persist(next: readonly CommandTemplate[]) {
    if (locked || operation.current) return;
    operation.current = true; setPending(true); setError('');
    try { await onSave(next); setEditing(null); setRemoving(null); }
    catch (reason) { setError(errorText(reason)); }
    finally { operation.current = false; setPending(false); }
  }

  async function save() {
    if (!editing) return;
    const { draft, index, original } = editing;
    if (!draft.name.trim() || byteLength(draft.name) > 100 || !draft.command.trim() || byteLength(draft.command) > 8192) {
      setError('请填写模板名称（最多 100 字节）和命令（最多 8192 字节）。');
      return;
    }
    if (index >= 0 && JSON.stringify(initial[index]) !== original) { setError('该模板已更新，请取消后重新编辑。'); return; }
    if (index < 0 && initial.length >= 50) { setError('最多保存 50 个模板。'); return; }
    await persist(index < 0 ? [...initial, draft] : initial.map((item, i) => i === index ? draft : item));
  }

  function closeEditor() {
    if (locked) return;
    setEditing(null);
    setError('');
  }

  return <section className="command-react__template-manager" aria-label="命令模板列表">
    <header><Button size="sm" variant="primary" disabled={locked || editing !== null || initial.length >= 50} onClick={() => edit(-1)}>新建模板</Button></header>
    <div className="command-react__template-list">
      {initial.map((item, index) => <section key={index}>
        <div className="command-react__template-row"><strong title={item.name}>{item.name}</strong><code title={item.command}>{item.command.replace(/\s+/g, ' ')}</code>
        <div className="command-react__template-actions">{removing === index ? <><span>删除此模板？</span><Button size="sm" variant="ghost" disabled={locked} onClick={() => setRemoving(null)}>取消</Button><Button size="sm" variant="ghost" disabled={locked} onClick={() => void persist(initial.filter((_, i) => i !== index))}>确认删除</Button></> : <><Button size="sm" variant="ghost" disabled={locked || editing !== null} aria-expanded={editing?.index === index} onClick={() => edit(index)}>编辑</Button><Button size="sm" variant="ghost" disabled={locked || editing !== null} onClick={() => { setRemoving(index); setError(''); }}>删除</Button></>}</div></div>
      </section>)}
      {!initial.length && !editing ? <EmptyState size="compact" title="还没有命令模板" description="点击右上角“新建模板”添加常用命令。" /> : null}
    </div>
    {error && !editing ? <p className="command-react__error" role="alert">{error}</p> : null}
    <DialogShell
      open={editing !== null}
      onOpenChange={next => { if (!next) closeEditor(); }}
      onCancel={event => { if (locked) event.preventDefault(); }}
      title={editing?.index === -1 ? '新建命令模板' : '编辑命令模板'}
      initialFocusRef={templateNameRef}
      initialFocusSelection="end"
      className="command-react__template-dialog"
      footer={<><Button variant="ghost" disabled={locked} onClick={closeEditor}>取消</Button><Button type="submit" form="command-template-form" variant="primary" disabled={locked}>{locked ? '保存中…' : '保存模板'}</Button></>}
    >
      {editing ? <form id="command-template-form" className="command-react__template-editor" autoComplete="off" onSubmit={event => { event.preventDefault(); void save(); }}>
        <label><span>模板名称</span><Input ref={templateNameRef} type="text" name="command-template-title" autoComplete="off" disabled={locked} value={editing.draft.name} maxLength={100} placeholder="例如：查看磁盘使用" onChange={event => setEditing({ ...editing, draft: { ...editing.draft, name: event.target.value } })} /></label>
        <label><span>命令内容</span><Textarea name="command-template-content" autoComplete="off" disabled={locked} rows={4} value={editing.draft.command} placeholder="df -h /" onChange={event => setEditing({ ...editing, draft: { ...editing.draft, command: event.target.value } })} /></label>
        {error ? <p className="command-react__error" role="alert">{error}</p> : null}
      </form> : null}
    </DialogShell>
  </section>;
}

function TargetRail({ hosts, selected, disabled, onChange, actions, confirmation }: {
  hosts: readonly CommandHost[];
  selected: ReadonlySet<string>;
  disabled: boolean;
  onChange: (hostIds: ReadonlySet<string>) => void;
  actions?: ReactNode;
  confirmation?: ReactNode;
}) {
  return <aside className="command-react__targets" aria-label="目标机器">
    <div className="command-react__target-row">
    <MultiCombobox id="command-targets" aria-label="搜索目标机器" placeholder="搜索并选择机器…" emptyMessage="没有匹配的机器" disabled={disabled} maxSelected={16}
      options={hosts.map(host => ({ value: host.id, label: `${host.name}${host.group ? ` · ${host.group}` : ''}`, search: host.alias }))}
      value={[...selected]} onChange={ids => onChange(new Set(ids))} />
    {actions ? <div className="command-react__actionbar" aria-label="堡垒机会话操作">{actions}</div> : <span className="command-react__selection-count">已选 {selected.size}/16</span>}
    </div>
    {confirmation}
  </aside>;
}

function JobConsole({ jobs, selectedHosts, onCancel, onClear }: {
  jobs: readonly CommandJob[];
  selectedHosts: readonly CommandHost[];
  onCancel: (job: CommandJob) => void;
  onClear: () => void;
}) {
  const outputRef = useRef<HTMLDivElement>(null);
  useEffect(() => { outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight }); }, [jobs]);
  const active = jobs.filter((job) => !job.finishedAt).length;
  return <section className="command-react__terminal" aria-label="命令执行输出">
    <header><div><span className="command-react__lamp" aria-hidden="true" />执行输出</div><span>{jobs.length} 条 · {active} 条执行中</span><Button size="sm" variant="ghost" disabled={!jobs.some((job) => job.finishedAt)} onClick={onClear}>清除已完成</Button></header>
    <div ref={outputRef} className="command-react__output" aria-live="polite">
      {jobs.length ? jobs.map((job) => <article key={job.id} className="command-react__job">
        <div><span className={`command-react__job-status command-react__job-status--${job.status}`}>{STATUS_LABELS[job.status] ?? job.status}</span><strong>{job.alias}</strong><time>{new Date(job.startedAt).toLocaleTimeString()}</time>{!job.finishedAt ? <Button size="sm" variant="ghost" onClick={() => onCancel(job)}>取消</Button> : null}</div>
        <pre><b>$ {job.command}</b>{job.stdout ? `\n${job.stdout}` : ''}{job.stderr ? `\n[stderr]\n${job.stderr}` : ''}{job.finishedAt && !job.stdout && !job.stderr ? '\n（无输出）' : ''}</pre>
      </article>) : <div className="command-react__console-empty"><span>$</span><p>{selectedHosts.length ? '输入命令后按 Enter 执行' : '先选择目标机器'}</p></div>}
    </div>
  </section>;
}

export function CommandWorkspace({ api, run, active = true, selectedHostIds, onSelectionChange }: CommandWorkspaceProps) {
  const [state, setState] = useState<CommandState | null>(null);
  const selected = useMemo(() => new Set(selectedHostIds), [selectedHostIds]);
  const [command, setCommand] = useState('');
  const [jobs, setJobs] = useState<readonly CommandJob[]>([]);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [workspaceView, setWorkspaceView] = useState<'execute' | 'templates' | 'sessions'>('execute');
  const [templateBusy, setTemplateBusy] = useState(false);
  const [query, setQuery] = useState('uptime');
  const [sessionDraft, setSessionDraft] = useState({ key: '', text: '', secret: false });
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const bastionOutputRef = useRef<HTMLPreElement>(null);
  const followOutput = useRef(true);
  const history = useRef<string[]>([]);
  const historyIndex = useRef(0);
  const historyDraft = useRef('');
  const loadVersion = useRef(0);

  const load = useCallback(async () => {
    if (!api) return;
    const version = ++loadVersion.current;
    try {
      const next = await api('state') as CommandState;
      if (version !== loadVersion.current) return;
      setState(next);
      setError('');
    } catch (reason) { if (version === loadVersion.current) setError(errorText(reason)); }
  }, [api]);

  useEffect(() => {
    if (active) void load();
    return () => { loadVersion.current++; };
  }, [active, load]);

  const [configFile, setConfigFile] = useState('');
  const [sharedSessions, setSharedSessions] = useState<{id:string;alias:string;type:string;attached:boolean;busy:boolean;dead:boolean;config_file:string}[]>([]);
  const [sharedBusy, setSharedBusy] = useState(false);
  async function refreshSessions() {
    if (!api) return;
    try { const value = await api('sharedSessions') as {sessions:typeof sharedSessions}; setSharedSessions(value.sessions); }
    catch (reason) { setError(errorText(reason)); }
  }
  async function saveSharedConfig() {
    if (!api) return;
    setSharedBusy(true); setError('');
    try {
      const value = await api('sharedConfig', configFile.trim() ? {path:configFile.trim()} : {}) as CommandState;
      setState(value); setNotice('已切换共享连接配置。工具与机器管理使用同一套会话。'); await refreshSessions();
    } catch (reason) { setError(errorText(reason)); }
    finally { setSharedBusy(false); }
  }
  const hosts = state?.config.hosts ?? [];
  const selectedHosts = useMemo(() => hosts.filter((host) => selected.has(host.id)), [hosts, selected]);
  const bastionHost = selectedHosts.length === 1 && (selectedHosts[0]?.bastion || state?.config.sharedConfigFile) ? selectedHosts[0] : null;
  const hasBastion = (!!state?.config.sharedConfigFile && selectedHosts.length === 1) || selectedHosts.some((host) => host.bastion);
  const templates = state?.config.templates ?? state?.config.installed?.templates ?? [];

  const { key: sessionKey, bastion, bastionBusy, sessionAction } = useBastionSession(api, bastionHost, active && workspaceView === 'execute', setError);
  const sessionStatus = bastionBusy ? '通信中…' : bastion.phase ? ({ disconnected: bastion.paused ? '自动连接已暂停' : '未连接', authenticating: '等待认证', connecting: '连接目标中', gateway: '已返回网关', ready: '已连接', busy: '会话运行中', failed: '连接已退出' }[bastion.phase]) : bastion.connected ? '会话在线' : '未连接';
  const sessionInput = sessionDraft.key === sessionKey ? sessionDraft.text : '';
  const secret = sessionDraft.key === sessionKey && sessionDraft.secret;
  function setSessionInput(text: string) { setSessionDraft({ key: sessionKey, text, secret }); }
  function setSecret(value: boolean) { setSessionDraft({ key: sessionKey, text: sessionInput, secret: value }); }
  const selectionKey = [...selectedHostIds].sort().join('\0');
  useEffect(() => {
    setConfirmDisconnect(false);
    setSessionDraft({ key: sessionKey, text: '', secret: false });
    setCommand(''); setQuery('uptime'); followOutput.current = true;
    history.current = []; historyIndex.current = 0; historyDraft.current = '';
  }, [sessionKey, selectionKey]);

  useEffect(() => {
    const output = bastionOutputRef.current;
    if (output && followOutput.current) output.scrollTop = output.scrollHeight;
  }, [bastion.output, sessionKey]);

  function updateSelection(next: ReadonlySet<string>) {
    onSelectionChange([...next]);
  }

  async function saveConnection(reuse: boolean, idleSeconds: number) {
    if (!api || !state) return;
    setState({ ...state, config: { ...state.config, reuseConnections: reuse, connectionIdleSeconds: idleSeconds } });
    try {
      const next = await api('connectionSettings', { reuse, idleSeconds }) as CommandState;
      setState(next);
      setNotice('连接偏好已保存，对后续命令、采集和系统终端生效。');
      setError('');
    } catch (reason) { setError(errorText(reason)); await load(); }
  }

  async function execute(hostList: readonly CommandHost[], value: string) {
    if (!run) { setError('当前环境没有命令执行桥。'); return; }
    if (!hostList.length || hostList.length > 16 || !value.trim() || byteLength(value) > 8192) {
      setError('请选择 1–16 台机器，并输入不超过 8192 字节的命令。'); return;
    }
    followOutput.current = true;
    setRunning(true); setError(''); setNotice(`正在向 ${hostList.length} 台机器提交命令…`);
    const pending = hostList.map((host) => ({ id: crypto.randomUUID(), hostId: host.id, name: host.name, alias: host.alias, command: value, status: 'queued' as const, startedAt: Date.now(), finishedAt: null }));
    setJobs((current) => [...current, ...pending].slice(-100));
    const results = await Promise.allSettled(pending.map(async (job) => {
      setJobs((current) => current.map((item) => item.id === job.id ? { ...item, status: 'running' } : item));
      try {
        const result = await run({ hostId: job.hostId, expectedAlias: job.alias, expectedRevision: state?.targetRevisions?.[job.hostId], id: job.id, kind: 'command', command: value }) as Partial<CommandJob>;
        setJobs((current) => current.map((item) => item.id === job.id ? { ...item, ...result, status: result.status ?? 'success', finishedAt: result.finishedAt ?? Date.now() } : item));
        return result;
      } catch (reason) {
        setJobs((current) => current.map((item) => item.id === job.id ? { ...item, status: 'failed', stderr: errorText(reason), finishedAt: Date.now() } : item));
        throw reason;
      }
    }));
    if (hostList.length === 1 && hostList[0]?.bastion) await sessionAction('bastionState');
    const rejected = results.filter((result) => result.status === 'rejected').length;
    const unsuccessful = results.filter((result) => result.status === 'fulfilled' && result.value.status && result.value.status !== 'success').length;
    setNotice(`任务结束：${results.length - rejected - unsuccessful} 成功，${unsuccessful} 未成功，${rejected} 未提交。`);
    if (rejected || unsuccessful) {
      const failed = results.find((result) => result.status === 'rejected' || (result.status === 'fulfilled' && result.value.status && result.value.status !== 'success'));
      setError(failed?.status === 'rejected' ? errorText(failed.reason) : failed?.status === 'fulfilled' && failed.value.stderr ? failed.value.stderr : '部分命令未成功，请查看执行记录或控制台输出。');
    }
    setRunning(false);
    if (!rejected && !unsuccessful) void load();
  }

  function submitCommand() {
    const value = command;
    if (running || !value.trim()) return;
    if (history.current.at(-1) !== value) history.current = [...history.current.slice(-99), value];
    historyIndex.current = history.current.length; historyDraft.current = '';
    setCommand('');
    void execute(selectedHosts, value);
  }

  function commandKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitCommand(); return; }
    if (!['ArrowUp', 'ArrowDown'].includes(event.key) || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || command.includes('\n') || !history.current.length) return;
    event.preventDefault();
    if (historyIndex.current === history.current.length) historyDraft.current = command;
    historyIndex.current = Math.max(0, Math.min(history.current.length, historyIndex.current + (event.key === 'ArrowUp' ? -1 : 1)));
    setCommand(historyIndex.current === history.current.length ? historyDraft.current : history.current[historyIndex.current] ?? '');
  }

  async function saveTemplates(next: readonly CommandTemplate[]) {
    if (!api) return;
    setTemplateBusy(true);
    try { setState(await api('templates', { templates: next }) as CommandState); setNotice('命令模板已保存。'); }
    finally { setTemplateBusy(false); }
  }

  if (!api || !run) return <section className="command-react"><EmptyState title="远程命令仅在 FlowHub 中可用" description="当前浏览器环境没有插件调用桥。" /></section>;
  if (!state) return <section className="command-react"><EmptyState title={error || '正在读取命令工作台…'} /></section>;

  return <section className="command-react" aria-label="远程命令">
    <Tabs value={workspaceView} onValueChange={(value) => setWorkspaceView(value as 'execute' | 'templates' | 'sessions')} className="command-react__workspace-tabs">
      <Tabs.List aria-label="远程命令工作区" className="command-react__subtabs">
        <Tabs.Trigger value="execute" className="command-react__subtab" title="选择目标机器、输入命令，再执行；输出显示在当前工作区。">执行命令</Tabs.Trigger>
        <Tabs.Trigger value="sessions" className="command-react__subtab">连接与会话</Tabs.Trigger>
        <Tabs.Trigger value="templates" className="command-react__subtab" title="集中维护常用命令，一次编辑一条，保存后生效。选择模板只会填入命令，不会自动执行。">命令模板</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Panel value="execute" forceMount className="command-react__workspace-panel">
        <div className="command-react__layout">
      <TargetRail hosts={hosts} selected={selected} disabled={!state.config.enabled} onChange={updateSelection}
        actions={bastionHost ? <>
          <Button variant="primary" disabled={bastionBusy || bastion.connected} onClick={() => void sessionAction('bastionStart')}>连接</Button>
          <Button aria-label="系统终端附着" disabled={bastionBusy || !bastion.connected || !!bastionHost.readOnly} onClick={() => void sessionAction('bastionTerminal')}>系统终端</Button>
          <Button disabled={bastionBusy || !bastion.connected || !!bastionHost.readOnly} onClick={() => void sessionAction('bastionSend', { key: 'C-c' })}>Ctrl+C</Button>
          <Button variant="danger" disabled={bastionBusy || (!bastion.connected && bastion.phase !== 'failed') || confirmDisconnect} onClick={() => setConfirmDisconnect(true)}>断开</Button>
          <span className={`command-react__connection-status${bastion.phase === 'ready' ? ' is-connected' : ''}`} role="status">{sessionStatus}</span>
          <HelpPopover label="堡垒机会话说明">目标：{bastionHost.alias}。页面与系统终端共享同一会话，断开会终止该会话并暂停自动连接。遮盖输入框仅隐藏当前输入，远端终端仍可能回显；密码应在远端关闭回显的认证提示中输入。</HelpPopover>
        </> : null}
        confirmation={bastionHost && confirmDisconnect ? <div className="command-react__disconnect-confirmation" role="group" aria-label="确认断开共享会话"><span className="command-react__confirm">确定终止共享会话？</span><Button variant="danger" disabled={bastionBusy} onClick={() => { setConfirmDisconnect(false); void sessionAction('bastionStop'); }}>确认断开</Button><Button variant="ghost" onClick={() => setConfirmDisconnect(false)}>取消</Button></div> : null}
      />
      <div className="command-react__main">
        {hasBastion ? <section className="command-react__bastion">
          {!bastionHost ? <EmptyState size="compact" title="请选择一台机器" description="清除其他目标后即可连接共享会话。" /> : <>
            <div className="command-react__query"><Combobox className="command-react__session-command" aria-label={bastionHost.readOnly ? '选择查询命令' : '选择模板或输入命令'} value={query} options={bastionCommandOptions(templates, !!bastionHost.readOnly)} allowCustomValue={!bastionHost.readOnly} multiline={!bastionHost.readOnly} placeholder="选择模板或输入命令" emptyMessage={bastionHost.readOnly ? '没有可用的查询命令' : '没有匹配的模板，可直接执行输入的命令'} disabled={running || bastionBusy} onChange={setQuery} /><Button disabled={running || bastionBusy || !bastion.connected || !query.trim() || (!!bastion.phase && bastion.phase !== 'ready')} onClick={() => void execute([bastionHost], query)}>{bastionHost.readOnly ? '执行查询' : running ? '执行中…' : '执行命令'}</Button><HelpPopover label="会话命令说明">选择模板会填入完整命令，也可直接输入或修改。点击执行后在当前机器会话中运行，输出保存到执行记录；单次命令最长 60 秒。交互式程序请使用下方终端输入或系统终端。仅允许查询的机器只能使用内置查询。</HelpPopover><Checkbox label="遮盖输入框" checked={secret} disabled={!!bastionHost.readOnly} onChange={setSecret} /></div>
            <section className="command-react__terminal"><header><div><span className="command-react__lamp" aria-hidden="true" />共享终端</div><span>{sessionStatus}</span></header><pre ref={bastionOutputRef} className="command-react__bastion-output" tabIndex={0} onScroll={event => { const output = event.currentTarget; followOutput.current = output.scrollHeight - output.scrollTop - output.clientHeight < 24; }}>{bastion.output}</pre><div className="command-react__session-input"><Input type={secret ? 'password' : 'text'} aria-label="终端输入" value={sessionInput} disabled={!bastion.connected || bastionBusy || !!bastionHost.readOnly} placeholder="输入内容后按 Enter 发送" onChange={(event) => setSessionInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); const value = sessionInput; setSessionInput(''); void sessionAction('bastionSend', { text: value }); } }} /><Button disabled={!bastion.connected || bastionBusy || !!bastionHost.readOnly} onClick={() => { const value = sessionInput; setSessionInput(''); void sessionAction('bastionSend', { text: value }); }}>发送并回车</Button><Button variant="ghost" disabled={!bastion.connected || bastionBusy || !!bastionHost.readOnly} onClick={() => void sessionAction('bastionSend', { key: 'Enter' })}>仅回车</Button></div></section>
          </>}
        </section> : <>
          <div className="command-react__controls" aria-label="命令设置">
            <div className="command-react__control-group"><span>连接</span>{state.config.sharedConfigFile ? <span>共享持久会话</span> : <><Select className="command-react__connection-select" aria-label="SSH 连接方式" value={state.config.reuseConnections ? 'reuse' : 'independent'} options={[{ value: 'independent', label: '每次独立连接' }, { value: 'reuse', label: '复用已认证连接' }]} onChange={(value) => void saveConnection(value === 'reuse', state.config.connectionIdleSeconds ?? 28800)} />{state.config.reuseConnections ? <Select className="command-react__idle-select" aria-label="连接空闲保留" value={String(state.config.connectionIdleSeconds ?? 28800)} options={IDLE_OPTIONS} onChange={(value) => void saveConnection(true, Number(value))} /> : null}<HelpPopover label="SSH 连接说明">复用连接适合频繁执行命令。首次需要密码或验证码时，请先从机器菜单打开系统终端完成认证；共享连接不继承 Shell 目录。</HelpPopover></>}</div>
            {templates.length ? <div className="command-react__control-group command-react__template-controls"><span>模板</span><Combobox className="command-react__template-select" aria-label="搜索或选择命令模板" value="" placeholder="搜索模板" emptyMessage="没有匹配的模板" options={templates.map((template, index) => ({ value: String(index), label: template.name }))} onChange={(value) => setCommand(templates[Number(value)]?.command ?? '')} /></div> : null}
          </div>
          <div className="command-react__composer"><span aria-hidden="true">{selectedHosts.length === 1 ? `${selectedHosts[0]?.alias} $` : selectedHosts.length ? `${selectedHosts.length} 台 $` : '$'}</span><Textarea rows={1} spellCheck={false} autoComplete="off" placeholder="输入命令，回车执行" value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={commandKeyDown} /><Button variant="primary" disabled={running || !selectedHosts.length || !command.trim()} onClick={submitCommand}>{running ? '执行中…' : '执行 ↵'}</Button></div>
          <footer className="command-react__footer"><span>Enter 执行 · Shift+Enter 换行 · ↑↓ 历史</span></footer>
          <JobConsole jobs={jobs} selectedHosts={selectedHosts} onCancel={(job) => void api('cancel', { id: job.id }).catch((reason) => setError(errorText(reason)))} onClear={() => setJobs((current) => current.filter((job) => !job.finishedAt))} />
        </>}
        {notice ? <p className="command-react__notice" role="status">{notice}</p> : null}
        {error ? <p className="command-react__error" role="alert">{error}</p> : null}
      </div>
        </div>
      </Tabs.Panel>
      <Tabs.Panel value="sessions" forceMount className="command-react__workspace-panel">
        <section className="command-react__shared-manager" aria-label="共享连接与会话">
          <label><span>连接配置文件</span><Input aria-label="连接配置文件" value={configFile} placeholder={state.config.sharedConfigFile || '~/.ssh/mcp-servers.json（留空使用默认路径）'} onChange={event => setConfigFile(event.target.value)} /></label>
          <p>内置 SSH 组件可独立运行，无需安装 toolkit。选择 JSON 文件后，可与 toolkit 共用连接配置及会话。已有连接会补入文件，密码字段按文件格式保存；请仅允许当前用户读取。切换前暂停监控并等待任务结束。</p>
          <Button disabled={sharedBusy || running} onClick={() => void saveSharedConfig()}>{sharedBusy ? '切换中…' : '使用此配置文件'}</Button>
          {state.config.sharedConfigFile ? <><p>当前文件：{state.config.sharedConfigFile}</p><Button onClick={() => void refreshSessions()}>刷新共享会话</Button>
          <ul>{sharedSessions.map(session => <li key={session.id}><strong>{session.alias}</strong> · {session.type} · {session.dead ? '已退出' : session.busy ? '执行中或结果未知' : session.attached ? '终端已附着' : '可用'}<br /><code>{session.id}</code> · {session.config_file}</li>)}</ul></> : null}
          {notice ? <p role="status">{notice}</p> : null}{error ? <p role="alert">{error}</p> : null}
        </section>
      </Tabs.Panel>
      <Tabs.Panel value="templates" forceMount className="command-react__workspace-panel">
        <TemplateManager initial={templates} busy={templateBusy} onSave={saveTemplates} />
      </Tabs.Panel>
    </Tabs>
  </section>;
}
