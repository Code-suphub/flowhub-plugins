import {useDeferredValue,useEffect,useMemo,useRef,useState} from 'react';
import {Alert,ConfigProvider,Descriptions,Modal,Select,Switch,Table,Tabs,Tag,theme} from 'antd';
import type {TableColumnsType} from 'antd';
import {StyleProvider} from '@ant-design/cssinjs';
import {createCommonAntdTheme} from '@local/common-components/react/antd';
import {Button,HelpPopover,Input} from '@flowhub/plugin-common/react';
import {bytes,contextRows,cpu,filterGroups,matchesProcess,processKey,updateDetail} from './model';
import type {ContextRow} from './model';
import type {Api,Context,Group,PageContexts,Plan,Process,Snapshot,Sort,TerminateResult} from './types';

export function Theme({children}:{children:React.ReactNode}) {
  const [dark,setDark]=useState(document.documentElement.dataset.theme!=='light');
  useEffect(()=>{const update=()=>setDark(document.documentElement.dataset.theme!=='light');window.addEventListener('flowhub-theme-change',update);return()=>window.removeEventListener('flowhub-theme-change',update);},[]);
  const color=(name:string)=>getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const shared=createCommonAntdTheme({token:{colorPrimary:color('--fh-accent'),colorText:color('--fh-text'),colorTextSecondary:color('--fh-muted'),colorBorder:color('--fh-border'),colorBgContainer:color('--fh-surface'),colorBgLayout:color('--fh-canvas'),colorError:color('--fh-danger'),colorSuccess:color('--fh-positive'),colorWarning:color('--fh-warning'),fontFamily:'-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',controlHeight:28}});
  return <StyleProvider layer><ConfigProvider componentSize="small" theme={{...shared,token:{...shared.token,fontSize:12},algorithm:dark?theme.darkAlgorithm:theme.defaultAlgorithm,components:{Table:{fontSize:12,cellPaddingBlockSM:7,cellPaddingInlineSM:10,headerBg:color('--fh-surface-soft')},Modal:{titleFontSize:14,contentBg:color('--fh-surface'),headerBg:color('--fh-surface')}}}}>{children}</ConfigProvider></StyleProvider>;
}

const sortOptions=[{value:'footprint' as const,label:'按内存足迹'},{value:'memory' as const,label:'按 RSS'},{value:'cpu' as const,label:'按 CPU'}];
const searchStyle={width:'min(330px,100%)',minHeight:30};
const identity=(p:Process)=>({pid:p.pid,started:p.started,executable:p.executable,uid:p.uid});

