import {useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent, type ReactNode} from 'react';
import {
  Button, Checkbox, DialogShell, EmptyState, Field, FormSection, HelpPopover, Input,
  Select, Tabs,
} from '@flowhub/plugin-common/react';
import type {
  Container, ContainerDetail, HostContext, ImageDetail, ImageSummary, ListResult,
  ImagePrunePlan, ImagePruneResult, ManagementApi, Scope, Selection, StopPlan, StopResult,
} from './api';
import {createPreviewApi} from './api';
import {ContainerTerminal} from './ContainerTerminal';
import {ContainerLogs} from './ContainerLogs';
import {LogSessions,type LogState} from './log-state';
import {resourceKey,useResourceNavigation,type BrowseView,type DetailTab} from './useResourceNavigation';
import {actionAvailability, filterContainers, formatDate, formatImageBytes, groupContainers, imageDeleteLabel, imageLabel, imageReference, reorderGroups, sortGroups, statusLabels} from './model';

interface Settings {
  refreshSeconds: number;
  defaultScope: Exclude<Scope, 'settings'>;
  onlyIssues: boolean;
  expandCompose: boolean;
}
const settingsKey = 'flowhub.docker.management.settings.v1';
const groupOrderKey = 'flowhub.docker.management.group-order.v1';
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
function loadGroupOrders(): Record<string, string[]> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(groupOrderKey) || '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Record<string, string[]> : {};
  } catch { return {}; }
}
function selectedContainer(selection: Selection | null, containers: Container[]): Container | null {
  return selection?.kind === 'container' ? containers.find((row) => row.id === selection.id) ?? null : null;
}
function selectedProject(selection: Selection | null, containers: Container[]): Container[] {
  return selection?.kind === 'project' ? containers.filter((row) => row.project === selection.project) : [];
}

type ScopeCounts = Record<Exclude<Scope, 'settings'>, number | null>;
const scopeTabs = [
  ['all', '全部'], ['compose', 'Compose'], ['standalone', '独立容器'],
  ['images', '镜像'], ['settings', '通用设置'],
] as const;

function ScopeNav({scope, counts, onChange, disabled}: {scope: Scope; counts: ScopeCounts; onChange(value: Scope): void; disabled: boolean}) {
  return <nav className="docker-scope-nav" aria-label="资源类型">
    {scopeTabs.map(([value, label]) => <button key={value} type="button" className={scope === value ? 'is-active' : ''} aria-pressed={scope === value} disabled={disabled} onClick={() => onChange(value)}>{label}{value !== 'settings' ? <span className="docker-scope-nav__count">{counts[value] ?? '—'}</span> : null}</button>)}
  </nav>;
}

function ImagePrunePreview({plan}: {plan: ImagePrunePlan}) {
  return <div className="docker-prune-preview">
    <p><strong>{plan.context} · {plan.targets.length} 个未使用镜像</strong></p>
    <p>镜像大小合计 {formatImageBytes(plan.totalBytes)}。共享层和构建缓存可能使实际释放空间更少。</p>
    <p>将清理所有未被任何容器引用的镜像，包含带标签镜像。保留已停止容器引用的镜像、全部容器、数据卷、网络和构建缓存。此操作不可撤销，再次使用需重新拉取或构建。</p>
    <ul className="docker-prune-targets" aria-label="待清理镜像">{plan.targets.map(image => <li key={image.id}>
      <strong>{image.references.length ? image.references.join('\n') : '无标签镜像'}</strong>
      <span>{image.size}</span><small>{image.id}</small>
    </li>)}</ul>
  </div>;
}

