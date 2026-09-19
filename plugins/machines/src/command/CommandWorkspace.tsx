import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Button,
  Checkbox,
  EmptyState,
  HelpPopover,
  Input,
  Select,
  Tabs,
  Textarea,
} from '@flowhub/plugin-common/react';

import type {
  BastionState,
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
const QUERY_OPTIONS = ['uptime', 'hostname', 'uname -a', 'df -h /', 'free -m'].map((value) => ({ value, label: value }));

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
  const [draft, setDraft] = useState<CommandTemplate[]>(() => initial.map((item) => ({ ...item })));
  const [error, setError] = useState('');

  useEffect(() => {
    setDraft(initial.map((item) => ({ ...item })));
    setError('');
  }, [initial]);

  async function save() {
    if (draft.some((item) => !item.name.trim() || byteLength(item.name) > 100 || !item.command.trim() || byteLength(item.command) > 8192)) {
      setError('请填写模板名称（最多 100 字节）和命令（最多 8192 字节）。');
      return;
    }
    try { await onSave(draft); } catch (reason) { setError(errorText(reason)); }
  }

  return <section className="command-react__template-manager" aria-labelledby="command-template-title">
    <header><div><h3 id="command-template-title">模板列表</h3><p>集中维护常用命令；选择模板只会填入命令，不会自动执行。</p></div><div>{draft.length < 50 ? <Button size="sm" variant="ghost" onClick={() => setDraft((current) => [...current, { name: '', command: '' }])}>新建模板</Button> : null}<Button size="sm" variant="primary" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存修改'}</Button></div></header>
    <div className="command-react__template-list">
      {draft.map((item, index) => <section key={index} className="command-react__template-row">
        <span className="command-react__template-index">{String(index + 1).padStart(2, '0')}</span>
        <label><span>模板名称</span><Input value={item.name} maxLength={100} placeholder="例如：查看磁盘使用" onChange={(event) => setDraft((current) => current.map((entry, itemIndex) => itemIndex === index ? { ...entry, name: event.target.value } : entry))} /></label>
        <label><span>命令内容</span><Textarea rows={2} value={item.command} placeholder="df -h /" onChange={(event) => setDraft((current) => current.map((entry, itemIndex) => itemIndex === index ? { ...entry, command: event.target.value } : entry))} /></label>
        <Button size="sm" variant="ghost" onClick={() => setDraft((current) => current.filter((_, itemIndex) => itemIndex !== index))}>删除</Button>
      </section>)}
      {!draft.length ? <EmptyState size="compact" title="还没有命令模板" description="点击右上角“新建模板”添加常用命令。" /> : null}
    </div>
    {error ? <p className="command-react__error" role="alert">{error}</p> : null}
  </section>;
}