export function App({api,context}:{api:Api;context:Context}) {
  const [data,setData]=useState<Snapshot>();
  const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const [query,setQuery]=useState('');const deferredQuery=useDeferredValue(query);
  const [sort,setSort]=useState<Sort>('footprint');const [system,setSystem]=useState(false);
  const [detail,setDetail]=useState<Group>();const [processQuery,setProcessQuery]=useState('');
  const [source,setSource]=useState<Process>();const [tab,setTab]=useState('processes');
  const [contexts,setContexts]=useState<PageContexts>();const [contextError,setContextError]=useState('');
  const [contextQuery,setContextQuery]=useState('');const [linkedOnly,setLinkedOnly]=useState(false);
  const [contextDetail,setContextDetail]=useState<string>();const [unmappedOnly,setUnmappedOnly]=useState(false);
  const [linksBusy,setLinksBusy]=useState(false);const contextGeneration=useRef(0);
  const [plan,setPlan]=useState<Plan>();const [force,setForce]=useState(false);
  const [expires,setExpires]=useState(0);const [remaining,setRemaining]=useState(0);
  const [busy,setBusy]=useState(false);const [refreshing,setRefreshing]=useState(false);
  const alive=useRef(true);const operation=useRef(false);const reading=useRef(false);
  const openedSelection=useRef('');const selected=context.config?.selection?.groupId;

  function openDetail(group:Group){
    contextGeneration.current++;setLinksBusy(false);setDetail({...group,processes:[...group.processes]});
    setProcessQuery('');setContexts(undefined);setContextError('');setTab('processes');setSource(undefined);
    setContextQuery('');setLinkedOnly(false);setContextDetail(undefined);setUnmappedOnly(false);
  }
  function closeDetail(){contextGeneration.current++;setDetail(undefined);setSource(undefined);setContextDetail(undefined);setLinksBusy(false);}
  useEffect(()=>{if(selected&&selected!==openedSelection.current){const group=data?.groups.find(g=>g.id===selected);if(group){openedSelection.current=selected;openDetail(group);}}},[selected,data]);
  useEffect(()=>{if(data)setDetail(previous=>previous?updateDetail(previous,data.groups.find(g=>g.id===previous.id)):previous);},[data]);
  function accept(next:Snapshot){setData(previous=>!previous||next.at>=previous.at?next:previous);}
  async function refresh(manual=false){
    if(reading.current)return;reading.current=true;if(manual)setRefreshing(true);
    try{const next=await api.invoke<Snapshot>(manual?'refresh':'snapshot');if(alive.current){accept(next);setError(next.error??'');}}
    catch(e){if(alive.current)setError(String(e));}
    finally{reading.current=false;if(alive.current)setRefreshing(false);}
  }
  useEffect(()=>{
    alive.current=true;let timer:ReturnType<typeof setTimeout>|undefined;let running=false;
    async function tick(){if(running)return;running=true;clearTimeout(timer);try{if(!document.hidden)await refresh();}finally{running=false;if(alive.current)timer=setTimeout(tick,5000);}}
    const visible=()=>{if(!document.hidden){clearTimeout(timer);void tick();}};
    void tick();document.addEventListener('visibilitychange',visible);
    return()=>{alive.current=false;contextGeneration.current++;clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
  },[api]);
  useEffect(()=>{if(!plan)return;const update=()=>setRemaining(Math.max(0,Math.ceil((expires-Date.now())/1000)));update();const timer=setInterval(update,500);return()=>clearInterval(timer);},[plan,expires]);

  async function prepare(target:Group|Process){
    if(api.preview||operation.current||plan)return;
    operation.current=true;setBusy(true);setError('');setNotice('');
    try{
      const params='processes' in target?{groupId:target.id,force:false}:{identity:identity(target),force:false};
      const next=await api.invoke<Plan>('terminate_preview',params);
      if(alive.current){setPlan(next);setForce(false);setExpires(Date.now()+next.expiresIn*1000);}
    }catch(e){if(alive.current)setError(String(e));}
    finally{operation.current=false;if(alive.current)setBusy(false);}
  }
  async function execute(){
    if(!plan||remaining<=0||api.preview||operation.current)return;
    operation.current=true;setBusy(true);
    try{
      const result=await api.invoke<TerminateResult>('terminate_confirm',{token:plan.token,confirmed:true,force});
      if(!alive.current)return;accept(result.snapshot);setPlan(undefined);
      const exited=result.results.filter(r=>r.exited).length;
      const waiting=result.results.filter(r=>r.sent&&!r.exited).length;
      setNotice(`${exited} 个进程已退出${waiting?`，${waiting} 个已发送信号、等待退出`:''}。`);
      setError([...result.results.filter(r=>!r.sent).map(r=>`PID ${r.pid}：${r.error}`),result.refreshError].filter(Boolean).join('；'));
    }catch(e){if(alive.current){setError(String(e));setPlan(undefined);}}
    finally{operation.current=false;if(alive.current)setBusy(false);}
  }
  async function loadContexts(arcTasks=false){
    if(!detail||linksBusy)return;
    const generation=++contextGeneration.current;setLinksBusy(true);setContextError('');
    try{const next=await api.invoke<PageContexts>(arcTasks?'arc_tasks':'contexts',{groupId:detail.id,...(arcTasks?{open:true}:{})});if(alive.current&&generation===contextGeneration.current)setContexts(next);}
    catch(e){if(alive.current&&generation===contextGeneration.current)setContextError(String(e));}
    finally{if(alive.current&&generation===contextGeneration.current)setLinksBusy(false);}
  }
  async function openApp(group:Group,token?:string){
    if(api.preview||linksBusy||busy||plan)return;
    const generation=++contextGeneration.current;setLinksBusy(true);setContextError('');
    try{await api.invoke(token?'open_context':'focus_app',{groupId:group.id,...(token?{token}:{})});}
    catch(e){if(alive.current&&generation===contextGeneration.current)setContextError(String(e));}
    finally{if(alive.current&&generation===contextGeneration.current)setLinksBusy(false);}
  }

  const groups=useMemo(()=>filterGroups(data?.groups??[],deferredQuery,system,sort),[data,deferredQuery,system,sort]);
  const linkedRows=useMemo(()=>contexts?contextRows(contexts,data):[],[contexts,data]);
  const rowDetail=linkedRows.find(row=>row.id===contextDetail);
  const processLabels=useMemo(()=>{
    const labels=new Map<string,string[]>();
    for(const row of linkedRows)for(const p of row.liveProcesses){const key=processKey(p);labels.set(key,[...(labels.get(key)??[]),row.title]);}
    return labels;
  },[linkedRows]);
  const contextSearch=contextQuery.trim().toLocaleLowerCase();
  const visibleContexts=linkedRows.filter(row=>(!linkedOnly||row.processes.length>0)&&(!contextSearch||[row.title,row.detail,...row.processes.map(p=>String(p.pid))].some(text=>text.toLocaleLowerCase().includes(contextSearch))));
  const isArc=detail?.appPath?.endsWith('/Arc.app')??false;
  const maxMemory=Math.max(1,...groups.map(g=>g.footprint??0));
  const columns:TableColumnsType<Group>=[
    {title:'应用 / 工具',key:'name',render:(_,g)=><div className="app-identity"><span className="app-mark" aria-hidden="true">{g.name.slice(0,1).toUpperCase()}</span><div className="min-w-0"><button className="name-link" aria-label={`查看 ${g.name} 进程`} onClick={()=>openDetail(g)}>{g.name}</button><div className="muted text-xs mt-1">{g.processes.length} 个进程 · {g.source}</div></div></div>},
    {title:'内存足迹',key:'footprint',width:125,align:'right',render:(_,g)=><div className="memory-cell"><strong>{bytes(g.footprint)}</strong><div className="meter" aria-hidden="true"><i style={{width:`${(g.footprint??0)/maxMemory*100}%`}}/></div>{g.footprintIncomplete?<span className="muted text-xs">部分不可读取</span>:null}</div>},
    {title:'RSS',key:'rss',width:100,align:'right',render:(_,g)=><span className="numeric">{bytes(g.memory)}{g.incomplete?' *':''}</span>},
    {title:'CPU',key:'cpu',width:75,align:'right',render:(_,g)=><span className="numeric">{cpu(g.cpu)}</span>},
    {title:'操作',key:'actions',width:75,render:(_,g)=><Button size="sm" className="compact-button" disabled={api.preview||busy||!!plan||!g.canTerminate} onClick={()=>void prepare(g)}>结束</Button>}
  ];
  const processColumns:TableColumnsType<Process>=[
    {title:'进程 / 来源',key:'name',render:(_,p)=><div className={p.exited?'exited':''}><button className="name-link" onClick={()=>setSource(p)}>{p.name}</button><div className="muted text-xs mt-1">PID {p.pid} ← {p.ppid} · {p.parentName}{p.exited?' · 已退出':''}</div><div className="muted text-xs mt-1">{p.role} · {p.attribution}</div>{processLabels.has(processKey(p))?<div className="context-label text-xs mt-1">{(processLabels.get(processKey(p))?.length??0)>1?'共享：':'关联：'}{processLabels.get(processKey(p))?.join('、')}</div>:contexts?<div className="muted text-xs mt-1">未关联到页面或对话</div>:null}</div>},
    {title:'内存足迹',key:'footprint',width:110,align:'right',render:(_,p)=>bytes(p.footprint)},
    {title:'RSS',key:'memory',width:100,align:'right',render:(_,p)=>bytes(p.memory)},
    {title:'CPU',key:'cpu',width:75,align:'right',render:(_,p)=>p.exited?'—':cpu(p.cpu)},
    {title:'操作',key:'action',width:75,render:(_,p)=><Button size="sm" className="compact-button" disabled={api.preview||busy||!!plan||p.protected||p.exited} onClick={()=>void prepare(p)}>结束</Button>}
  ];
  const contextColumns:TableColumnsType<ContextRow>=[
    {title:contexts?.kind==='codex'?'对话 / 工作进程':'标签 / 任务',key:'title',render:(_,row)=><div><button className="name-link context-title" onClick={()=>setContextDetail(row.id)}>{row.title}</button><div className="muted text-xs mt-1 path context-path">{row.detail}</div><div className="muted text-xs mt-1">{row.processes.length?`${row.source} · PID ${row.processes.map(p=>p.pid).join('、')}`:'未发现可靠 PID 映射'}</div></div>},
    {title:contexts?.kind==='codex'?'子进程足迹':'进程足迹',key:'footprint',width:105,align:'right',render:(_,row)=><span className="numeric">{bytes(row.footprint)}{row.incomplete&&row.footprint!=null?' *':''}</span>},
    {title:'RSS',key:'rss',width:90,align:'right',render:(_,row)=><span className="numeric">{bytes(row.memory)}</span>},
    {title:'状态',key:'state',width:100,render:(_,row)=><Tag color={row.shared||row.ambiguous?'orange':row.liveProcesses.length?'blue':undefined}>{row.state}</Tag>},
    {title:'操作',key:'action',width:132,render:(_,row)=><div className="flex flex-wrap gap-1"><Button size="sm" className="compact-button" disabled={!row.processes.length} onClick={()=>setContextDetail(row.id)}>进程</Button><Button size="sm" className="compact-button" disabled={api.preview||row.expired||!row.token||linksBusy||busy||!!plan} onClick={()=>detail&&row.token&&void openApp(detail,row.token)}>打开 ↗</Button></div>}
  ];
  const visibleProcesses=detail?.processes.filter(p=>(!unmappedOnly||!processLabels.has(processKey(p)))&&matchesProcess(p,processQuery.trim().toLocaleLowerCase()))??[];
  const pressure=data?.system.pressure;
  const pressureLabel=pressure==='normal'?'正常':pressure==='warning'?'偏高':pressure==='critical'?'高':'未知';
  const stale=!!data?.at&&Date.now()-data.at>20000;
  return <main className="monitor p-3 md:p-4">
    <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
      <div className="flex items-center gap-2"><span className={`live-dot ${stale?'stale':''}`}/><span className="muted text-xs">{api.preview?'只读预览 · 模拟数据':data?.at?`本机 · ${new Date(data.at).toLocaleTimeString()} 更新`:'正在等待首次采样'}</span><HelpPopover label="统计口径与监控范围">内存足迹为系统 phys_footprint，包含脏页、压缩及换出等记账，更适合观察应用负担；RSS 是当前常驻内存。两者口径不同，不能相加，也不等于结束后释放的内存。CPU 按单核 100% 计。页面与对话可能共享进程。</HelpPopover></div>
      <div className="flex items-center gap-2"><Button size="sm" className="compact-button" disabled={refreshing} onClick={()=>void refresh(true)}>{refreshing?'刷新中…':'刷新'}</Button>{!api.widget?<Button size="sm" className="compact-button" disabled={api.preview} onClick={()=>void api.invoke('flowhub_status').catch(e=>setError(String(e)))}>桌面与菜单栏</Button>:null}</div>
    </div>
    <div className="system-strip grid grid-cols-3 gap-3 mb-3">
      <div><span className="muted">物理内存</span><strong>{bytes(data?.system.totalMemory)}</strong></div>
      <div><span className="muted">内存压力</span><strong className={pressure==='critical'?'danger':pressure==='warning'?'warning':''}>{pressureLabel}</strong></div>
      <div><span className="muted">已用交换空间</span><strong>{bytes(data?.system.swapUsed)}</strong></div>
    </div>
    {api.preview?<Alert type="info" showIcon title="只读模拟数据，结束与应用跳转已禁用。" className="mb-3"/>:null}
    {error?<Alert type="error" showIcon title={error} className="mb-3"/>:null}
    {notice?<Alert type="success" showIcon title={notice} className="mb-3"/>:null}
    {stale?<Alert type="warning" showIcon title="数据已过期，请刷新后再操作。" className="mb-3"/>:null}
    <div className="flex flex-wrap items-center gap-3 mb-3">
      <Input aria-label="搜索应用、进程、PID 或路径" placeholder="搜索应用、进程、PID 或路径" value={query} onChange={e=>setQuery(e.target.value)} className="search-input" style={searchStyle}/>
      <Select aria-label="排行方式" value={sort} onChange={setSort} options={sortOptions} style={{width:135}}/>
      <label className="flex items-center gap-2 muted text-xs"><Switch size="small" checked={system} onChange={setSystem}/>包含系统进程</label>
      <span className="muted text-xs ml-auto">{groups.length} 个应用与工具</span>
    </div>
    <Table<Group> size="small" rowKey="id" columns={columns} dataSource={groups} loading={!data&&!error} scroll={{x:650}} pagination={{pageSize:20,hideOnSinglePage:true,showSizeChanger:false,size:'small'}} locale={{emptyText:query?'没有匹配的应用或进程':'暂无应用数据'}}/>
    <p className="muted text-xs mt-3">每 5 秒采样 · 点击应用名查看进程 · 足迹与 RSS 不相加</p>

    <Modal title={detail?`${detail.name} · 进程详情`:''} open={!!detail} onCancel={closeDetail} footer={null} width={1000} className="detail-modal" styles={{body:{height:'min(620px,calc(100dvh - 160px))',overflow:'auto'}}}>
      {detail?<>
        <div className="flex flex-wrap items-center gap-3 mb-3"><span className="numeric">足迹 {bytes(detail.footprint)}{detail.footprintIncomplete?'（部分）':''} · RSS {bytes(detail.memory)} · CPU {cpu(detail.cpu)}</span><Button size="sm" className="compact-button ml-auto" disabled={api.preview||!detail.appPath||linksBusy||!!plan} onClick={()=>void openApp(detail)}>打开应用 ↗</Button></div>
        <Tabs activeKey={tab} onChange={setTab} items={[{key:'processes',label:'进程'},{key:'pages',label:'页面与对话'}]}/>
        {tab==='processes'?<>
          <div className="flex flex-wrap items-center gap-2 mb-3"><Input className="search-input" style={searchStyle} aria-label="搜索详情进程" placeholder="筛选进程名、PID、路径" value={processQuery} onChange={e=>setProcessQuery(e.target.value)}/><span className="muted text-xs">顺序固定，刷新只更新数值；新进程追加到末尾</span></div>
          {contexts?<label className="flex items-center gap-2 mb-3 text-xs"><Switch aria-label="只看未关联进程" checked={unmappedOnly} onChange={setUnmappedOnly}/>只看未关联进程</label>:null}
          <Table<Process> size="small" rowKey={p=>`${p.pid}:${p.started}`} dataSource={visibleProcesses} columns={processColumns} pagination={{pageSize:12,hideOnSinglePage:true,showSizeChanger:false,size:'small'}} scroll={{x:680}}/>
          <p className="muted text-xs mt-3">点击进程名查看来源。渲染进程可能承载多个页面，进程占用不能直接分摊到单个对话。</p>
        </>:<>
          <div className="flex flex-wrap items-center gap-2 mb-3"><Button size="sm" className="compact-button" disabled={linksBusy||!detail.appPath||!!plan} onClick={()=>void loadContexts()}>{linksBusy?'读取中…':contexts?'重新读取关联':isArc?'读取标签':'读取对话与子进程'}</Button>{isArc?<Button size="sm" className="compact-button" disabled={api.preview||linksBusy||!!plan} onClick={()=>void loadContexts(true)}>读取 Arc 任务管理器</Button>:null}<HelpPopover label="页面与对话统计范围">Arc 从原生任务管理器读取标题与 PID，需要 FlowHub 辅助功能权限；未匹配的隐私窗口、子框架和扩展不绑定到普通标签。Codex 只读近期对话索引，并按工作进程的 CODEX_THREAD_ID 关联；共享界面、GPU 和后台服务不计入对话子进程合计。映射五分钟失效，PID 身份变化不会沿用。</HelpPopover></div>
          {contexts?.diagnostics&&contexts.diagnostics.state!=='ready'?<Alert type="warning" showIcon title={contexts.diagnostics.hint} className="mb-3" action={contexts.diagnostics.state==='permission-required'?<Button size="sm" className="compact-button" disabled={api.preview} onClick={()=>void api.invoke('accessibility_settings').catch(e=>setContextError(String(e)))}>打开辅助功能设置</Button>:undefined}/>:null}
          {contexts?.diagnostics?.state==='ready'&&contexts.diagnostics.partial?<Alert type="info" showIcon title={`已读取 ${contexts.diagnostics.readTasks??0} 条当前可访问任务，受 Arc 筛选和滚动位置影响；需要时在任务管理器中滚动后重新读取。`} className="mb-3"/>:null}
          {contexts?<>
            <div className="flex flex-wrap items-center gap-2 mb-3"><Input className="search-input" style={searchStyle} aria-label="搜索页面与对话" placeholder="搜索标题、项目目录或 PID" value={contextQuery} onChange={e=>setContextQuery(e.target.value)}/><label className="flex items-center gap-2 text-xs"><Switch aria-label="只看已关联" checked={linkedOnly} onChange={setLinkedOnly}/>只看已关联</label></div>
            <div className="flex flex-wrap items-center gap-2 mb-3 muted text-xs"><span>{linkedRows.filter(row=>row.liveProcesses.length).length} 项已关联 · {detail.processes.filter(p=>!p.exited&&!processLabels.has(processKey(p))).length} 个应用进程未关联</span><span>映射采集于 {new Date(contexts.diagnostics?.at??contexts.at).toLocaleTimeString()}</span><Button size="sm" className="compact-button" onClick={()=>{setUnmappedOnly(true);setTab('processes');}}>查看未关联进程</Button></div>
            <Table<ContextRow> size="small" rowKey="id" columns={contextColumns} dataSource={visibleContexts} pagination={{pageSize:10,hideOnSinglePage:true,showSizeChanger:false,size:'small'}} scroll={{x:720}} locale={{emptyText:linkedOnly?'暂无已关联的工作进程':'暂无匹配的页面或对话'}}/>
            <p className="muted text-xs mt-3">{contexts.hint}</p>
            {contexts.diagnostics?.unreadable?<p className="warning text-xs mt-2">{contexts.diagnostics.unreadable} 个工作进程的标记不可读取，未强行分配给对话。</p>:null}
            {contexts.diagnostics?.unmatchedTasks?<p className="muted text-xs mt-2">{contexts.diagnostics.unmatchedTasks} 条子框架、扩展、未匹配或已变化的任务未绑定到普通标签。</p>:null}
          </>:<p className="muted text-xs">{isArc?'先读取标签，或读取任务管理器以关联标签进程。':'按需读取本机近期对话及其工作进程；共享服务占用单独保留。'}</p>}
        </>}
        {contextError?<Alert type="error" title={contextError} className="mt-3"/>:null}
        {error?<Alert type="error" title={error} className="mt-3"/>:null}
        {notice?<Alert type="success" title={notice} className="mt-3"/>:null}
      </>:null}
    </Modal>

    <Modal title={rowDetail?.title??'关联进程'} open={!!rowDetail} onCancel={()=>setContextDetail(undefined)} footer={null} width={950} className="detail-modal context-detail-modal" zIndex={1100} styles={{body:{height:'min(550px,calc(100dvh - 170px))',overflow:'auto'}}}>
      {rowDetail?<><div className="flex flex-wrap items-center gap-2 mb-3"><Tag>{rowDetail.source}</Tag><span className="numeric">足迹 {bytes(rowDetail.footprint)} · RSS {bytes(rowDetail.memory)} · CPU {cpu(rowDetail.cpu)}</span></div>{rowDetail.shared||rowDetail.ambiguous?<Alert type="warning" showIcon title={rowDetail.shared?'同一进程承载多个标签，结束可能影响它们；各标签显示的进程占用不能相加。':'存在同名标签，无法确定唯一跳转目标。此处只展示任务管理器报告的进程。'} className="mb-3"/>:null}<p className="muted text-xs mb-3">{contexts?.kind==='codex'?'仅统计携带此对话 ID 的工作进程，未包含共享界面、GPU 与服务。':'按任务管理器 PID 关联；没有把整个应用占用分摊给标签。'} 新进程需重新读取关联。</p><Table<Process> size="small" rowKey={processKey} dataSource={rowDetail.liveProcesses} columns={processColumns} scroll={{x:680}} pagination={{pageSize:8,hideOnSinglePage:true,showSizeChanger:false,size:'small'}} locale={{emptyText:rowDetail.expired?'映射已过期，请重新读取':'没有仍在运行的关联进程'}}/>{error?<Alert type="error" title={error} className="mt-3"/>:null}{notice?<Alert type="success" title={notice} className="mt-3"/>:null}</>:null}
    </Modal>

    <Modal title="进程来源" open={!!source} onCancel={()=>setSource(undefined)} footer={null} width={580} zIndex={1200} styles={{body:{maxHeight:'65dvh',overflow:'auto'}}}>
      {source?<><Descriptions column={1} size="small" items={[
        {key:'name',label:'进程',children:`${source.name} · PID ${source.pid}${source.exited?' · 已退出':''}`},
        {key:'role',label:'类型 / 归属',children:`${source.role} · ${source.attribution}`},
        {key:'path',label:'可执行文件',children:<span className="path">{source.executable||'不可读取'}</span>},
        {key:'cwd',label:'工作目录',children:<span className="path">{source.cwd||'不可读取'}</span>},
        {key:'parent',label:'当前父进程',children:`${source.parentName} · PID ${source.ppid}`},
        {key:'avd',label:'虚拟设备',children:source.avd||'—'},
        {key:'start',label:'启动时间',children:new Date(source.started/1000).toLocaleString()},
        {key:'usage',label:'本次占用',children:`足迹 ${bytes(source.footprint)} · RSS ${bytes(source.memory)} · CPU ${cpu(source.cpu)}`}
      ]}/><p className="muted text-xs mt-3 mb-3">{processLabels.get(processKey(source))?`已读取的关联：${processLabels.get(processKey(source))?.join('、')}`:'当前父进程与工作目录只是来源线索，尚未取得可靠的页面或对话映射。'}</p><div className="flex flex-wrap gap-2"><Button className="compact-button" disabled={!detail?.appPath} onClick={()=>{setSource(undefined);setContextDetail(undefined);setTab('pages');}}>页面与对话</Button>{detail?.appPath?<Button className="compact-button" disabled={api.preview||linksBusy||!!plan} onClick={()=>void openApp(detail)}>打开应用 ↗</Button>:null}<Button className="compact-button" disabled={api.preview||busy||!!plan||source.exited||source.protected} onClick={()=>void prepare(source)}>结束</Button></div>{source.protected?<p className="muted text-xs mt-3">{source.protection}</p>:null}</>:null}
    </Modal>

    <Modal title={force?'强制结束这些进程？':'结束这些进程？'} open={!!plan} onCancel={()=>{if(!busy)setPlan(undefined);}} onOk={()=>void execute()} okText={remaining>0?force?'确认强制结束':'确认结束':'确认已过期'} cancelText="取消" confirmLoading={busy} okButtonProps={{danger:true,disabled:api.preview||remaining<=0}} cancelButtonProps={{disabled:busy}} closable={!busy} mask={{closable:!busy}} keyboard={!busy} zIndex={1300}>
      <Alert type="warning" showIcon title={force?'立即终止进程，未保存内容和正在执行的任务可能丢失。':'发送退出信号，可能中断任务或影响同一进程内的多个页面。'} className="mb-3"/>
      <label className="flex items-center gap-2 mb-3"><Switch aria-label="强制结束" checked={force} onChange={setForce} disabled={busy}/>强制结束<span className="muted text-xs">无响应时使用；不删除文件</span></label>
      <p className="muted text-xs mb-3">{plan?.targets.length??0} 个进程 · 确认剩余 {remaining} 秒 · 执行前重新核对身份</p>
      <div className="confirm-targets">{plan?.targets.map(p=><div key={`${p.pid}:${p.started}`} className="confirm-target"><strong>{p.name}</strong><span className="muted text-xs">PID {p.pid} · 足迹 {bytes(p.footprint)} · RSS {bytes(p.memory)}</span><span className="path muted text-xs">{p.executable}</span></div>)}</div>
    </Modal>
  </main>;
}