function ResourceList({containers, images, scope, query, onlyIssues, selected, collapsed, groupOrder, onToggleProject, onReorderProject, onSelect}: {
  containers: Container[]; images: ImageSummary[]; scope: Scope; query: string; onlyIssues: boolean; selected: Selection | null;
  collapsed: Set<string>; groupOrder: string[]; onToggleProject(project: string): void; onReorderProject(source: string, target: string): void; onSelect(selection: Selection,origin?:HTMLElement): void;
}) {
  const dragging = useRef<{project: string; x: number; y: number; moved: boolean} | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  function targetAt(x: number, y: number): string | null {
    const element = document.elementFromPoint(x, y);
    if (!element || !listRef.current?.contains(element)) return null;
    return element.closest('[data-docker-project]')?.getAttribute('data-docker-project') ?? null;
  }
  function startDrag(event: PointerEvent<HTMLButtonElement>, project: string) {
    dragging.current = {project, x: event.clientX, y: event.clientY, moved: false};
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const active = dragging.current;
    if (!active) return;
    if (!active.moved && Math.hypot(event.clientX - active.x, event.clientY - active.y) < 6) return;
    active.moved = true;
    const target = targetAt(event.clientX, event.clientY);
    setDropTarget(target === active.project ? null : target);
  }
  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    const active = dragging.current;
    dragging.current = null;
    setDropTarget(null);
    if (!active?.moved) return;
    const target = targetAt(event.clientX, event.clientY);
    if (target !== null && target !== active.project) onReorderProject(active.project, target);
  }
  if (scope === 'images') {
    const visible = images.filter((image) => (imageLabel(image) + ' ' + imageReference(image) + ' ' + image.ID).toLowerCase().includes(query.trim().toLowerCase()));
    return visible.length ? <div className="docker-resource-list" aria-label="镜像列表">{visible.map((image) => {
      const reference = imageReference(image);
      return <button type="button" key={image.ID + reference} data-docker-select={resourceKey({kind:'image',id:image.ID,reference})} className={'docker-resource-row ' + (selected?.kind === 'image' && selected.reference === reference ? 'is-selected' : '')} onClick={event => onSelect({kind: 'image', id: image.ID, reference},event.currentTarget)}>
        <span className="docker-resource-copy"><strong>{imageLabel(image)}</strong><small>{image.Size} · {image.CreatedSince}<br/>{image.ID.slice(0, 24)}</small></span>
      </button>;
    })}</div> : <EmptyState size="compact" title="没有匹配的本地镜像"/>;
  }
  const visible = filterContainers(containers, scope === 'settings' ? 'all' : scope, query, onlyIssues);
  const groups = sortGroups(groupContainers(visible), groupOrder);
  return groups.length ? <div ref={listRef} className="docker-resource-list" aria-label="资源列表">{groups.map(([project, rows]) => {
    const isCollapsed = collapsed.has(project);
    const index = groups.findIndex(([name]) => name === project);
    return <div key={project ? 'project:' + project : 'standalone'} data-docker-project={project} className={'docker-resource-group' + (dropTarget === project ? ' is-drop-target' : '')}>
      <div className="docker-group-heading">
        {project ? <><button type="button" className="docker-fold" aria-label={(isCollapsed ? '展开 ' : '收起 ') + project} aria-expanded={!isCollapsed} onClick={() => onToggleProject(project)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 6 4.5 4 4.5-4"/></svg></button><button type="button" className="docker-project-link" data-docker-select={resourceKey({kind:'project',project})} onClick={event => onSelect({kind: 'project', project},event.currentTarget)}>{project}</button></> : <span>独立容器</span>}
        {groups.length > 1 ? <button type="button" className="docker-group-drag" aria-label={'拖动排序 ' + (project || '独立容器')} title="拖动排序；方向键也可调整，仅改变页面显示顺序" onPointerDown={(event) => startDrag(event, project)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={() => {dragging.current = null; setDropTarget(null);}} onKeyDown={(event) => {if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {const target = groups[index + (event.key === 'ArrowUp' ? -1 : 1)]; if (target) {event.preventDefault(); onReorderProject(project, target[0]);}}}}>⠿</button> : null}
        <small>{rows.filter((row) => row.state === 'running').length}/{rows.length} 运行</small>
      </div>
      {!isCollapsed && rows.map((row) => <button type="button" key={row.id} data-docker-select={resourceKey({kind:'container',id:row.id})} className={'docker-resource-row ' + (selected?.kind === 'container' && selected.id === row.id ? 'is-selected' : '')} onClick={event => onSelect({kind: 'container', id: row.id},event.currentTarget)}>
        <span className={'docker-status-dot ' + (row.status.includes('unhealthy') ? 'unhealthy' : row.state)} aria-hidden="true"/>
        <span className="docker-resource-copy"><strong>{row.name}</strong><small>{statusLabels[row.state] || row.state} · {row.image}</small></span>
      </button>)}
    </div>;
  })}</div> : <EmptyState size="compact" title="没有匹配的容器"/>;
}

function DetailOverview({selection, container, detail, imageDetail, imageSize, projectRows, onSelect}: {
  selection: Selection; container: Container | null; detail: ContainerDetail | null; imageDetail: ImageDetail | null; imageSize?: string; projectRows: Container[]; onSelect(selection: Selection,origin?:HTMLElement): void;
}) {
  if (selection.kind === 'project') {
    return <div className="docker-overview-content"><p className="docker-project-note">{projectRows.length} 个成员容器 <HelpPopover label="项目成员说明">点击服务查看容器资源、日志与操作。</HelpPopover></p>{projectRows.map((row) => <button type="button" className="docker-member-row" key={row.id} data-docker-select={resourceKey({kind:'container',id:row.id})} onClick={event => onSelect({kind: 'container', id: row.id},event.currentTarget)}><span>{row.service || row.name}<small>{row.name} · {row.image}</small></span><small>{statusLabels[row.state] || row.state} ↗</small></button>)}</div>;
  }
  if (selection.kind === 'image' && imageDetail) {
    return <div className="docker-overview-content"><dl className="docker-detail-grid">
      <dt>镜像 ID</dt><dd>{imageDetail.id}</dd><dt>全部引用</dt><dd>{[...new Set([...(imageDetail.tags ?? []), ...(imageDetail.digests ?? [])])].join('\n') || '无标签或摘要引用'}</dd>
      <dt>平台</dt><dd>{imageDetail.os || '未知'} / {imageDetail.architecture || '未知'}</dd>
      <dt>大小</dt><dd>{imageSize || (typeof imageDetail.size === 'number' ? (imageDetail.size / 1048576).toFixed(1) + ' MiB' : '未知')}</dd>
      <dt>创建时间</dt><dd>{formatDate(imageDetail.created, '未提供创建时间')}</dd><dt>摘要</dt><dd>{imageDetail.digests?.join('\n') || '无'}</dd>
    </dl><h3>引用此镜像或其派生镜像的容器</h3>
      {imageDetail.containers.length ? imageDetail.containers.map((row) => <button type="button" className="docker-member-row" key={row.id} data-docker-select={resourceKey({kind:'container',id:row.id})} onClick={event => onSelect({kind: 'container', id: row.id},event.currentTarget)}><span>{row.name}</span><small>{statusLabels[row.state] || row.state} ↗</small></button>) : <p className="docker-muted">暂无容器引用。</p>}
    </div>;
  }
  if (!container || !detail) return <EmptyState size="compact" title="暂无可用详情"/>;
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
    <form onSubmit={submit} className="docker-settings-form"><FormSection legend="刷新与范围" actions={<HelpPopover label="刷新与范围说明">后台采集由插件统一维护；这里仅控制管理页面的刷新频率与打开时的筛选范围。</HelpPopover>}>
      <Field label="刷新频率" htmlFor="docker-refresh"><Select id="docker-refresh" value={String(draft.refreshSeconds)} onChange={(value) => setDraft({...draft, refreshSeconds: Number(value)})} options={[15, 30, 60, 120].map((value) => ({value: String(value), label: value < 60 ? '每 ' + value + ' 秒' : '每 ' + value / 60 + ' 分钟'}))}/></Field>
      <Field label="打开时的默认范围" htmlFor="docker-scope"><Select id="docker-scope" value={draft.defaultScope} onChange={(value) => setDraft({...draft, defaultScope: value as Settings['defaultScope']})} options={scopeOptions}/></Field>
      <Checkbox checked={draft.onlyIssues} onChange={(checked) => setDraft({...draft, onlyIssues: checked})} label="默认只显示异常容器"/>
      <Checkbox checked={draft.expandCompose} onChange={(checked) => setDraft({...draft, expandCompose: checked})} label="默认展开 Compose 项目"/>
    </FormSection><FormSection legend="外观"><Field label="主题" htmlFor="docker-theme"><Select id="docker-theme" value={draftTheme} disabled={Boolean(window.FlowHubTheme?.hosted)} onChange={setDraftTheme} options={[{value: 'system', label: '跟随系统'}, {value: 'light', label: '浅色'}, {value: 'dark', label: '深色'}]}/></Field></FormSection>
      <div className="docker-settings-actions"><Button type="submit" variant="primary">保存设置</Button><Button type="button" onClick={onReset}>恢复默认</Button></div>
    </form><div className="docker-settings-note"><strong>当前 Docker 环境 <HelpPopover label="Docker 环境说明">Docker context 由本机 Docker CLI 管理；环境变化时会清除当前选择。</HelpPopover></strong><span>{context || '尚未连接'}</span></div>
  </section>;
}

export function App({api, context}: {api: ManagementApi; context: HostContext}) {
  const [settings, setSettings] = useState(loadSettings);
  const [theme, setTheme] = useState(() => window.FlowHubTheme?.get() || 'system');
  const [scope, setScope] = useState<Scope>(() => scopeOptions.some((item) => item.value === context.config?.type) ? context.config!.type as Scope : settings.defaultScope);
  const [data, setData] = useState<ListResult>({context: '', containers: []});
  const [images, setImages] = useState<ImageSummary[] | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [detail, setDetail] = useState<ContainerDetail | null>(null);
  const [imageDetail, setImageDetail] = useState<ImageDetail | null>(null);
  const [tab, setTab] = useState<DetailTab>('overview');
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [groupOrders, setGroupOrders] = useState<Record<string, string[]>>(loadGroupOrders);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const resizing = useRef<{x: number; width: number} | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailReload, setDetailReload] = useState(0);
  const [operationBusy, setOperationBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<{method: string; params: Record<string, unknown>; title: string; description: string; prune?: ImagePrunePlan} | null>(null);
  const [confirmError, setConfirmError] = useState('');
  const appliedInitial = useRef(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const operationBusyRef = useRef(false);
  const imagesContextRef = useRef('');
  const sidebar=useRef<HTMLElement>(null),detailPane=useRef<HTMLElement>(null),logSessions=useRef(new LogSessions());
  const rememberLogs=useCallback((context:string,id:string,state:LogState)=>logSessions.current.remember(context,id,state),[]);
  const applyView=useCallback((view:BrowseView)=>{generation.current++;setScope(view.scope);setSelection(view.selection);setQuery(view.query);setTab(view.tab);setDetailError('');setDetailLoading(Boolean(view.selection && ['container','image'].includes(view.selection.kind)));},[]);
  const navigation=useResourceNavigation({context:data.context,view:{scope,selection,query,tab},apply:applyView,disabled:operationBusy || Boolean(confirm),ready:!detailLoading,list:sidebar,detail:detailPane});
  const current = useMemo(() => selectedContainer(selection, data.containers), [data.containers, selection]);
  const projectRows = useMemo(() => selectedProject(selection, data.containers), [data.containers, selection]);
  const isWidget = Boolean(window.FlowHubWidget && window.parent !== window);
  const previewApi = useMemo(createPreviewApi, []);
  const activeApi = context.preview ? previewApi : api;
  const readOnly = activeApi.preview || Boolean(context.preview);

  const refresh = useCallback(async (afterOperation = false) => {
    if (inFlight.current || (operationBusyRef.current && !afterOperation) || scope === 'settings') return;
    inFlight.current = true; setLoading(true); setError('');
    try {
      const next = await activeApi.invoke<ListResult>('list');
      logSessions.current.activate(next.context);
      if (data.context && data.context !== next.context) {setSelection(null);setConfirm(null);setConfirmError(''); setNotice('Docker 环境已变化，已清除原环境中的选择和待确认操作。'); generation.current += 1;}
      setData(next);
      if (imagesContextRef.current !== next.context) setImages(null);
      if (scope === 'images' || imagesContextRef.current !== next.context) {
        try {
          const result = await activeApi.invoke<{images: ImageSummary[]}>('images', {context: next.context});
          setImages(result.images);
          imagesContextRef.current = next.context;
        } catch (reason) {
          if (scope === 'images') throw reason;
        }
      }
    } catch (reason) {setError(noticeText(reason) + '\n请检查 Docker 引擎后刷新。');}
    finally {inFlight.current = false; setLoading(false);}
  }, [activeApi, data.context, operationBusy, scope]);

  useEffect(() => {void refresh(); const timer = window.setInterval(() => {if (!document.hidden) void refresh();}, settings.refreshSeconds * 1000); return () => window.clearInterval(timer);}, [refresh, settings.refreshSeconds]);
  useEffect(() => {try {localStorage.setItem(groupOrderKey, JSON.stringify(groupOrders));} catch { /* sorting remains available for this session */ }}, [groupOrders]);
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
    setDetailError('');
    if (!selection || selection.kind === 'project' || selection.kind === 'images') {setDetailLoading(false); setDetail(null); setImageDetail(null); return;}
    const revision = ++generation.current; setDetailLoading(true); setDetail(null); setImageDetail(null);
    const method = selection.kind === 'image' ? 'image_detail' : 'detail';
    const params = selection.kind === 'image' ? {id: selection.id, context: data.context} : {id: selection.id, context: data.context};
    void activeApi.invoke<ContainerDetail & ImageDetail>(method, params).then((result) => {
      if (revision !== generation.current) return;
      if (selection.kind === 'image') setImageDetail(result as ImageDetail); else setDetail(result as ContainerDetail);
    }).catch((reason) => {if (revision === generation.current) setDetailError(noticeText(reason));}).finally(() => {if (revision === generation.current) setDetailLoading(false);});
    return () => {if (revision === generation.current) generation.current += 1;};
  }, [activeApi, data.context, selection, detailReload]);
  function select(next: Selection|null,origin?:HTMLElement) {navigation.select(next,origin);}
  function goBack() {setSidebarCollapsed(false);navigation.back();}
  function resizeSidebar(value: number) {setSidebarWidth(Math.max(220, Math.min(380, value)));}
  function reorderProject(source: string, target: string) {setGroupOrders((previous) => ({...previous, [data.context]: reorderGroups(groupContainers(data.containers), Array.isArray(previous[data.context]) ? previous[data.context] : [], source, target)}));}
  function changeScope(next: Scope) {navigation.change({scope:next,selection:null,query,tab:'overview'});}
  function saveSettings(next: Settings, nextTheme: string) {navigation.clear();setSettings(next); localStorage.setItem(settingsKey, JSON.stringify(next)); setTheme(nextTheme); if (!window.FlowHubTheme?.hosted) window.FlowHubTheme?.set(nextTheme); setScope(next.defaultScope); generation.current += 1; setSelection(null); setCollapsed(next.expandCompose ? new Set() : new Set(data.containers.filter((row) => row.project).map((row) => row.project))); setNotice('设置已保存');}
  function resetSettings() {saveSettings(defaultSettings, 'system'); setNotice('已恢复默认设置');}
  async function prepareImagePrune() {
    if (readOnly || operationBusyRef.current || inFlight.current || error || !data.context) return;
    operationBusyRef.current = true; setOperationBusy(true); setConfirmError(''); setError(''); setNotice('正在检查未使用镜像…');
    try {
      const plan = await activeApi.invoke<ImagePrunePlan>('image_prune_preview', {context: data.context});
      if (!plan.targets.length) {setNotice('没有可清理的未使用镜像。已停止容器引用的镜像也会保留。'); return;}
      setNotice('');
      setConfirm({method: 'image_prune_confirm', params: {context: plan.context, targets: plan.targets}, title: '清理未使用镜像？', description: '', prune: plan});
    } catch (reason) {setNotice(''); setError(noticeText(reason));}
    finally {operationBusyRef.current = false; setOperationBusy(false);}
  }
  function prepareAction(action: string) {
    if (readOnly || !selection || operationBusyRef.current || inFlight.current || error) return;
    if (action === 'project_stop' && selection.kind === 'project') {
      operationBusyRef.current = true; setOperationBusy(true); setConfirmError('');
      void activeApi.invoke<StopPlan>('stop_preview', {scope: 'project', project: selection.project, context: data.context}).then((plan) => {
        if (!plan.targets.length) {setNotice('项目已全部停止。'); return;}
        setConfirm({method: 'stop_confirm', params: {scope: 'project', project: selection.project, context: plan.context, ids: plan.targets.map((target) => target.id)}, title: '停止整个 Compose 项目？', description: plan.context + ' · ' + selection.project + '\n' + plan.targets.map((target) => target.name).join('\n') + '\n保留容器、网络和数据卷。'});
      }).catch((reason) => setError(noticeText(reason))).finally(() => {operationBusyRef.current = false; setOperationBusy(false);});
      return;
    }
    if (action === 'image_remove' && selection.kind === 'image' && imageDetail?.id === selection.id && !imageDetail.containers.length && images?.some(image => image.ID === selection.id && imageReference(image) === selection.reference)) {setConfirmError(''); setConfirm({method: 'image_remove', params: {id: selection.id, reference: selection.reference, context: data.context}, title: imageDeleteLabel(selection.reference) + '？', description: data.context + '\n' + selection.reference + '\n' + selection.id + '\n' + (selection.reference === selection.id ? '将删除该无标签镜像。此操作不能撤销。' : '将移除所选的本地镜像引用；若为最后一个引用，也会删除镜像。此操作不能撤销。')}); return;}
    if (selection.kind !== 'container' || !current) return;
    if (action === 'container_remove') {setConfirmError(''); setConfirm({method: action, params: {id: current.id, context: data.context}, title: '删除容器？', description: data.context + ' · ' + current.name + '\n将永久删除容器、可写层及日志；保留数据卷、挂载目录和镜像。'}); return;}
    const name = {start: '启动', stop: '停止', restart: '重启'}[action as 'start' | 'stop' | 'restart'];
    if (name) {setConfirmError(''); setConfirm({method: 'operate', params: {id: current.id, action, context: data.context}, title: name + '容器？', description: data.context + ' · ' + current.name + '\n' + (name === '启动' ? '按原配置启动。' : '服务可能暂时中断。')});}
  }
  async function confirmAction() {
    if (readOnly || !confirm || operationBusyRef.current) return;
    operationBusyRef.current = true; setOperationBusy(true); setConfirmError(''); setNotice('正在执行，请稍候…');
    try {
      const result = await activeApi.invoke<StopResult & ImagePruneResult>(confirm.method, {...confirm.params, confirmed: true});
      const message = confirm.prune ? `已清理 ${result.removed} 个镜像，Docker 报告释放 ${result.reclaimed ?? '空间未知'}。${result.remaining ? `仍有 ${result.remaining} 个镜像被保留，请刷新核对引用关系。` : ''}` : result.results ? result.results.map((row) => row.name + '：' + (row.stopped ? '已停止' : row.error || '未确认停止')).join('\n') : '操作完成';
      if (confirm.prune || ['image_remove', 'container_remove'].includes(confirm.method)) {generation.current += 1; setSelection(null);}
      setConfirm(null); setNotice(message); await refresh(true);
    } catch (reason) {setNotice(''); setConfirmError(noticeText(reason));}
    finally {operationBusyRef.current = false; setOperationBusy(false);}
  }
  const actions = selection?.kind === 'container' ? actionAvailability(current) : null;
  const listTitle = scope === 'images' ? '本地镜像' : '项目与容器';
  const selectedImage = selection?.kind === 'image' ? images?.find(image => image.ID === selection.id && imageReference(image) === selection.reference) : undefined;
  const title = current?.name || (selection?.kind === 'container' ? '容器已不可用' : selection?.kind === 'project' ? selection.project : selection?.kind === 'image' ? selectedImage ? imageLabel(selectedImage) : selection.reference : '选择资源');
  const state = current ? statusLabels[current.state] || current.state : selection?.kind === 'project' ? projectRows.filter((row) => row.state === 'running').length + ' / ' + projectRows.length + ' 运行' : selection?.kind === 'image' && imageDetail ? (imageDetail.containers.length ? '被容器引用' : '未被容器引用') : '';
  const actionsDisabled=readOnly || operationBusy || loading || Boolean(error);
  const selectionHidden=Boolean(current && (scope==='images' || !filterContainers(data.containers,scope==='settings'?'all':scope,query,settings.onlyIssues).some(row=>row.id===current.id) || current.project && collapsed.has(current.project)));
  const containerActions = actions ? <div className="docker-actions docker-actions--overview"><Button size="sm" disabled={!actions.start || actionsDisabled} onClick={() => prepareAction('start')}>启动</Button><Button size="sm" disabled={!actions.stop || actionsDisabled} onClick={() => prepareAction('stop')}>停止</Button><Button size="sm" disabled={!actions.restart || actionsDisabled} onClick={() => prepareAction('restart')}>重启</Button><Button size="sm" variant="danger" disabled={!actions.remove || actionsDisabled} onClick={() => prepareAction('container_remove')}>删除容器</Button></div> : null;
  const imageDetailReady = Boolean(selectedImage) && selection?.kind === 'image' && imageDetail?.id === selection.id;
  const imageDeleteReason = detailError ? '详情读取失败，请重试后核对删除条件。' : imageDetailReady && imageDetail.containers.length ? `被 ${imageDetail.containers.length} 个容器引用（包括已停止容器），请先处理下方关联容器。` : '';
  const overviewContent = detailLoading ? <p className="docker-loading" role="status">正在读取详情…</p> : detailError ? <div className="docker-detail-error" role="alert"><p className="docker-error">详情读取失败：{detailError}</p><Button size="sm" onClick={() => setDetailReload(value => value + 1)}>重试读取详情</Button></div> : selection ? <DetailOverview selection={selection} container={current} detail={detail} imageDetail={imageDetail} imageSize={selectedImage?.Size} projectRows={projectRows} onSelect={select}/> : null;
  const counts: ScopeCounts = {
    all: data.containers.length,
    compose: new Set(data.containers.map((row) => row.project).filter(Boolean)).size,
    standalone: data.containers.filter((row) => !row.project).length,
    images: images?.length ?? null,
  };

  return <main className="docker-page">
    <header className="docker-header"><div><h1>{context.title || 'Docker 管理'} <span className="docker-context">{data.context || '正在连接'}</span> <HelpPopover label="管理页说明">按项目组织容器，查看服务与镜像。仅连接本机 Docker context；远程 context、Compose 文件编辑、镜像构建与推送不在本页执行。列表每 {settings.refreshSeconds} 秒刷新，删除操作均需确认。</HelpPopover></h1></div><div className="docker-header-actions">{scope === 'images' ? <Button variant="danger" disabled={readOnly || loading || operationBusy || !data.context} onClick={() => void prepareImagePrune()}>清理未使用镜像</Button> : null}<Button hidden={isWidget} disabled={readOnly} onClick={() => void activeApi.invoke('flowhub_status').catch((reason) => setError(noticeText(reason)))}>桌面悬浮窗</Button><Button hidden={Boolean(window.FlowHubTheme?.hosted)} onClick={() => window.FlowHubTheme?.set(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')}>切换外观</Button><Button onClick={() => {setNotice(''); setDetailReload(value => value + 1); void refresh();}} disabled={loading || operationBusy}>{loading ? '刷新中…' : '↻ 刷新'}</Button></div></header>
    {readOnly ? <div className="docker-preview" role="status">只读模拟预览 · 不连接 Docker，不执行操作</div> : null}
    {error ? <div className="docker-alert" role="alert">{error}</div> : null}
    {notice ? <div className="docker-notice" role="status">{notice}</div> : null}
    {scope === 'settings' ? <><ScopeNav scope={scope} counts={counts} onChange={changeScope} disabled={operationBusy}/><SettingsPanel settings={settings} theme={theme} context={data.context} onSave={saveSettings} onReset={resetSettings}/></> : <>
      <ScopeNav scope={scope} counts={counts} onChange={changeScope} disabled={loading || operationBusy}/><section className={'docker-workspace' + (sidebarCollapsed ? ' is-sidebar-collapsed' : '')} style={{'--docker-sidebar-width': `${sidebarWidth}px`} as CSSProperties}><aside ref={sidebar} className="docker-sidebar"><div className="docker-list-heading"><h2>{listTitle}</h2><button type="button" className="docker-sidebar-toggle" aria-label="收起资源列表" title="收起资源列表" onClick={() => setSidebarCollapsed(true)}>‹</button></div><Input type="search" aria-label="搜索资源" placeholder="搜索名称、镜像或项目" value={query} onChange={(event) => setQuery(event.target.value)}/><ResourceList containers={data.containers} images={images ?? []} scope={scope} query={query} onlyIssues={settings.onlyIssues} selected={selection} collapsed={collapsed} groupOrder={Array.isArray(groupOrders[data.context]) ? groupOrders[data.context] : []} onToggleProject={(project) => setCollapsed((currentSet) => {const next = new Set(currentSet); if (next.has(project)) next.delete(project); else next.add(project); return next;})} onReorderProject={reorderProject} onSelect={select}/></aside>
        <div className="docker-sidebar-rail">{sidebarCollapsed ? <button type="button" aria-label="展开资源列表" title="展开资源列表" onClick={() => setSidebarCollapsed(false)}>›</button> : <div className="docker-sidebar-divider" role="separator" tabIndex={0} aria-label="拖动调整资源列表宽度" aria-orientation="vertical" aria-valuemin={220} aria-valuemax={380} aria-valuenow={sidebarWidth} onPointerDown={(event) => {resizing.current = {x: event.clientX, width: sidebarWidth}; event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={(event) => {if (resizing.current) resizeSidebar(resizing.current.width + event.clientX - resizing.current.x);}} onPointerUp={() => {resizing.current = null;}} onPointerCancel={() => {resizing.current = null;}} onDoubleClick={() => resizeSidebar(260)} onKeyDown={(event) => {const next = {ArrowLeft: sidebarWidth - 10, ArrowRight: sidebarWidth + 10, Home: 220, End: 380}[event.key]; if (next !== undefined) {event.preventDefault(); resizeSidebar(next);}}}><span aria-hidden="true">⋮</span></div>}</div>
        <section ref={detailPane} className="docker-detail" aria-label="资源详情">
          {selection || navigation.canBack ? <nav className="docker-navigation" data-docker-navigation aria-label="资源位置"><Button size="sm" disabled={!navigation.canBack || operationBusy || Boolean(confirm)} onClick={goBack}>← 返回上一步</Button><Button size="sm" disabled={!selection || operationBusy || Boolean(confirm)} onClick={event => {setSidebarCollapsed(false);select(null,event.currentTarget);}}>资源列表</Button>{current?.project ? <><span aria-hidden="true">/</span><Button size="sm" disabled={operationBusy || Boolean(confirm)} onClick={event => select({kind:'project',project:current.project},event.currentTarget)}>项目 {current.project}</Button></> : null}</nav> : null}
          {selection ? <><div className="docker-detail-heading"><div><span className="docker-eyebrow">{current ? (current.project ? current.project + ' / ' + current.service : '独立容器') : selection.kind === 'project' ? '项目' : '本地镜像'}</span><h2 data-docker-detail-title tabIndex={-1}>{title}</h2><p>{current?.image || ''}</p></div><span className={'docker-badge' + (selection.kind === 'image' && imageDetail && !imageDetail.containers.length ? ' is-unused' : '')}>{state}</span></div>
          {selectionHidden ? <p className="docker-selection-note">当前容器不在左侧筛选结果中，详情保持原对象。可返回上一步继续浏览。</p> : selection.kind === 'container' && !current ? <p className="docker-selection-note" role="status">容器已不在当前列表中，请刷新或重新选择资源。</p> : null}
          {selection.kind === 'project' ? <div className="docker-actions"><Button size="sm" variant="danger" disabled={actionsDisabled || !projectRows.some((row) => ['running', 'restarting', 'paused'].includes(row.state))} onClick={() => prepareAction('project_stop')}>停止整个项目</Button></div> : selection.kind === 'image' ? <div className="docker-actions"><Button size="sm" variant="danger" disabled={actionsDisabled || !imageDetailReady || Boolean(imageDetail?.containers.length)} title={imageDeleteReason || (!imageDetailReady ? '正在核对镜像引用关系' : undefined)} aria-describedby={imageDeleteReason ? 'docker-image-delete-reason' : undefined} onClick={() => prepareAction('image_remove')}>{imageDeleteLabel(selection.reference)}</Button>{imageDeleteReason ? <p id="docker-image-delete-reason" className="docker-image-delete-reason">{imageDeleteReason}</p> : null}</div> : null}
          {selection.kind === 'container' ? <Tabs value={tab} onValueChange={(value) => setTab(value as DetailTab)}>
            <Tabs.List aria-label="容器详情">
              <Tabs.Trigger value="overview">概览</Tabs.Trigger>
              <Tabs.Trigger value="logs">运行日志</Tabs.Trigger>
              <Tabs.Trigger value="terminal">终端</Tabs.Trigger>
            </Tabs.List>
            <Tabs.Panel value="overview">{containerActions}{overviewContent}</Tabs.Panel>
            <Tabs.Panel value="logs"><ContainerLogs key={JSON.stringify([data.context,selection.id])} api={activeApi} context={data.context} id={selection.id} available={Boolean(current)} busy={operationBusy} cached={logSessions.current.read(data.context,selection.id)} onRemember={rememberLogs} onNotice={setNotice}/></Tabs.Panel>
            <Tabs.Panel value="terminal"><ContainerTerminal key={current?.id + data.context} api={activeApi} context={data.context} containerId={current?.id || ''} containerState={current?.state || ''} readOnly={readOnly} blocked={Boolean(error) || loading}/></Tabs.Panel>
          </Tabs> : overviewContent}</> : <EmptyState icon="◇" title="选择项目、容器或镜像" description="点击名称查看详情，箭头控制项目展开。"/>}</section></section></>}
    <DialogShell contentClassName="docker-confirm-content" open={Boolean(confirm)} onOpenChange={(open) => {if (!open && !operationBusy) {setConfirm(null); setConfirmError('');}}} onCancel={(event) => {if (operationBusy) event.preventDefault();}} title={confirm?.title || ''} description="请核对下面的 context、对象和影响范围后确认。" footer={<><Button disabled={operationBusy} onClick={() => setConfirm(null)}>取消</Button><Button variant="danger" disabled={operationBusy} onClick={() => void confirmAction()}>{operationBusy ? '执行中…' : confirm?.prune ? `确认清理 ${confirm.prune.targets.length} 个镜像` : '确认操作'}</Button></>}>{confirm ? <>{confirmError ? <p className="docker-error" role="alert">{confirmError}</p> : null}{confirm.prune ? <><ImagePrunePreview plan={confirm.prune}/>{confirmError ? <Button size="sm" disabled={operationBusy} onClick={() => {setConfirm(null); void prepareImagePrune();}}>重新预览</Button> : null}</> : <p className="docker-confirm-text">{confirm.description}</p>}</> : null}</DialogShell>
  </main>;
}