function TargetRail({ hosts, selected, disabled, onChange }: {
  hosts: readonly CommandHost[];
  selected: ReadonlySet<string>;
  disabled: boolean;
  onChange: (hostIds: ReadonlySet<string>) => void;
}) {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? hosts.filter((host) => `${host.name} ${host.alias} ${host.group ?? ''}`.toLocaleLowerCase().includes(needle)) : hosts;
  }, [hosts, query]);

  function toggle(hostId: string, checked: boolean) {
    const next = new Set(selected);
    checked ? next.add(hostId) : next.delete(hostId);
    onChange(next);
  }

  return <aside className="command-react__targets" aria-label="目标机器">
    <div className="command-react__target-head"><strong>目标机器</strong><div><em>已选 {selected.size}/16</em>{selected.size ? <Button size="sm" variant="ghost" onClick={() => onChange(new Set())}>清空</Button> : null}</div></div>
    <Input type="search" aria-label="搜索目标机器" placeholder="搜索名称、别名或分组…" value={query} onChange={(event) => setQuery(event.target.value)} />
    <div className="command-react__target-list">
      {visible.map((host) => <label key={host.id} className="command-react__target" data-selected={selected.has(host.id) || undefined}>
        <input type="checkbox" checked={selected.has(host.id)} disabled={disabled} onChange={(event) => toggle(host.id, event.target.checked)} />
        <span><strong>{host.name}</strong><small>{host.alias}{host.group ? ` · ${host.group}` : ''}</small></span>
        {host.bastion ? <i>B</i> : null}
      </label>)}
      {!visible.length ? <p>没有匹配的机器</p> : null}
    </div>
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
    <header><div><span className="command-react__lamp" aria-hidden="true" />SSH CONSOLE</div><span>{jobs.length} 条 · {active} 条执行中</span><Button size="sm" variant="ghost" disabled={!jobs.some((job) => job.finishedAt)} onClick={onClear}>清除已完成</Button></header>
    <div ref={outputRef} className="command-react__output" aria-live="polite">
      {jobs.length ? jobs.map((job) => <article key={job.id} className="command-react__job">
        <div><span className={`command-react__job-status command-react__job-status--${job.status}`}>{STATUS_LABELS[job.status] ?? job.status}</span><strong>{job.alias}</strong><time>{new Date(job.startedAt).toLocaleTimeString()}</time>{!job.finishedAt ? <Button size="sm" variant="ghost" onClick={() => onCancel(job)}>取消</Button> : null}</div>
        <pre><b>$ {job.command}</b>{job.stdout ? `\n${job.stdout}` : ''}{job.stderr ? `\n[stderr]\n${job.stderr}` : ''}{job.finishedAt && !job.stdout && !job.stderr ? '\n（无输出）' : ''}</pre>
      </article>) : <div className="command-react__console-empty"><span>$</span><p>{selectedHosts.length ? '输入命令后按 Enter 执行' : '先从左侧选择目标机器'}</p></div>}
    </div>
  </section>;
}

