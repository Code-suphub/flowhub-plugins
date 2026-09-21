import {useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode} from 'react';
import {
  Button, Checkbox, DialogShell, EmptyState, Field, FormSection, HelpPopover, Input,
  Select, StatItem, StatStrip, Tabs, Textarea,
} from '@flowhub/plugin-common/react';
import type {
  Container, ContainerDetail, HostContext, ImageDetail, ImageSummary, ListResult,
  ManagementApi, Scope, Selection, StopPlan, StopResult,
} from './api';
import {createPreviewApi} from './api';
import {actionAvailability, filterContainers, groupContainers, imageReference, isIssue, statusLabels} from './model';

interface Settings {
  refreshSeconds: number;
  defaultScope: Exclude<Scope, 'settings'>;
  onlyIssues: boolean;
  expandCompose: boolean;
}
const settingsKey = 'flowhub.docker.management.settings.v1';
const defaultSettings: Settings = {refreshSeconds: 15, defaultScope: 'all', onlyIssues: false, expandCompose: true};
const scopeOptions = [
  {value: 'all', label: '全部资源'}, {value: 'compose', label: 'Compose 项目'},
  {value: 'standalone', label: '独立容器'}, {value: 'images', label: '镜像'},
];
const noticeText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(settingsKey) || '{}') as Partial<Settings>;
    return {...defaultSettings, ...saved, defaultScope: scopeOptions.some((item) => item.value === saved.defaultScope) ? saved.defaultScope as Settings['defaultScope'] : 'all'};
  } catch { return defaultSettings; }
}
function formatDate(value?: string): string {
  return value && Date.parse(value) > 0 ? new Date(value).toLocaleString() : '尚未启动';
}
function selectedContainer(selection: Selection | null, containers: Container[]): Container | null {
  return selection?.kind === 'container' ? containers.find((row) => row.id === selection.id) ?? null : null;
}
function selectedProject(selection: Selection | null, containers: Container[]): Container[] {
  return selection?.kind === 'project' ? containers.filter((row) => row.project === selection.project) : [];
}

function ScopeNav({scope, onChange, disabled}: {scope: Scope; onChange(value: Scope): void; disabled: boolean}) {
  return <nav className="docker-scope-nav" aria-label="资源类型">
    {[
      ['all', '全部'], ['compose', 'Compose'], ['standalone', '独立容器'],
      ['images', '镜像'], ['settings', '通用设置'],
    ].map(([value, label]) => <button key={value} type="button" className={scope === value ? 'is-active' : ''} aria-pressed={scope === value} disabled={disabled} onClick={() => onChange(value as Scope)}>{label}</button>)}
  </nav>;
}

function ResourceList({containers, images, scope, query, onlyIssues, selected, collapsed, onToggleProject, onSelect}: {
  containers: Container[]; images: ImageSummary[]; scope: Scope; query: string; onlyIssues: boolean; selected: Selection | null;
  collapsed: Set<string>; onToggleProject(project: string): void; onSelect(selection: Selection): void;
}) {
  if (scope === 'images') {
    const visible = images.filter((image) => (imageReference(image) + ' ' + image.ID).toLowerCase().includes(query.trim().toLowerCase()));
    return visible.length ? <div className="docker-resource-list" aria-label="镜像列表">{visible.map((image) => {
      const reference = imageReference(image);
      return <button type="button" key={image.ID + reference} className={'docker-resource-row ' + (selected?.kind === 'image' && selected.reference === reference ? 'is-selected' : '')} onClick={() => onSelect({kind: 'image', id: image.ID, reference})}>
        <span className="docker-resource-copy"><strong>{reference}</strong><small>{image.Size} · {image.CreatedSince}<br/>{image.ID.slice(0, 24)}</small></span>
      </button>;
    })}</div> : <EmptyState size="compact" title="没有匹配的本地镜像"/>;
  }
  const visible = filterContainers(containers, scope === 'settings' ? 'all' : scope, query, onlyIssues);
  const groups = groupContainers(visible);
  return groups.length ? <div className="docker-resource-list" aria-label="资源列表">{groups.map(([project, rows]) => {
    const isCollapsed = collapsed.has(project);
    return <div key={project || 'standalone'} className="docker-resource-group">
      <div className="docker-group-heading">
        {project ? <><button type="button" className="docker-fold" aria-label={(isCollapsed ? '展开 ' : '收起 ') + project} aria-expanded={!isCollapsed} onClick={() => onToggleProject(project)}>{isCollapsed ? '▸' : '▾'}</button><button type="button" className="docker-project-link" onClick={() => onSelect({kind: 'project', project})}>{project}</button></> : <span>独立容器</span>}
        <small>{rows.filter((row) => row.state === 'running').length}/{rows.length} 运行</small>
      </div>
      {!isCollapsed && rows.map((row) => <button type="button" key={row.id} className={'docker-resource-row ' + (selected?.kind === 'container' && selected.id === row.id ? 'is-selected' : '')} onClick={() => onSelect({kind: 'container', id: row.id})}>
        <span className={'docker-status-dot ' + (row.status.includes('unhealthy') ? 'unhealthy' : row.state)} aria-hidden="true"/>
        <span className="docker-resource-copy"><strong>{row.name}</strong><small>{statusLabels[row.state] || row.state} · {row.image}</small></span>
      </button>)}
    </div>;
  })}</div> : <EmptyState size="compact" title="没有匹配的容器"/>;
}

