import {useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent} from 'react';
import {
  Button, Checkbox, DialogShell, EmptyState, Field, FormSection, HelpPopover, Input,
  Select, Tabs,
} from '@flowhub/plugin-common/react';
import type {
  Container, ContainerDetail, HostContext, ImageDetail, ImageSummary, ListResult,
  ImagePrunePlan, ImagePruneResult, ManagementApi, Scope, Selection, StopPlan, StopResult,VolumeSummary,VolumeDetail,NetworkSummary,
} from './api';
import {createPreviewApi} from './api';
import {ContainerTerminal} from './ContainerTerminal';
import {ContainerLogs} from './ContainerLogs';
import {ResourceTable} from './ResourceTable';
import {ResourceDetails} from './ResourceDetails';
import {ResourceCreate} from './ResourceCreate';
import {ResourceIcon} from './ResourceIcon';
import {ImagePull} from './ImagePull';
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
  {value:'volumes',label:'卷'}, {value:'networks',label:'网络'},
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
  ['all', '容器'], ['compose', 'Compose 项目'], ['standalone', '独立容器'],
  ['images', '镜像'], ['volumes','卷'],['networks','网络'],['settings', '通用设置'],
] as const;

function ScopeNav({scope, counts, onChange, disabled}: {scope: Scope; counts: ScopeCounts; onChange(value: Scope): void; disabled: boolean}) {
  return <nav className="docker-scope-nav" aria-label="资源类型">
    {scopeTabs.map(([value, label]) => <button key={value} type="button" className={scope === value ? 'is-active' : ''} aria-current={scope===value?'page':undefined} aria-pressed={scope === value} disabled={disabled} onClick={() => onChange(value)}><span className="docker-nav-icon"><ResourceIcon kind={value}/></span><span>{label}</span>{value !== 'settings' ? <span className="docker-scope-nav__count">{counts[value] ?? '—'}</span> : null}</button>)}
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
  const [volumes,setVolumes]=useState<VolumeSummary[]|null>(null),[networks,setNetworks]=useState<NetworkSummary[]|null>(null);
  const [resourceDetail,setResourceDetail]=useState<VolumeDetail|NetworkSummary|null>(null),[creating,setCreating]=useState<'volume'|'network'|null>(null),[confirmName,setConfirmName]=useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [detail, setDetail] = useState<ContainerDetail | null>(null);
  const [imageDetail, setImageDetail] = useState<ImageDetail | null>(null);
  const [tab, setTab] = useState<DetailTab>('overview');
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [groupOrders, setGroupOrders] = useState<Record<string, string[]>>(loadGroupOrders);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailReload, setDetailReload] = useState(0);
  const [operationBusy, setOperationBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<{method: string; params: Record<string, unknown>; title: string; description: string; prune?: ImagePrunePlan;requireName?:string} | null>(null);
  const [confirmError, setConfirmError] = useState('');
  const appliedInitial = useRef(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const refreshQueued=useRef(false),[listReload,setListReload]=useState(0);
  const operationBusyRef = useRef(false);
  const imagesContextRef = useRef('');
  const sidebar=useRef<HTMLElement>(null),detailPane=useRef<HTMLElement>(null),logSessions=useRef(new LogSessions());
  const rememberLogs=useCallback((context:string,id:string,state:LogState)=>logSessions.current.remember(context,id,state),[]);
  const applyView=useCallback((view:BrowseView)=>{generation.current++;setScope(view.scope);setSelection(view.selection);setQuery(view.query);setTab(view.tab);setDetailError('');setDetailLoading(Boolean(view.selection && ['container','image','volume','network'].includes(view.selection.kind)));},[]);
  const navigation=useResourceNavigation({context:data.context,view:{scope,selection,query,tab},apply:applyView,disabled:operationBusy || Boolean(confirm) || Boolean(creating),ready:!detailLoading,list:sidebar,detail:detailPane});
  const current = useMemo(() => selectedContainer(selection, data.containers), [data.containers, selection]);
  const projectRows = useMemo(() => selectedProject(selection, data.containers), [data.containers, selection]);
  const isWidget = Boolean(window.FlowHubWidget && window.parent !== window);
  const previewApi = useMemo(createPreviewApi, []);
  const activeApi = context.preview ? previewApi : api;
  const readOnly = activeApi.preview || Boolean(context.preview);

  const refresh = useCallback(async (afterOperation = false) => {
    if(inFlight.current){refreshQueued.current=true;return;}
    if ((operationBusyRef.current && !afterOperation) || scope === 'settings') return;
    inFlight.current = true; setLoading(true); setError('');
    try {
      const next = await activeApi.invoke<ListResult>('list');
      logSessions.current.activate(next.context);
      if (data.context && data.context !== next.context) {setSelection(null);setConfirm(null);setConfirmError('');setCreating(null);setConfirmName('');setVolumes(null);setNetworks(null);setResourceDetail(null); setNotice('Docker 环境已变化，已清除原环境中的选择和待确认操作。'); generation.current += 1;}
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
      if(scope==='volumes'){const result=await activeApi.invoke<{volumes:VolumeSummary[]}>('volumes',{context:next.context});setVolumes(result.volumes);}
      if(scope==='networks'){const result=await activeApi.invoke<{networks:NetworkSummary[]}>('networks',{context:next.context});setNetworks(result.networks);}
    } catch (reason) {setError(noticeText(reason) + '\n请检查 Docker 引擎后刷新。');}
    finally {inFlight.current = false; setLoading(false);if(refreshQueued.current){refreshQueued.current=false;setListReload(value=>value+1);}}
  }, [activeApi, data.context, operationBusy, scope]);

  useEffect(() => {void refresh(); const timer = window.setInterval(() => {if (!document.hidden) void refresh();}, settings.refreshSeconds * 1000); return () => window.clearInterval(timer);}, [refresh, settings.refreshSeconds,listReload]);
  useEffect(() => {try {localStorage.setItem(groupOrderKey, JSON.stringify(groupOrders));} catch { /* sorting remains available for this session */ }}, [groupOrders]);
  useEffect(() => {
    if (appliedInitial.current || !data.context) return;
    const initial = context.config?.selection || (context.config?.project && context.config.project !== '*' ? {kind: 'project' as const, project: context.config.project} : null);
    if (initial && (!('context' in initial) || !initial.context || initial.context === data.context)) {
      setSelection(initial.kind==='images'?null:initial); if (initial.kind === 'image' || initial.kind === 'images') setScope('images');else if(initial.kind==='volume')setScope('volumes');else if(initial.kind==='network')setScope('networks');
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
    const revision = ++generation.current; setDetailLoading(true); setDetail(null); setImageDetail(null);setResourceDetail(null);
    const method = selection.kind === 'image' ? 'image_detail' : selection.kind==='volume'?'volume_detail':selection.kind==='network'?'network_detail':'detail';
    const params = selection.kind==='volume'?{name:selection.name,context:data.context}:{id:selection.id,context:data.context};
    void activeApi.invoke<ContainerDetail & ImageDetail & VolumeDetail & NetworkSummary>(method, params).then((result) => {
      if (revision !== generation.current) return;
      if (selection.kind === 'image') setImageDetail(result as ImageDetail); else if(selection.kind==='volume'||selection.kind==='network')setResourceDetail(result);else setDetail(result as ContainerDetail);
    }).catch((reason) => {if (revision === generation.current) setDetailError(noticeText(reason));}).finally(() => {if (revision === generation.current) setDetailLoading(false);});
    return () => {if (revision === generation.current) generation.current += 1;};
  }, [activeApi, data.context, selection, detailReload]);
  function select(next: Selection|null,origin?:HTMLElement) {navigation.select(next,origin);}
  function goBack() {navigation.back();}
  const setResourceBusy=useCallback((busy:boolean)=>{operationBusyRef.current=busy;setOperationBusy(busy);},[]);
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
    if(action==='resource_remove' && (selection.kind==='volume'||selection.kind==='network') && resourceDetail && !detailLoading && !detailError && resourceDetail.removable && !resourceDetail.containers.length){
      const volume=selection.kind==='volume'?resourceDetail as VolumeDetail:null;
      const revision=generation.current;operationBusyRef.current=true;setOperationBusy(true);setConfirmError('');setConfirmName('');
      void activeApi.invoke<VolumeDetail|NetworkSummary>(selection.kind+'_detail',volume?{name:volume.name,context:data.context}:{id:(resourceDetail as NetworkSummary).id,context:data.context}).then(fresh=>{
        if(revision!==generation.current)return;setResourceDetail(fresh);if(fresh.containers.length || !fresh.removable){setNotice('引用关系或删除条件已变化，请核对最新详情。');return;}
        setConfirm({method:selection.kind+'_remove',params:volume?{name:fresh.name,identity:(fresh as VolumeDetail).identity,context:data.context}:{id:(fresh as NetworkSummary).id,name:fresh.name,context:data.context},requireName:fresh.name,title:'删除'+(volume?'卷':'网络')+'？',description:data.context+' · '+fresh.name+'\n'+(volume?'卷内全部数据将永久丢失，无法恢复。确认没有需要保留的数据后，再完整输入卷名。':'此操作将移除网络。确认没有容器引用后，完整输入网络名称。')});
      }).catch(reason=>setNotice('无法重新核对资源：'+noticeText(reason))).finally(()=>{operationBusyRef.current=false;setOperationBusy(false);});return;
    }
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
    if (readOnly || !confirm || operationBusyRef.current || loading || error || confirm.requireName && confirmName!==confirm.requireName) return;
    operationBusyRef.current = true; setOperationBusy(true); setConfirmError(''); setNotice('正在执行，请稍候…');
    try {
      const result = await activeApi.invoke<StopResult & ImagePruneResult>(confirm.method, {...confirm.params, confirmed: true,...(confirm.requireName?{typedName:confirmName}:{})});
      const message = confirm.prune ? `已清理 ${result.removed} 个镜像，Docker 报告释放 ${result.reclaimed ?? '空间未知'}。${result.remaining ? `仍有 ${result.remaining} 个镜像被保留，请刷新核对引用关系。` : ''}` : result.results ? result.results.map((row) => row.name + '：' + (row.stopped ? '已停止' : row.error || '未确认停止')).join('\n') : '操作完成';
      if (confirm.prune || ['image_remove', 'container_remove','volume_remove','network_remove'].includes(confirm.method)) {generation.current += 1; setSelection(null);}
      setConfirm(null); setNotice(message); await refresh(true);
    } catch (reason) {setNotice(''); setConfirmError(noticeText(reason));}
    finally {operationBusyRef.current = false; setOperationBusy(false);}
  }
  const actions = selection?.kind === 'container' ? actionAvailability(current) : null;
  const listTitle = ({all:'容器',compose:'Compose 项目',standalone:'独立容器',images:'镜像',volumes:'卷',networks:'网络',settings:'通用设置'})[scope];
  const selectedImage = selection?.kind === 'image' ? images?.find(image => image.ID === selection.id && imageReference(image) === selection.reference) : undefined;
  const title = current?.name || (selection?.kind==='volume'?selection.name:selection?.kind==='network'?networks?.find(row=>row.id===selection.id)?.name || resourceDetail?.name || '网络详情':selection?.kind === 'container' ? '容器已不可用' : selection?.kind === 'project' ? selection.project : selection?.kind === 'image' ? selectedImage ? imageLabel(selectedImage) : selection.reference : '选择资源');
  const state = current ? statusLabels[current.state] || current.state : selection?.kind === 'project' ? projectRows.filter((row) => row.state === 'running').length + ' / ' + projectRows.length + ' 运行' : selection?.kind === 'image' && imageDetail ? (imageDetail.containers.length ? '被容器引用' : '未被容器引用') : (selection?.kind==='volume'||selection?.kind==='network') && resourceDetail ? resourceDetail.containers.length+' 个容器引用':'';
  const actionsDisabled=readOnly || operationBusy || loading || Boolean(error);
  const resourcesPending=scope==='images'?images===null:scope==='volumes'?volumes===null:scope==='networks'?networks===null:!data.context;
  const selectionHidden=Boolean(current && (['images','volumes','networks'].includes(scope) || !filterContainers(data.containers,scope==='settings'?'all':scope,query,settings.onlyIssues).some(row=>row.id===current.id)));
  const containerActions = actions ? <div className="docker-actions docker-actions--overview"><Button size="sm" disabled={!actions.start || actionsDisabled} onClick={() => prepareAction('start')}>启动</Button><Button size="sm" disabled={!actions.stop || actionsDisabled} onClick={() => prepareAction('stop')}>停止</Button><Button size="sm" disabled={!actions.restart || actionsDisabled} onClick={() => prepareAction('restart')}>重启</Button><Button size="sm" variant="danger" disabled={!actions.remove || actionsDisabled} onClick={() => prepareAction('container_remove')}>删除容器</Button></div> : null;
  const imageDetailReady = Boolean(selectedImage) && selection?.kind === 'image' && imageDetail?.id === selection.id;
  const imageDeleteReason = detailError ? '详情读取失败，请重试后核对删除条件。' : imageDetailReady && imageDetail.containers.length ? `被 ${imageDetail.containers.length} 个容器引用（包括已停止容器），请先处理下方关联容器。` : '';
  const overviewContent = detailLoading ? <p className="docker-loading" role="status">正在读取详情…</p> : detailError ? <div className="docker-detail-error" role="alert"><p className="docker-error">详情读取失败：{detailError}</p><Button size="sm" onClick={() => setDetailReload(value => value + 1)}>重试读取详情</Button></div> : selection && (selection.kind==='volume'||selection.kind==='network') && resourceDetail?<ResourceDetails kind={selection.kind} info={resourceDetail} disabled={actionsDisabled} onSelect={select} onRemove={()=>prepareAction('resource_remove')}/>:selection ? <DetailOverview selection={selection} container={current} detail={detail} imageDetail={imageDetail} imageSize={selectedImage?.Size} projectRows={projectRows} onSelect={select}/> : null;
  const counts: ScopeCounts = {
    all: data.containers.length,
    compose: new Set(data.containers.map((row) => row.project).filter(Boolean)).size,
    standalone: data.containers.filter((row) => !row.project).length,
    images: images?.length ?? null,
    volumes:volumes?.length ?? null,networks:networks?.length ?? null,
  };

  return <main className="docker-page docker-shell">
    <aside className="docker-navigation-sidebar"><div className="docker-brand"><ResourceIcon kind="all"/> Docker</div><div className="docker-environment"><span className="docker-live-dot" aria-hidden="true"/><span>{data.context || '正在连接'}</span><HelpPopover label="管理页说明">当前环境：{data.context || '正在连接'}。连接当前本机 Docker 环境，管理项目、容器、镜像、卷和网络。列表每 {settings.refreshSeconds} 秒刷新；删除需核对对象并确认。</HelpPopover></div>
      <ScopeNav scope={scope} counts={counts} onChange={changeScope} disabled={operationBusy || Boolean(confirm) || Boolean(creating)}/>
      <div className="docker-nav-footer"><Button size="sm" variant="ghost" hidden={isWidget} disabled={readOnly} onClick={()=>void activeApi.invoke('flowhub_status').catch(reason=>setError(noticeText(reason)))}>桌面悬浮窗</Button><Button size="sm" variant="ghost" hidden={Boolean(window.FlowHubTheme?.hosted)} onClick={()=>window.FlowHubTheme?.set(document.documentElement.dataset.theme==='dark'?'light':'dark')}>切换外观</Button></div>
    </aside>
    <div className="docker-main">
      <header className="docker-header"><div><h1>{listTitle}</h1><p className="docker-muted">{scope==='volumes'?'持久数据与容器引用':scope==='networks'?'网络配置与容器连接':scope==='images'?'本地镜像与引用关系':scope==='compose'?'按项目组织和管理服务':scope==='settings'?'刷新、默认范围和外观':'查看状态、日志与运行操作'}</p></div><div className="docker-header-actions">
        {!selection && (scope==='volumes'||scope==='networks')?<Button variant="primary" disabled={actionsDisabled || !data.context} onClick={()=>setCreating(scope==='volumes'?'volume':'network')}>＋ 新建{scope==='volumes'?'卷':'网络'}</Button>:null}
        {!selection && scope==='images'?<Button disabled={actionsDisabled || !data.context} onClick={()=>void prepareImagePrune()}>清理未使用镜像</Button>:null}
        <ImagePull api={activeApi} context={data.context} visible={!selection && scope==='images'} disabled={actionsDisabled || !data.context} onComplete={async()=>{await refresh();}}/>
        <Button size="sm" onClick={()=>{setNotice('');setDetailReload(value=>value+1);void refresh();}} disabled={loading || operationBusy}>{loading?'刷新中…':'↻ 刷新'}</Button>
      </div></header>
      {readOnly?<p className="docker-preview" role="status">只读模拟预览 · 不连接 Docker，不执行操作</p>:null}
      {error?<div className="docker-alert" role="alert">{error}</div>:null}
      {notice?<div className="docker-notice" role="status">{notice}</div>:null}
      {scope==='settings'?<SettingsPanel settings={settings} theme={theme} context={data.context} onSave={saveSettings} onReset={resetSettings}/>:null}
      <section className="docker-workspace" hidden={scope==='settings'}>
        <section ref={sidebar} className="docker-sidebar docker-browser" hidden={Boolean(selection)}>
          <div className="docker-browser-toolbar"><Input type="search" aria-label="搜索资源" placeholder={scope==='volumes'?'搜索卷名称或驱动':scope==='networks'?'搜索网络名称或驱动':'搜索名称、镜像或项目'} value={query} onChange={event=>setQuery(event.target.value)}/>{scope==='all'||scope==='standalone'||scope==='compose'?<span className="docker-muted">{data.containers.filter(row=>row.state==='running').length} 个运行中</span>:null}</div>
          {resourcesPending?<EmptyState size="compact" title={loading?'正在读取资源…':'资源暂不可用'} description={error?'请检查连接后刷新重试':'等待当前环境返回资源信息'}/>:scope==='compose'?<ResourceList containers={data.containers} images={[]} scope="compose" query={query} onlyIssues={settings.onlyIssues} selected={selection} collapsed={collapsed} groupOrder={Array.isArray(groupOrders[data.context])?groupOrders[data.context]:[]} onToggleProject={project=>setCollapsed(previous=>{const next=new Set(previous);if(next.has(project))next.delete(project);else next.add(project);return next;})} onReorderProject={reorderProject} onSelect={select}/>:<ResourceTable scope={scope} containers={data.containers} images={images??[]} volumes={volumes??[]} networks={networks??[]} query={query} onlyIssues={settings.onlyIssues} onSelect={select}/>}
        </section>
        <section ref={detailPane} className="docker-detail" aria-label="资源详情" hidden={!selection}>
          <nav className="docker-navigation" data-docker-navigation aria-label="资源位置"><Button size="sm" variant="ghost" disabled={!navigation.canBack || operationBusy || Boolean(confirm)} onClick={goBack}>← 返回上一步</Button><Button size="sm" variant="ghost" disabled={!selection || operationBusy || Boolean(confirm)} onClick={event=>select(null,event.currentTarget)}>资源列表</Button>{current?.project?<><span aria-hidden="true">/</span><Button size="sm" variant="ghost" disabled={operationBusy || Boolean(confirm)} onClick={event=>select({kind:'project',project:current.project},event.currentTarget)}>项目 {current.project}</Button></>:null}</nav>
          {selection?<><div className="docker-detail-heading"><div><h2 data-docker-detail-title tabIndex={-1}>{title}</h2>{current?<p>{current.image}</p>:null}</div><span className="docker-badge">{state}</span></div>
            {selectionHidden?<p className="docker-selection-note">当前容器不在原筛选结果中，详情保持原对象。可返回上一步继续浏览。</p>:selection.kind==='container'&&!current?<p className="docker-selection-note" role="status">容器已不在当前列表中，请刷新或重新选择资源。</p>:null}
            {selection.kind==='project'?<div className="docker-actions"><Button size="sm" variant="danger" disabled={actionsDisabled || !projectRows.some(row=>['running','restarting','paused'].includes(row.state))} onClick={()=>prepareAction('project_stop')}>停止整个项目</Button></div>:selection.kind==='image'?<div className="docker-actions"><Button size="sm" variant="danger" disabled={actionsDisabled || !imageDetailReady || Boolean(imageDetail?.containers.length)} onClick={()=>prepareAction('image_remove')}>{imageDeleteLabel(selection.reference)}</Button>{imageDeleteReason?<p className="docker-image-delete-reason">{imageDeleteReason}</p>:null}</div>:null}
            {selection.kind==='container'?<Tabs value={tab} onValueChange={value=>setTab(value as DetailTab)}><Tabs.List aria-label="容器详情"><Tabs.Trigger value="overview">概览</Tabs.Trigger><Tabs.Trigger value="logs">运行日志</Tabs.Trigger><Tabs.Trigger value="terminal">终端</Tabs.Trigger></Tabs.List>
              <Tabs.Panel value="overview">{containerActions}{overviewContent}</Tabs.Panel>
              <Tabs.Panel value="logs"><ContainerLogs key={JSON.stringify([data.context,selection.id])} api={activeApi} context={data.context} id={selection.id} available={Boolean(current)} busy={operationBusy} cached={logSessions.current.read(data.context,selection.id)} onRemember={rememberLogs} onNotice={setNotice}/></Tabs.Panel>
              <Tabs.Panel value="terminal"><ContainerTerminal key={current?.id+data.context} api={activeApi} context={data.context} containerId={current?.id || ''} containerState={current?.state || ''} readOnly={readOnly} blocked={Boolean(error)||loading}/></Tabs.Panel>
            </Tabs>:overviewContent}</>:null}
        </section>
      </section>
    </div>
    {creating?<ResourceCreate key={data.context+creating} kind={creating} context={data.context} api={activeApi} readOnly={readOnly} onClose={()=>setCreating(null)} onBusy={setResourceBusy} onSaved={async()=>{setQuery('');setNotice('资源已创建');await refresh(true);}}/>:null}
    <DialogShell className="docker-confirm-dialog" contentClassName="docker-confirm-content" open={Boolean(confirm)} onOpenChange={open=>{if(!open&&!operationBusy){setConfirm(null);setConfirmError('');}}} onCancel={event=>{if(operationBusy)event.preventDefault();}} title={confirm?.title || ''} description="请核对 Docker 环境、对象和影响范围后确认。" footer={<><Button disabled={operationBusy} onClick={()=>setConfirm(null)}>取消</Button><Button variant="danger" disabled={operationBusy || loading || Boolean(error) || Boolean(confirm?.requireName && confirmName!==confirm.requireName)} onClick={()=>void confirmAction()}>{operationBusy?'执行中…':confirm?.prune?'确认清理 '+confirm.prune.targets.length+' 个镜像':confirm?.method==='volume_remove'?'永久删除卷':'确认操作'}</Button></>}>
      {confirm?<>{confirmError?<p className="docker-error" role="alert">{confirmError}</p>:null}{error?<p className="docker-error" role="alert">资源列表读取失败，请取消并成功刷新后重新确认。</p>:null}{confirm.prune?<><ImagePrunePreview plan={confirm.prune}/>{confirmError?<Button size="sm" disabled={operationBusy} onClick={()=>{setConfirm(null);void prepareImagePrune();}}>重新预览</Button>:null}</>:<p className="docker-confirm-text">{confirm.description}</p>}{confirm.requireName?<Field label="输入完整名称确认删除" htmlFor="docker-confirm-name"><Input id="docker-confirm-name" autoComplete="off" value={confirmName} disabled={operationBusy} onChange={event=>setConfirmName(event.target.value)}/></Field>:null}</>:null}
    </DialogShell>
  </main>;
}