export function CommandWorkspace({ api, run }: CommandWorkspaceProps) {
  const [active, setActive] = useState(() => document.querySelector('#commandPanel')?.hasAttribute('hidden') === false);
  const [state, setState] = useState<CommandState | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [command, setCommand] = useState('');
  const [jobs, setJobs] = useState<readonly CommandJob[]>([]);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [workspaceView, setWorkspaceView] = useState<'execute' | 'templates'>('execute');
  const [templateBusy, setTemplateBusy] = useState(false);
  const [query, setQuery] = useState('uptime');
  const [bastion, setBastion] = useState<BastionState>({ connected: false, output: '尚未连接此机器的会话。' });
  const [bastionBusy, setBastionBusy] = useState(false);
  const [secret, setSecret] = useState(false);
  const [sessionInput, setSessionInput] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const history = useRef<string[]>([]);
  const historyIndex = useRef(0);
  const historyDraft = useRef('');

  const load = useCallback(async () => {
    if (!api) return;
    try {
      const next = await api('state') as CommandState;
      setState(next);
      setSelected((current) => new Set([...current].filter((id) => next.config.hosts.some((host) => host.id === id))));
      setError('');
    } catch (reason) { setError(errorText(reason)); }
  }, [api]);

  useEffect(() => {
    const onTab = (event: Event) => {
      const next = (event as CustomEvent<{ tab?: string }>).detail?.tab === 'command';
      setActive(next);
      if (next) void load();
    };
    const onTargets = (event: Event) => setSelected(new Set((event as CustomEvent<{ hostIds?: readonly string[] }>).detail?.hostIds ?? []));
    window.addEventListener('flowhub:machine-tab', onTab);
    window.addEventListener('flowhub:command-targets', onTargets);
    if (active) void load();
    return () => {
      window.removeEventListener('flowhub:machine-tab', onTab);
      window.removeEventListener('flowhub:command-targets', onTargets);
    };
  }, [active, load]);

  const hosts = state?.config.hosts ?? [];
  const selectedHosts = useMemo(() => hosts.filter((host) => selected.has(host.id)), [hosts, selected]);
  const bastionHost = selectedHosts.length === 1 && selectedHosts[0]?.bastion ? selectedHosts[0] : null;
  const hasBastion = selectedHosts.some((host) => host.bastion);
  const templates = state?.config.templates ?? state?.config.installed?.templates ?? [];

  const pollBastion = useCallback(async () => {
    if (!api || !active || !bastionHost || bastionBusy || document.hidden) return;
    try { setBastion(await api('bastionState', { hostId: bastionHost.id }) as BastionState); }
    catch (reason) { setError(errorText(reason)); }
  }, [active, api, bastionBusy, bastionHost]);

  useEffect(() => {
    setBastion({ connected: false, output: bastionHost ? '尚未连接此机器的会话。' : '请选择一台堡垒机机器。' });
    if (!bastionHost) return;
    void pollBastion();
    const timer = window.setInterval(() => void pollBastion(), 1500);
    return () => window.clearInterval(timer);
  }, [bastionHost?.id, pollBastion]);

  function updateSelection(next: ReadonlySet<string>) {
    setSelected(next);
    window.dispatchEvent(new CustomEvent('flowhub:command-selection', { detail: { hostIds: [...next] } }));
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
    setRunning(true); setError(''); setNotice(`正在向 ${hostList.length} 台机器提交命令…`);
    const pending = hostList.map((host) => ({ id: crypto.randomUUID(), hostId: host.id, name: host.name, alias: host.alias, command: value, status: 'queued' as const, startedAt: Date.now(), finishedAt: null }));
    setJobs((current) => [...current, ...pending].slice(-100));
    const results = await Promise.allSettled(pending.map(async (job) => {
      setJobs((current) => current.map((item) => item.id === job.id ? { ...item, status: 'running' } : item));
      try {
        const result = await run({ hostId: job.hostId, expectedAlias: job.alias, id: job.id, kind: 'command', command: value }) as Partial<CommandJob>;
        setJobs((current) => current.map((item) => item.id === job.id ? { ...item, ...result, status: result.status ?? 'success', finishedAt: result.finishedAt ?? Date.now() } : item));
        return result;
      } catch (reason) {
        setJobs((current) => current.map((item) => item.id === job.id ? { ...item, status: 'failed', stderr: errorText(reason), finishedAt: Date.now() } : item));
        throw reason;
      }
    }));
    const rejected = results.filter((result) => result.status === 'rejected').length;
    const unsuccessful = results.filter((result) => result.status === 'fulfilled' && result.value.status && result.value.status !== 'success').length;
    setNotice(`任务结束：${results.length - rejected - unsuccessful} 成功，${unsuccessful} 未成功，${rejected} 未提交。`);
    if (rejected || unsuccessful) setError('部分命令未成功，请查看控制台输出。');
    setRunning(false);
    void load();
  }

  function submitCommand() {
    const value = command;
    if (!value.trim()) return;
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

  async function sessionAction(action: string, extra: Record<string, unknown> = {}) {
    if (!api || !bastionHost || bastionBusy) return;
    setBastionBusy(true); setError('');
    try { setBastion(await api(action, { hostId: bastionHost.id, ...extra }) as BastionState); }
    catch (reason) { setError(errorText(reason)); }
    finally { setBastionBusy(false); }
  }

  async function saveTemplates(next: readonly CommandTemplate[]) {
    if (!api) return;
    setTemplateBusy(true);
    try { setState(await api('templates', { templates: next }) as CommandState); setNotice('命令模板已保存。'); }
    finally { setTemplateBusy(false); }
  }

  if (!api || !run) return <section className="command-react"><EmptyState title="远程命令仅在 FlowHub 中可用" description="当前浏览器环境没有插件调用桥。" /></section>;
  if (!state) return <section className="command-react"><EmptyState title={error || '正在读取命令工作台…'} /></section>;

  return <section className="command-react" aria-labelledby="command-react-title">
    <header className="command-react__head"><div><div className="command-react__title"><h2 id="command-react-title">远程命令</h2><HelpPopover label="命令执行说明">每条命令独立执行，不保留目录或环境变量。每批最多 16 台，并发由插件调度，超时 60 秒；取消本地 SSH 后，远端进程仍可能继续。</HelpPopover></div><p>{workspaceView === 'execute' ? '选择目标、输入命令并查看本次会话输出。' : '集中维护可重复使用的常用命令。'}</p></div><div className="command-react__head-status"><span className={selectedHosts.length && workspaceView === 'execute' ? 'is-ready' : ''}>{workspaceView === 'execute' ? (selectedHosts.length ? `已选 ${selectedHosts.length} 台` : '尚未选择目标') : `${templates.length} 个模板`}</span></div></header>
    <Tabs value={workspaceView} onValueChange={(value) => setWorkspaceView(value as 'execute' | 'templates')} className="command-react__workspace-tabs">
      <Tabs.List aria-label="远程命令工作区" className="command-react__subtabs">
        <Tabs.Trigger value="execute" className="command-react__subtab">执行命令</Tabs.Trigger>
        <Tabs.Trigger value="templates" className="command-react__subtab">命令模板</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Panel value="execute" forceMount className="command-react__workspace-panel">
        <div className="command-react__layout">
      <TargetRail hosts={hosts} selected={selected} disabled={!state.config.enabled} onChange={updateSelection} />
      <main className="command-react__main">
        {hasBastion ? <section className="command-react__bastion">
          <header><div><span>BASTION / SHARED SESSION</span><h3>{bastionHost ? `${bastionHost.name} · ${bastionHost.alias}` : '堡垒机会话'}</h3><p>{bastionHost ? '页面与系统终端共享本机 tmux 会话。' : '堡垒机模式一次只能选择一台机器。'}</p></div><span className={bastion.connected ? 'is-connected' : ''}>{bastion.connected ? '已连接' : '未连接'}</span></header>
          {!bastionHost ? <EmptyState size="compact" title="请只保留一台堡垒机" description="清除其他目标后即可连接共享会话。" /> : <>
            <div className="command-react__actionbar"><Button variant="primary" disabled={bastionBusy || bastion.connected} onClick={() => void sessionAction('bastionStart')}>连接会话</Button><Button disabled={bastionBusy || !bastion.connected || !!bastionHost.readOnly} onClick={() => void sessionAction('bastionTerminal')}>系统终端附着</Button><Button disabled={bastionBusy || !bastion.connected || !!bastionHost.readOnly} onClick={() => void sessionAction('bastionSend', { key: 'C-c' })}>Ctrl+C</Button>{confirmDisconnect ? <><span className="command-react__confirm">确定终止共享会话？</span><Button variant="danger" disabled={bastionBusy} onClick={() => { setConfirmDisconnect(false); void sessionAction('bastionStop'); }}>确认断开</Button><Button variant="ghost" onClick={() => setConfirmDisconnect(false)}>取消</Button></> : <Button variant="danger" disabled={bastionBusy || !bastion.connected} onClick={() => setConfirmDisconnect(true)}>断开</Button>}</div>
            <div className="command-react__query"><Select aria-label="查询命令" value={query} options={QUERY_OPTIONS} onChange={setQuery} /><Button disabled={bastionBusy || !bastion.connected} onClick={() => void execute([bastionHost], query)}>执行查询</Button><Checkbox label="隐藏输入" checked={secret} disabled={!!bastionHost.readOnly} onChange={setSecret} /></div>
            <section className="command-react__terminal"><header><div><span className="command-react__lamp" aria-hidden="true" />SHARED TERMINAL</div><span>{bastionBusy ? '通信中…' : bastion.connected ? '会话在线' : '等待连接'}</span></header><pre className="command-react__bastion-output" tabIndex={0}>{bastion.output}</pre><div className="command-react__session-input"><Input type={secret ? 'password' : 'text'} aria-label="终端输入" value={sessionInput} disabled={!bastion.connected || bastionBusy || !!bastionHost.readOnly} placeholder="输入内容后按 Enter 发送" onChange={(event) => setSessionInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); const value = sessionInput; setSessionInput(''); void sessionAction('bastionSend', { text: value }); } }} /><Button disabled={!bastion.connected || bastionBusy || !!bastionHost.readOnly} onClick={() => { const value = sessionInput; setSessionInput(''); void sessionAction('bastionSend', { text: value }); }}>发送并回车</Button><Button variant="ghost" disabled={!bastion.connected || bastionBusy || !!bastionHost.readOnly} onClick={() => void sessionAction('bastionSend', { key: 'Enter' })}>仅回车</Button></div></section>
          </>}
        </section> : <>
          <div className="command-react__controls" aria-label="命令设置">
            <div className="command-react__control-group"><span>连接</span><Select className="command-react__connection-select" aria-label="SSH 连接方式" value={state.config.reuseConnections ? 'reuse' : 'independent'} options={[{ value: 'independent', label: '每次独立连接' }, { value: 'reuse', label: '复用已认证连接' }]} onChange={(value) => void saveConnection(value === 'reuse', state.config.connectionIdleSeconds ?? 28800)} />{state.config.reuseConnections ? <Select className="command-react__idle-select" aria-label="连接空闲保留" value={String(state.config.connectionIdleSeconds ?? 28800)} options={IDLE_OPTIONS} onChange={(value) => void saveConnection(true, Number(value))} /> : null}<HelpPopover label="SSH 连接说明">复用连接适合频繁执行命令。首次需要密码或验证码时，请先从机器菜单打开系统终端完成认证；共享连接不继承 Shell 目录。</HelpPopover></div>
            {templates.length ? <div className="command-react__control-group command-react__template-controls"><span>模板</span><Select className="command-react__template-select" aria-label="选择命令模板" value="" placeholder="选择模板" options={templates.map((template, index) => ({ value: String(index), label: template.name }))} onChange={(value) => setCommand(templates[Number(value)]?.command ?? '')} /></div> : null}
          </div>
          <div className="command-react__composer"><span aria-hidden="true">{selectedHosts.length === 1 ? `${selectedHosts[0]?.alias} $` : selectedHosts.length ? `${selectedHosts.length} 台 $` : '$'}</span><Textarea rows={1} spellCheck={false} autoComplete="off" placeholder="输入命令，回车执行" value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={commandKeyDown} /><Button variant="primary" disabled={running || !selectedHosts.length || !command.trim()} onClick={submitCommand}>{running ? '执行中…' : '执行 ↵'}</Button></div>
          <footer className="command-react__footer"><span>{selectedHosts.length ? selectedHosts.map((host) => host.name).join('、') : '尚未选择机器'}</span><span>Enter 执行 · Shift+Enter 换行 · ↑↓ 历史</span></footer>
          <JobConsole jobs={jobs} selectedHosts={selectedHosts} onCancel={(job) => void api('cancel', { id: job.id }).catch((reason) => setError(errorText(reason)))} onClear={() => setJobs((current) => current.filter((job) => !job.finishedAt))} />
        </>}
        {notice ? <p className="command-react__notice" role="status">{notice}</p> : null}
        {error ? <p className="command-react__error" role="alert">{error}</p> : null}
      </main>
        </div>
      </Tabs.Panel>
      <Tabs.Panel value="templates" forceMount className="command-react__workspace-panel">
        <TemplateManager initial={templates} busy={templateBusy} onSave={saveTemplates} />
      </Tabs.Panel>
    </Tabs>
  </section>;
}