function DetailOverview({selection, container, detail, imageDetail, projectRows, onSelect}: {
  selection: Selection; container: Container | null; detail: ContainerDetail | null; imageDetail: ImageDetail | null; projectRows: Container[]; onSelect(selection: Selection): void;
}) {
  if (selection.kind === 'project') {
    return <div className="docker-overview-content"><p className="docker-project-note">{projectRows.length} 个成员容器 · 点击服务查看资源、日志与操作。</p>{projectRows.map((row) => <button type="button" className="docker-member-row" key={row.id} onClick={() => onSelect({kind: 'container', id: row.id})}><span>{row.service || row.name}<small>{row.name} · {row.image}</small></span><small>{statusLabels[row.state] || row.state} ↗</small></button>)}</div>;
  }
  if (selection.kind === 'image' && imageDetail) {
    return <div className="docker-overview-content"><dl className="docker-detail-grid">
      <dt>镜像 ID</dt><dd>{imageDetail.id}</dd><dt>全部标签</dt><dd>{imageDetail.tags?.join('\n') || '无标签'}</dd>
      <dt>平台</dt><dd>{imageDetail.os || '未知'} / {imageDetail.architecture || '未知'}</dd>
      <dt>大小</dt><dd>{typeof imageDetail.size === 'number' ? (imageDetail.size / 1048576).toFixed(1) + ' MiB' : '未知'}</dd>
      <dt>创建时间</dt><dd>{formatDate(imageDetail.created)}</dd><dt>摘要</dt><dd>{imageDetail.digests?.join('\n') || '无'}</dd>
    </dl><h3>引用此镜像或其派生镜像的容器</h3>
      {imageDetail.containers.length ? imageDetail.containers.map((row) => <button type="button" className="docker-member-row" key={row.id} onClick={() => onSelect({kind: 'container', id: row.id})}><span>{row.name}</span><small>{statusLabels[row.state] || row.state} ↗</small></button>) : <p className="docker-muted">暂无容器引用，可删除当前标签。</p>}
    </div>;
  }
  if (!container || !detail) return <p className="docker-loading">正在读取详情…</p>;
  return <div className="docker-overview-content"><div className="docker-metrics"><div><span>CPU</span><strong>{detail.stats?.CPUPerc || '—'}</strong></div><div><span>内存 / 上限</span><strong>{detail.stats?.MemUsage || '—'}</strong></div></div>
    <dl className="docker-detail-grid"><dt>运行状态</dt><dd>{statusLabels[detail.state || container.state] || detail.state || container.state}</dd>
      <dt>健康检查</dt><dd>{detail.health || '未配置'}</dd><dt>退出码 / 重启</dt><dd>{detail.exitCode ?? '—'} / {detail.restarts ?? '—'} 次</dd>
      <dt>最近启动</dt><dd>{formatDate(detail.started)}</dd><dt>端口映射</dt><dd>{container.ports || '无公开端口'}</dd>
      <dt>挂载目录</dt><dd>{detail.mounts?.map((mount) => (mount.Source || '未知') + ' → ' + (mount.Destination || '未知') + (mount.RW ? '' : ' (只读)')).join('\n') || '无挂载'}</dd>
      <dt>容器 ID</dt><dd>{container.id}</dd>
    </dl>{detail.statsError ? <p className="docker-error" role="alert">{detail.statsError}</p> : null}</div>;
}

function SettingsPanel({settings, theme, context, onSave, onReset}: {settings: Settings; theme: string; context: string; onSave(settings: Settings, theme: string): void; onReset(): void}) {
  const [draft, setDraft] = useState(settings);
  const [draftTheme, setDraftTheme] = useState(theme);
  const [saved, setSaved] = useState('');
  useEffect(() => {setDraft(settings); setDraftTheme(theme);}, [settings, theme]);
  function submit(event: FormEvent) {
    event.preventDefault(); onSave(draft, draftTheme); setSaved('已保存'); window.setTimeout(() => setSaved(''), 1800);
  }
  return <section className="docker-settings" aria-label="通用设置"><header className="docker-settings-heading"><div className="docker-settings-label">设置偏好 <HelpPopover label="通用设置说明">控制管理页的默认行为；悬浮窗仍单独保存显示范围。</HelpPopover></div><span className="docker-success" role="status">{saved}</span></header>
    <form onSubmit={submit} className="docker-settings-form"><FormSection legend="刷新与范围" description="后台采集仍由插件统一维护，这里控制页面刷新频率与初始筛选。">
      <Field label="刷新频率" htmlFor="docker-refresh"><Select id="docker-refresh" value={String(draft.refreshSeconds)} onChange={(value) => setDraft({...draft, refreshSeconds: Number(value)})} options={[15, 30, 60, 120].map((value) => ({value: String(value), label: value < 60 ? '每 ' + value + ' 秒' : '每 ' + value / 60 + ' 分钟'}))}/></Field>
      <Field label="打开时的默认范围" htmlFor="docker-scope"><Select id="docker-scope" value={draft.defaultScope} onChange={(value) => setDraft({...draft, defaultScope: value as Settings['defaultScope']})} options={scopeOptions}/></Field>
      <Checkbox checked={draft.onlyIssues} onChange={(checked) => setDraft({...draft, onlyIssues: checked})} label="默认只显示异常容器"/>
      <Checkbox checked={draft.expandCompose} onChange={(checked) => setDraft({...draft, expandCompose: checked})} label="默认展开 Compose 项目"/>
    </FormSection><FormSection legend="外观"><Field label="主题" htmlFor="docker-theme"><Select id="docker-theme" value={draftTheme} disabled={Boolean(window.FlowHubTheme?.hosted)} onChange={setDraftTheme} options={[{value: 'system', label: '跟随系统'}, {value: 'light', label: '浅色'}, {value: 'dark', label: '深色'}]}/></Field></FormSection>
      <div className="docker-settings-actions"><Button type="submit" variant="primary">保存设置</Button><Button type="button" onClick={onReset}>恢复默认</Button></div>
    </form><div className="docker-settings-note"><strong>当前 Docker 环境</strong><span>{context || '尚未连接'}</span><small>Docker context 由本机 Docker CLI 管理；环境变化时会清除当前选择。</small></div>
  </section>;
}

export function App({api, context}: {api: ManagementApi; context: HostContext}) {
  const [settings, setSettings] = useState(loadSettings);
  const [theme, setTheme] = useState(() => window.FlowHubTheme?.get() || 'system');
  const [scope, setScope] = useState<Scope>(() => scopeOptions.some((item) => item.value === context.config?.type) ? context.config!.type as Scope : settings.defaultScope);
  const [data, setData] = useState<ListResult>({context: '', containers: []});
  const [images, setImages] = useState<ImageSummary[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [detail, setDetail] = useState<ContainerDetail | null>(null);
  const [imageDetail, setImageDetail] = useState<ImageDetail | null>(null);
  const [tab, setTab] = useState<'overview' | 'logs'>('overview');
  const [logs, setLogs] = useState('');
  const [logQuery, setLogQuery] = useState('');
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [operationBusy, setOperationBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [updated, setUpdated] = useState('尚未更新');
  const [followLogs, setFollowLogs] = useState(false);
  const [confirm, setConfirm] = useState<{method: string; params: Record<string, unknown>; title: string; description: string} | null>(null);
  const [confirmError, setConfirmError] = useState('');
  const appliedInitial = useRef(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const logsInFlight = useRef<number | null>(null);
  const operationBusyRef = useRef(false);
  const current = useMemo(() => selectedContainer(selection, data.containers), [data.containers, selection]);
  const projectRows = useMemo(() => selectedProject(selection, data.containers), [data.containers, selection]);
  const isWidget = Boolean(window.FlowHubWidget && window.parent !== window);
  const previewApi = useMemo(createPreviewApi, []);
  const activeApi = context.preview ? previewApi : api;
  const readOnly = activeApi.preview || Boolean(context.preview);

  const refresh = useCallback(async () => {
    if (inFlight.current || operationBusyRef.current || scope === 'settings') return;
    inFlight.current = true; setLoading(true); setError('');
    try {
      const next = await activeApi.invoke<ListResult>('list');
      if (data.context && data.context !== next.context) {setSelection(null); setNotice('Docker 环境已变化，已清除原环境中的选择。'); generation.current += 1;}
      setData(next); setUpdated(new Date().toLocaleTimeString());
      if (scope === 'images') setImages((await activeApi.invoke<{images: ImageSummary[]}>('images', {context: next.context})).images);
    } catch (reason) {setError(noticeText(reason) + '\n请检查 Docker 引擎后刷新。');}
    finally {inFlight.current = false; setLoading(false);}
  }, [activeApi, data.context, operationBusy, scope]);

  useEffect(() => {void refresh(); const timer = window.setInterval(() => {if (!document.hidden) void refresh();}, settings.refreshSeconds * 1000); return () => window.clearInterval(timer);}, [refresh, settings.refreshSeconds]);
  useEffect(() => {
    if (appliedInitial.current || !data.context) return;
    const initial = context.config?.selection || (context.config?.project && context.config.project !== '*' ? {kind: 'project' as const, project: context.config.project} : null);
    if (initial && (!('context' in initial) || !initial.context || initial.context === data.context)) {
      setSelection(initial); if (initial.kind === 'image' || initial.kind === 'images') setScope('images');
    } else if (initial && 'context' in initial && initial.context && initial.context !== data.context) {
      setNotice('悬浮窗所选 Docker 环境已变化，请重新选择对象。');
    }
    appliedInitial.current = true;
    if (!settings.expandCompose) setCollapsed(new Set(data.containers.filter((row) => row.project).map((row) => row.project)));
  }, [context.config, data.context, data.containers, settings.expandCompose]);
  useEffect(() => {
    generation.current += 1;
    if (!selection || selection.kind === 'project' || selection.kind === 'images') {setDetailLoading(false); setDetail(null); setImageDetail(null); return;}
    const revision = ++generation.current; setDetailLoading(true); setDetail(null); setImageDetail(null);
    const method = selection.kind === 'image' ? 'image_detail' : 'detail';
    const params = selection.kind === 'image' ? {id: selection.id, context: data.context} : {id: selection.id, context: data.context};
    void activeApi.invoke<ContainerDetail & ImageDetail>(method, params).then((result) => {
      if (revision !== generation.current) return;
      if (selection.kind === 'image') setImageDetail(result as ImageDetail); else setDetail(result as ContainerDetail);
    }).catch((reason) => {if (revision === generation.current) setError(noticeText(reason));}).finally(() => {if (revision === generation.current) setDetailLoading(false);});
  }, [activeApi, data.context, selection]);
  const loadLogs = useCallback(async () => {
    if (selection?.kind !== 'container' || operationBusyRef.current || logsInFlight.current === generation.current) return;
    const revision = generation.current; setLogs('正在读取日志…');
    logsInFlight.current = revision;
    try {const result = await activeApi.invoke<{text: string}>('logs', {id: selection.id, context: data.context}); if (revision === generation.current) setLogs(result.text);} catch (reason) {if (revision === generation.current) setLogs(noticeText(reason));}
    finally {if (logsInFlight.current === revision) logsInFlight.current = null;}
  }, [activeApi, data.context, operationBusy, selection]);
  useEffect(() => {if (tab === 'logs') void loadLogs();}, [loadLogs, tab]);
  useEffect(() => {if (!followLogs || tab !== 'logs') return; const timer = window.setInterval(() => {if (!document.hidden) void loadLogs();}, 3000); return () => window.clearInterval(timer);}, [followLogs, loadLogs, tab]);

  function select(next: Selection) {generation.current += 1; setSelection(next); setQuery(''); setError(''); if (next.kind !== 'container') setTab('overview');}
  function changeScope(next: Scope) {generation.current += 1; setScope(next); setSelection(null); setQuery(''); setError('');}
  function saveSettings(next: Settings, nextTheme: string) {setSettings(next); localStorage.setItem(settingsKey, JSON.stringify(next)); setTheme(nextTheme); if (!window.FlowHubTheme?.hosted) window.FlowHubTheme?.set(nextTheme); setScope(next.defaultScope); generation.current += 1; setSelection(null); setCollapsed(next.expandCompose ? new Set() : new Set(data.containers.filter((row) => row.project).map((row) => row.project))); setNotice('设置已保存');}
  function resetSettings() {saveSettings(defaultSettings, 'system'); setNotice('已恢复默认设置');}
  function prepareAction(action: string) {
    if (readOnly || !selection || operationBusyRef.current) return;
    if (action === 'project_stop' && selection.kind === 'project') {
      operationBusyRef.current = true; setOperationBusy(true); setConfirmError('');
      void activeApi.invoke<StopPlan>('stop_preview', {scope: 'project', project: selection.project, context: data.context}).then((plan) => {
        if (!plan.targets.length) {setNotice('项目已全部停止。'); return;}
        setConfirm({method: 'stop_confirm', params: {scope: 'project', project: selection.project, context: plan.context, ids: plan.targets.map((target) => target.id)}, title: '停止整个 Compose 项目？', description: plan.context + ' · ' + selection.project + '\n' + plan.targets.map((target) => target.name).join('\n') + '\n保留容器、网络和数据卷。'});
      }).catch((reason) => setError(noticeText(reason))).finally(() => {operationBusyRef.current = false; setOperationBusy(false);});
      return;
    }
    if (action === 'image_remove' && selection.kind === 'image' && imageDetail) {setConfirmError(''); setConfirm({method: 'image_remove', params: {id: selection.id, reference: selection.reference, context: data.context}, title: '删除镜像标签？', description: data.context + '\n' + selection.reference + '\n' + selection.id + '\n将删除本地标签；这是最后一个引用时也会删除镜像。此操作不能撤销。'}); return;}
    if (selection.kind !== 'container' || !current) return;
    if (action === 'container_remove') {setConfirmError(''); setConfirm({method: action, params: {id: current.id, context: data.context}, title: '删除容器？', description: data.context + ' · ' + current.name + '\n将永久删除容器、可写层及日志；保留数据卷、挂载目录和镜像。'}); return;}
    const name = {start: '启动', stop: '停止', restart: '重启'}[action as 'start' | 'stop' | 'restart'];
    if (name) {setConfirmError(''); setConfirm({method: 'operate', params: {id: current.id, action, context: data.context}, title: name + '容器？', description: data.context + ' · ' + current.name + '\n' + (name === '启动' ? '按原配置启动。' : '服务可能暂时中断。')});}
  }
  async function confirmAction() {
    if (readOnly || !confirm || operationBusyRef.current) return;
    operationBusyRef.current = true; setOperationBusy(true); setConfirmError(''); setNotice('正在执行，请稍候…');
    try {
      const result = await activeApi.invoke<StopResult>(confirm.method, {...confirm.params, confirmed: true});
      const message = result.results ? result.results.map((row) => row.name + '：' + (row.stopped ? '已停止' : row.error || '未确认停止')).join('\n') : '操作完成';
      setConfirm(null); setNotice(message); await refresh();
    } catch (reason) {setConfirmError(noticeText(reason));}
    finally {operationBusyRef.current = false; setOperationBusy(false);}
  }
  const visibleLogs = useMemo(() => {const normalized = logQuery.toLowerCase(); return normalized ? logs.split('\n').filter((line) => line.toLowerCase().includes(normalized)).join('\n') : logs;}, [logQuery, logs]);
  const actions = selection?.kind === 'container' ? actionAvailability(current) : null;
  const listTitle = scope === 'images' ? '本地镜像' : '项目与容器';
  const title = current?.name || (selection?.kind === 'project' ? selection.project : selection?.kind === 'image' ? selection.reference : '选择资源');
  const state = current ? statusLabels[current.state] || current.state : selection?.kind === 'project' ? projectRows.filter((row) => row.state === 'running').length + ' / ' + projectRows.length + ' 运行' : selection?.kind === 'image' && imageDetail ? (imageDetail.containers.length ? '被容器引用' : '未被容器引用') : '';

  return <main className="docker-page">
    <header className="docker-header"><div><h1>{context.title || 'Docker 管理'} <span className="docker-context">{data.context || '正在连接'}</span></h1><p>按项目组织容器，查看服务与镜像。<HelpPopover label="管理页说明">只连接本机 Unix socket Docker context；远程 context、Compose 文件编辑、镜像构建与推送不在本页执行。</HelpPopover></p></div><div className="docker-header-actions"><Button hidden={isWidget} disabled={readOnly} onClick={() => void activeApi.invoke('flowhub_status').catch((reason) => setError(noticeText(reason)))}>桌面悬浮窗</Button><Button hidden={Boolean(window.FlowHubTheme?.hosted)} onClick={() => window.FlowHubTheme?.set(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')}>切换外观</Button><Button onClick={() => {setNotice(''); void refresh();}} disabled={loading || operationBusy}>{loading ? '刷新中…' : '↻ 刷新'}</Button></div></header>
    {readOnly ? <div className="docker-preview" role="status">只读模拟预览 · 不连接 Docker，不执行操作</div> : null}
    {error ? <div className="docker-alert" role="alert">{error}</div> : null}
    {notice ? <div className="docker-notice" role="status">{notice}</div> : null}
    {scope === 'settings' ? <><ScopeNav scope={scope} onChange={changeScope} disabled={operationBusy}/><SettingsPanel settings={settings} theme={theme} context={data.context} onSave={saveSettings} onReset={resetSettings}/></> : <>
      <StatStrip columns={4} className="docker-stats"><StatItem label="全部容器" value={data.containers.length}/><StatItem label="运行中" value={data.containers.filter((row) => row.state === 'running').length} tone="positive"/><StatItem label="需要关注" value={data.containers.filter(isIssue).length} tone="danger"/><StatItem label="Compose 项目" value={new Set(data.containers.map((row) => row.project).filter(Boolean)).size}/></StatStrip>
      <ScopeNav scope={scope} onChange={changeScope} disabled={loading || operationBusy}/><section className="docker-workspace"><aside className="docker-sidebar"><div className="docker-list-heading"><h2>{listTitle}</h2><span>{updated}</span></div><Input type="search" aria-label="搜索资源" placeholder="搜索名称、镜像或项目" value={query} onChange={(event) => setQuery(event.target.value)}/><ResourceList containers={data.containers} images={images} scope={scope} query={query} onlyIssues={settings.onlyIssues} selected={selection} collapsed={collapsed} onToggleProject={(project) => setCollapsed((currentSet) => {const next = new Set(currentSet); if (next.has(project)) next.delete(project); else next.add(project); return next;})} onSelect={select}/></aside>
        <section className="docker-detail" aria-live="polite">{selection ? <><div className="docker-detail-heading"><div><span className="docker-eyebrow">{current ? (current.project ? current.project + ' / ' + current.service : '独立容器') : selection.kind === 'project' ? 'COMPOSE PROJECT' : 'LOCAL IMAGE'}</span><h2>{title}</h2><p>{current?.image || ''}</p></div><span className="docker-badge">{state}</span></div>
          <div className="docker-actions">{actions ? <><Button size="sm" disabled={!actions.start || readOnly || operationBusy} onClick={() => prepareAction('start')}>启动</Button><Button size="sm" disabled={!actions.stop || readOnly || operationBusy} onClick={() => prepareAction('stop')}>停止</Button><Button size="sm" disabled={!actions.restart || readOnly || operationBusy} onClick={() => prepareAction('restart')}>重启</Button><Button size="sm" variant="danger" disabled={!actions.remove || readOnly || operationBusy} onClick={() => prepareAction('container_remove')}>删除容器</Button><Button size="sm" onClick={() => {const text = 'docker --context \'' + data.context.replaceAll('\'', '\\\'') + '\' logs --tail 300 --timestamps ' + (current?.id || ''); if (!navigator.clipboard?.writeText) {setNotice(text); return;} void navigator.clipboard.writeText(text).then(() => setNotice('已复制日志命令'), () => setNotice('无法复制，请手动复制日志命令。'));}}>复制日志命令</Button></> : selection.kind === 'project' ? <Button size="sm" variant="danger" disabled={readOnly || operationBusy || !projectRows.some((row) => ['running', 'restarting', 'paused'].includes(row.state))} onClick={() => prepareAction('project_stop')}>停止整个项目</Button> : selection.kind === 'image' ? <Button size="sm" variant="danger" disabled={readOnly || operationBusy || !imageDetail || Boolean(imageDetail.containers.length)} onClick={() => prepareAction('image_remove')}>删除镜像标签</Button> : null}</div>
          {selection.kind === 'container' ? <Tabs value={tab} onValueChange={(value) => setTab(value as 'overview' | 'logs')}><Tabs.List aria-label="容器详情"><Tabs.Trigger value="overview">概览</Tabs.Trigger><Tabs.Trigger value="logs">运行日志</Tabs.Trigger></Tabs.List><Tabs.Panel value="overview">{detailLoading ? <p className="docker-loading">正在读取详情…</p> : <DetailOverview selection={selection} container={current} detail={detail} imageDetail={imageDetail} projectRows={projectRows} onSelect={select}/>}</Tabs.Panel><Tabs.Panel value="logs"><div className="docker-log-tools"><Input type="search" aria-label="过滤日志" placeholder="过滤日志内容" value={logQuery} onChange={(event) => setLogQuery(event.target.value)}/><Checkbox checked={followLogs} onChange={setFollowLogs} label="每 3 秒刷新"/><Button size="sm" disabled={logsInFlight.current === generation.current} onClick={() => void loadLogs()}>刷新日志</Button></div><p className="docker-muted">最近 300 行 · stdout / stderr 分段展示 · 最多各 512 KiB</p><Textarea readOnly value={visibleLogs || '暂无匹配日志'} className="docker-log-output"/></Tabs.Panel></Tabs> : detailLoading ? <p className="docker-loading">正在读取详情…</p> : <DetailOverview selection={selection} container={current} detail={detail} imageDetail={imageDetail} projectRows={projectRows} onSelect={select}/>}</> : <EmptyState icon="◇" title="选择项目、容器或镜像" description="点击名称查看详情，箭头控制项目展开。"/>}</section></section></>}
    <footer className="docker-footer"><span>仅连接本机 Docker 环境</span><span>列表每 {settings.refreshSeconds} 秒更新 · 删除前需确认</span></footer>
    <DialogShell open={Boolean(confirm)} onOpenChange={(open) => {if (!open && !operationBusy) {setConfirm(null); setConfirmError('');}}} onCancel={(event) => {if (operationBusy) event.preventDefault();}} title={confirm?.title || ''} description="请核对下面的 context、对象和影响范围后确认。" footer={<><Button disabled={operationBusy} onClick={() => setConfirm(null)}>取消</Button><Button variant="danger" disabled={operationBusy} onClick={() => void confirmAction()}>{operationBusy ? '执行中…' : '确认操作'}</Button></>}>{confirm ? <>{confirmError ? <p className="docker-error" role="alert">{confirmError}</p> : null}<p className="docker-confirm-text">{confirm.description}</p></> : null}</DialogShell>
  </main>;
}
