import {useDeferredValue,useEffect,useMemo,useRef,useState} from 'react';
import {Alert,ConfigProvider,Descriptions,Modal,Switch,Table,Tabs,Tag,theme} from 'antd';
import type {TableColumnsType,TableProps} from 'antd';
import {StyleProvider} from '@ant-design/cssinjs';
import {createCommonAntdTheme} from '@local/common-components/react/antd';
import {Button,HelpPopover,Input} from '@flowhub/plugin-common/react';
import {accountingDisplay,bytes,contextRows,cpu,defaultRankingOrder,detailControls,detailFrom,filterRanking,instanceStopReason,matchesProcess,newerSnapshot,rankingFrom,processKey,processName,updateDetail} from './model';
import {AppMark,applicationIdentity,useApplications} from './applications';
import {readGroupDetail} from './api';
import {ScriptDrawer} from './ScriptDrawer';
import {StartupSettings} from './StartupSettings';
import {FinderExtensions} from './FinderExtensions';
import {BackgroundServices,restartLabel,sameServiceProcess,useBackgroundServices} from './BackgroundServices';
import {ResourceHistory} from './ResourceHistory';
import {RequestDetails} from './RequestDetails';
import {displayError,errorText,RequestError} from './errors';
import type {DisplayError} from './errors';
import type {ContextRow} from './model';
import type {Api,ApplicationState,Context,Group,GroupDetail,GroupSummary,Instance,PageContexts,Plan,Process,QuitPlan,RankingSnapshot,RankingSort,Snapshot,TerminateResult,ViewPreferences} from './types';

export function Theme({children}:{children:React.ReactNode}) {
  const [dark,setDark]=useState(document.documentElement.dataset.theme!=='light');
  useEffect(()=>{const update=()=>setDark(document.documentElement.dataset.theme!=='light');window.addEventListener('flowhub-theme-change',update);return()=>window.removeEventListener('flowhub-theme-change',update);},[]);
  const color=(name:string)=>getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const shared=createCommonAntdTheme({token:{colorPrimary:color('--fh-accent'),colorText:color('--fh-text'),colorTextSecondary:color('--fh-muted'),colorBorder:color('--fh-border'),colorBgContainer:color('--fh-surface'),colorBgLayout:color('--fh-canvas'),colorError:color('--fh-danger'),colorSuccess:color('--fh-positive'),colorWarning:color('--fh-warning'),fontFamily:'-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',controlHeight:28}});
  return <StyleProvider layer><ConfigProvider componentSize="small" theme={{...shared,token:{...shared.token,fontSize:12},algorithm:dark?theme.darkAlgorithm:theme.defaultAlgorithm,components:{Table:{fontSize:12,cellPaddingBlockSM:7,cellPaddingInlineSM:10,headerBg:color('--fh-surface-soft')},Modal:{titleFontSize:14,contentBg:color('--fh-surface'),headerBg:color('--fh-surface')}}}}>{children}</ConfigProvider></StyleProvider>;
}

const searchStyle={width:'min(330px,100%)',minHeight:30};
const identity=(p:Process)=>({pid:p.pid,started:p.started,executable:p.executable,uid:p.uid});
const permissionLimited=(p:Process)=>p.protection.startsWith('当前用户权限不足');
function databaseStartupId(process:Process){
  if(process.exited||process.moved)return;
  const match=/^(?:\/opt\/homebrew|\/usr\/local)\/(opt|Cellar)\/([^/]+)\/(.+)$/.exec(process.executable);
  if(!match)return;
  const [,location,formula,path]=match;
  const executable=location==='Cellar'?path.replace(/^[0-9][a-z\d._-]*\//i,''):path;
  if((/^mysql(?:@8\.[04])?$/.test(formula)&&/^bin\/mysqld(?:_safe)?$/.test(executable))
    ||(/^postgresql(?:@[1-9]\d?)?$/.test(formula)&&executable==='bin/postgres')){
    return `homebrew.mxcl.${formula}`;
  }
}
type PrivilegedStatus={ok:boolean;status:string;message:string;rootControl?:boolean;serviceControl?:boolean;vivoStartupSupported?:boolean;vivoStartupControl?:boolean;checking?:boolean;warning?:string;stale?:boolean};
const settledPrivilege=(value:PrivilegedStatus,action:'enable'|'disable')=>!value.checking&&!value.stale&&!value.warning&&value.status===(action==='enable'?'enabled':'notRegistered');

export function App({api,context}:{api:Api;context:Context}) {
  const [data,setData]=useState<RankingSnapshot>();
  const dataRef=useRef<RankingSnapshot|undefined>(undefined);
  const [error,setError]=useState<DisplayError>('');const [notice,setNotice]=useState('');
  const [query,setQuery]=useState('');const deferredQuery=useDeferredValue(query);
  const sorting=data?.sorting??defaultRankingOrder;
  const [viewSaving,setViewSaving]=useState(false);
  const viewWriting=useRef(false);
  const system=data?.includeSystem??false;
  const [detail,setDetail]=useState<Group>();const [detailId,setDetailId]=useState<string>();const [processQuery,setProcessQuery]=useState('');
  const [contextProcesses,setContextProcesses]=useState<Process[]>([]);
  const detailRef=useRef<Group|undefined>(undefined);const detailSelection=useRef<{id:string;generation:number;sample?:Pick<GroupDetail,'at'|'revision'>;request:number;initialSearch:string}>({id:'',generation:0,request:0,initialSearch:''});
  const contextsRef=useRef<PageContexts|undefined>(undefined);
  const [source,setSource]=useState<Process>();const [tab,setTab]=useState('processes');
  const [selectedInstance,setSelectedInstance]=useState<string>();
  const [checkedInstances,setCheckedInstances]=useState<string[]>([]);
  const [scriptsOpen,setScriptsOpen]=useState(false);
  const scriptEventId=typeof context.config?.scriptEventId==='string'?context.config.scriptEventId:undefined;
  const openedScriptEvent=useRef('');
  useEffect(()=>{if(context.config?.sourceView==='scripts'&&scriptEventId&&openedScriptEvent.current!==scriptEventId){openedScriptEvent.current=scriptEventId;setScriptsOpen(true);}},[scriptEventId,context.config?.sourceView]);
  const [servicesScope,setServicesScope]=useState<{appPath?:string;ids?:string[];name?:string}>();const [servicesOpen,setServicesOpen]=useState(false);
  const [startupScope,setStartupScope]=useState<string>();
  const [finderScope,setFinderScope]=useState<{appPath?:string}>();
  const background=useBackgroundServices(api,!!detailId||servicesOpen);
  const serviceFor=(process:Process)=>background.data?.services.find(service=>!process.exited&&!process.moved&&sameServiceProcess(service,process));
  function openServices(scope?:{appPath?:string;ids?:string[];name?:string}){setServicesScope(scope);setServicesOpen(true);}
  const [contexts,setContexts]=useState<PageContexts>();const [contextError,setContextError]=useState<DisplayError>('');
  contextsRef.current=contexts;
  const [contextQuery,setContextQuery]=useState('');const [linkedOnly,setLinkedOnly]=useState(false);
  const [contextDetail,setContextDetail]=useState<string>();const [unmappedOnly,setUnmappedOnly]=useState(false);
  const [linksBusy,setLinksBusy]=useState(false);const contextGeneration=useRef(0);
  const [plan,setPlan]=useState<Plan>();const [force,setForce]=useState(false);
  const [quitPlan,setQuitPlan]=useState<QuitPlan>();const [applicationState,setApplicationState]=useState<ApplicationState>();
  const [expires,setExpires]=useState(0);const [remaining,setRemaining]=useState(0);
  const [busy,setBusy]=useState(false);const [refreshing,setRefreshing]=useState(false);
  const [privilegedWarning,setPrivilegedWarning]=useState<DisplayError>('');const privilegedReading=useRef(false);
  const [privilegedStatus,setPrivilegedStatus]=useState<PrivilegedStatus>();const [privilegedBusy,setPrivilegedBusy]=useState(false);
  const [privilegedFailure,setPrivilegedFailure]=useState<{action:'enable'|'disable';error:DisplayError}>();
  const [privilegedChecking,setPrivilegedChecking]=useState(false);const privilegedCheck=useRef<()=>Promise<void>>(async()=>{});
  const privilegedOperating=useRef(false);
  const alive=useRef(true);const operation=useRef(false);const reading=useRef(false);const readAgain=useRef(false);
  const queryRef=useRef(deferredQuery);queryRef.current=deferredQuery;
  const searchSelection=useRef(deferredQuery);
  const openedSelection=useRef('');const selected=context.config?.selection?.groupId;
  const hasOtherUserProcesses=!!data?.hasRestrictedProcesses;
  const helperMissing=privilegedStatus?.status==='missingHelper'||privilegedStatus?.status==='unsupported';
  const helperInstalled=['enabled','needsRepair','needsUpdate','unreachable'].includes(privilegedStatus?.status??'');
  const canEnable=!!privilegedStatus&&['notRegistered','needsUpdate','needsRepair','unreachable'].includes(privilegedStatus.status)&&!helperMissing;
  const canRetryPrivilege=!!privilegedFailure&&!!privilegedStatus&&!privilegedStatus.checking&&!privilegedStatus.stale&&!privilegedStatus.warning&&(privilegedFailure.action==='enable'?canEnable:helperInstalled);
  const actionNotice=notice===privilegedStatus?.message?'':notice;
  const applications=useApplications(api,data?.groups??[]);
  const sourcePresentation=detail?.instances?.find(instance=>instance.id===source?.instanceId)?.presentation;
  const sourceClues=sourcePresentation?applicationIdentity({name:detail?.name??source?.name??'',appPath:detail?.appPath,origin:detail?.origin,presentation:sourcePresentation},applications).sourceText:'';

  function openDetail(group:Group|GroupSummary,search=''){
    detailSelection.current={id:group.id,generation:detailSelection.current.generation+1,request:0,initialSearch:search};
    const full='processes' in group?{...group,processes:[...group.processes]}:undefined;
    detailRef.current=full;setDetail(full);setDetailId(group.id);setContextProcesses([]);
    contextGeneration.current++;setLinksBusy(false);
    setProcessQuery(search);setContexts(undefined);setContextError('');setTab('processes');setSelectedInstance(undefined);setCheckedInstances([]);setSource(undefined);setApplicationState(undefined);
    setContextQuery('');setLinkedOnly(false);setContextDetail(undefined);setUnmappedOnly(false);
  }
  function closeDetail(){detailSelection.current={id:'',generation:detailSelection.current.generation+1,request:0,initialSearch:''};detailRef.current=undefined;contextGeneration.current++;setDetailId(undefined);setDetail(undefined);setContextProcesses([]);setSource(undefined);setContextDetail(undefined);setLinksBusy(false);}
  function acceptDetail(next:GroupDetail,generation:number,request=detailSelection.current.request){
    const selection=detailSelection.current;
    if(!alive.current||selection.id!==next.groupId||selection.generation!==generation||selection.request!==request||!newerSnapshot(next,selection.sample))return;
    const first=!selection.sample;selection.sample={at:next.at,revision:next.revision};
    const previous=detailRef.current;
    const updated=previous?.id===next.groupId?updateDetail(previous,next.group??undefined,next.elsewhere):next.group??undefined;
    detailRef.current=updated;setDetail(updated);setContextProcesses(next.contextProcesses);
    if(first){const search=selection.initialSearch.trim().toLocaleLowerCase();const matches=!!search&&!!next.group?.processes.some(p=>matchesProcess(p,search));setProcessQuery(matches?selection.initialSearch:'');setTab(matches?'processes':(next.group?.instances?.length??0)>1?'instances':'processes');}
  }
  async function readDetail(){
    const selection=detailSelection.current;const {id,generation}=selection;if(!id)return;const request=++selection.request;
    const trackedPids=[...new Set((detailRef.current?.processes??[]).filter(p=>!p.exited).map(p=>p.pid))];
    const contextPids=[...new Set((contextsRef.current?.entries??[]).flatMap(entry=>entry.processes.map(p=>p.pid)))];
    try{const next=await readGroupDetail(api,id,trackedPids,contextPids);acceptDetail(next,generation,request);if(alive.current&&generation===detailSelection.current.generation)setError(previous=>previous instanceof RequestError&&previous.method==='group_detail'?'':previous);}
    catch(reason){if(alive.current&&generation===detailSelection.current.generation)setError(displayError(reason));}
  }
  useEffect(()=>{if(selected&&selected!==openedSelection.current&&data){openedSelection.current=selected;const group=data.groups.find(g=>g.id===selected);if(group)openDetail(group);else{detailSelection.current={id:selected,generation:detailSelection.current.generation+1,request:0,initialSearch:''};setDetailId(selected);}}},[selected,data]);
  useEffect(()=>{if(detailId)void readDetail();},[api,detailId,contexts]);
  useEffect(()=>{
    const groupId=detail?.id;if(!groupId)return;
    let current=true;
    void api.invoke<ApplicationState>('application_state',{groupId}).then(value=>{if(current)setApplicationState(value);})
      .catch(reason=>{if(current)setApplicationState({canQuit:false,message:errorText(reason)});});
    return()=>{current=false;};
  },[api,detail?.id,data?.at]);
  useEffect(()=>{
    if(api.preview||!hasOtherUserProcesses&&!privilegedFailure&&!startupScope)return;
    let current=true,timer:ReturnType<typeof setTimeout>|undefined;
    async function check(){
      clearTimeout(timer);
      if(document.hidden||privilegedBusy||privilegedReading.current){if(current)timer=setTimeout(check,5000);return;}
      privilegedReading.current=true;if(current)setPrivilegedChecking(true);
      try {
        const value=await api.invoke<PrivilegedStatus>('privileged_status');
        if(current){setPrivilegedStatus(value);setPrivilegedWarning(value.warning??'');setPrivilegedFailure(previous=>previous&&settledPrivilege(value,previous.action)?undefined:previous);}
      } catch(reason){
        if(current){setPrivilegedWarning(displayError(reason));setPrivilegedStatus(previous=>previous??{ok:false,status:'checking',message:'正在重新检查进程服务，尚未取得授权状态。'});}
      } finally{privilegedReading.current=false;if(current){setPrivilegedChecking(false);timer=setTimeout(check,5000);}}
    }
    const visible=()=>{if(!document.hidden)void check();};
    privilegedCheck.current=check;void check();document.addEventListener('visibilitychange',visible);
    return()=>{current=false;clearTimeout(timer);document.removeEventListener('visibilitychange',visible);privilegedCheck.current=async()=>{};};
  },[api,hasOtherUserProcesses,privilegedBusy,!!privilegedFailure,!!startupScope]);

  function rankingError(next:DisplayError){setError(previous=>previous instanceof RequestError&&previous.method!=='ranking_snapshot'&&previous.method!=='refresh_summary'?previous:next);}
  function accept(next:RankingSnapshot){
    if(next.query!==queryRef.current.trim().toLocaleLowerCase()||!newerSnapshot(next,dataRef.current))return false;
    dataRef.current=next;setData(next);return true;
  }
  function acceptFull(next:Snapshot){
    accept(rankingFrom(next,queryRef.current,next.includeSystem??dataRef.current?.includeSystem??false));
    const selection=detailSelection.current;
    if(selection.id){selection.request++;acceptDetail(detailFrom(next,selection.id,(detailRef.current?.processes??[]).map(p=>p.pid),(contextsRef.current?.entries??[]).flatMap(entry=>entry.processes.map(p=>p.pid))),selection.generation);}
  }
  async function changeView(patch:Partial<ViewPreferences>){
    if(viewWriting.current)return;
    viewWriting.current=true;
    setViewSaving(true);
    setError(previous=>previous instanceof RequestError&&previous.method==='set_view_preferences'?'':previous);
    try{
      const next=await api.invoke<RankingSnapshot>('set_view_preferences',{...patch,query:queryRef.current});
      if(alive.current&&!accept(next))void refresh();
    }catch(error){if(alive.current)setError(displayError(error));}
    finally{viewWriting.current=false;if(alive.current)setViewSaving(false);}
  }
  async function managePrivileged(action:'enable'|'disable'){
    if(privilegedOperating.current)return;privilegedOperating.current=true;
    setPrivilegedBusy(true);setPrivilegedChecking(false);setPrivilegedFailure(undefined);setError('');setNotice('');
    try{
      const value=await api.invoke<PrivilegedStatus>(`privileged_${action}`);
      if(!alive.current)return;
      setPrivilegedStatus(value);setPrivilegedWarning('');
      if(action==='enable'&&value.status==='enabled')await refresh(true);
      if(action==='disable')await refresh(true);
    }catch(error){if(alive.current)setPrivilegedFailure({action,error:displayError(error)});}
    finally{privilegedOperating.current=false;if(alive.current)setPrivilegedBusy(false);}
  }
  function confirmPrivileged(action:'enable'|'disable'){
    Modal.confirm({
      zIndex:2000,
      title:action==='enable'?'授权系统进程与后台服务控制？':'停用完整系统进程监控？',
      content:action==='enable'?`macOS 将请求管理员授权安装或升级常驻进程服务。服务读取系统进程资源，允许已核验的 FlowHub 采集插件结束所选第三方 root 进程，并暂停或恢复你确认的第三方后台服务。暂停只影响当前登录或开机期间。${privilegedStatus?.vivoStartupSupported?'服务也可按你的确认配置 vivo 远控守护服务的自启动，保留正在运行的进程。':''}系统核心服务、FlowHub 及采集服务自身继续受保护。不执行任意管理员命令，也不读取或保存密码。升级应用或采集插件后可能需要重新授权。服务随系统启动，可随时在此停用并卸载。`:'macOS 将请求管理员认证，停止并卸载该系统服务。随后使用当前用户权限采集进程数据。已暂停的第三方服务不会自动恢复，请先在“后台服务”恢复，或重新登录、重启电脑。',
      okText:action==='enable'?'继续并授权安装':'停用并卸载',cancelText:'取消',
      onOk:()=>managePrivileged(action)
    });
  }
  async function refresh(manual=false){
    if(manual){
      setRefreshing(true);setError('');
      void privilegedCheck.current();
      try{const next=await api.invoke<RankingSnapshot>('refresh_summary',{query:queryRef.current});if(alive.current){if(accept(next))rankingError(next.error??'');await Promise.all([refresh(),readDetail()]);}}
      catch(e){if(alive.current)setError(displayError(e));}
      finally{if(alive.current)setRefreshing(false);}
      return;
    }
    if(reading.current){readAgain.current=true;return;}reading.current=true;
    try{const next=await api.invoke<RankingSnapshot>('ranking_snapshot',{query:queryRef.current});if(alive.current&&accept(next))rankingError(next.error??'');}
    catch(e){if(alive.current)setError(displayError(e));}
    finally{reading.current=false;if(alive.current&&readAgain.current){readAgain.current=false;void refresh();}}
  }
  useEffect(()=>{
    if(searchSelection.current===deferredQuery)return;
    searchSelection.current=deferredQuery;
    const timer=setTimeout(()=>{if(!document.hidden)void refresh();},120);return()=>clearTimeout(timer);
  },[api,deferredQuery]);
  useEffect(()=>{
    alive.current=true;let timer:ReturnType<typeof setTimeout>|undefined;let running=false;
    async function tick(){if(running)return;running=true;clearTimeout(timer);try{if(!document.hidden)await Promise.all([refresh(),readDetail()]);}finally{running=false;if(alive.current)timer=setTimeout(tick,5000);}}
    const visible=()=>{if(!document.hidden){clearTimeout(timer);void tick();}};
    void tick();document.addEventListener('visibilitychange',visible);
    return()=>{alive.current=false;contextGeneration.current++;clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
  },[api]);
  useEffect(()=>{if(!plan&&!quitPlan)return;const update=()=>setRemaining(Math.max(0,Math.ceil((expires-Date.now())/1000)));update();const timer=setInterval(update,500);return()=>clearInterval(timer);},[plan,quitPlan,expires]);

  async function prepareQuit(instanceId?:string){
    if(!detail||api.preview||operation.current||plan||quitPlan)return;
    if(!instanceId&&(applicationState?.quitInstances?.length??0)>1){setTab('instances');return;}
    operation.current=true;setBusy(true);setError('');setNotice('');
    try{const next=await api.invoke<QuitPlan>('quit_preview',{groupId:detail.id,...(instanceId?{instanceId}:{})});if(alive.current){setQuitPlan(next);setExpires(Date.now()+next.expiresIn*1000);}}
    catch(reason){if(alive.current)setError(displayError(reason));}
    finally{operation.current=false;if(alive.current)setBusy(false);}
  }
  async function executeQuit(){
    if(!quitPlan||remaining<=0||api.preview||operation.current)return;
    operation.current=true;setBusy(true);setError('');
    try{
      const result=await api.invoke<{requested:boolean;results:Array<{pid:number;requested:boolean}>;snapshot:Snapshot;refreshError?:string|null}>('quit_confirm',{token:quitPlan.token,confirmed:true});
      if(alive.current){
        acceptFull(result.snapshot);setQuitPlan(undefined);
        if(result.requested)setNotice('已发送正常退出请求。请在应用中处理可能出现的保存提示；后台服务可能继续运行。');
        const rejected=result.results.filter(item=>!item.requested);
        setError([rejected.length?`以下实例未接受退出请求（PID ${rejected.map(item=>item.pid).join('、')}），请从应用菜单退出或处理保存提示。`:'',result.refreshError].filter(Boolean).join(' '));
      }
    }catch(reason){if(alive.current){setQuitPlan(undefined);setError(displayError(reason));}}
    finally{operation.current=false;if(alive.current)setBusy(false);}
  }

  async function prepare(target:Group|GroupSummary|Process,instanceId?:string,instanceIds?:string[]){
    if(api.preview||operation.current||plan)return;
    if('id' in target&&!instanceId&&!instanceIds&&('processes' in target?(target.instances?.length??0):target.instanceCount)>1){openDetail(target);setTab('instances');return;}
    operation.current=true;setBusy(true);setError('');setNotice('');
    try{
      const params='id' in target?{groupId:target.id,...(instanceIds?{instanceIds}:{instanceId:instanceId??('processes' in target?target.instances?.[0]?.id:target.onlyInstanceId)}),force:false}:{identity:identity(target),force:false};
      const next=await api.invoke<Plan>('terminate_preview',params);
      if(alive.current){setPlan(next);setForce(false);setExpires(Date.now()+next.expiresIn*1000);}
    }catch(e){if(alive.current)setError(displayError(e));}
    finally{operation.current=false;if(alive.current)setBusy(false);}
  }
  async function execute(){
    if(!plan||remaining<=0||api.preview||operation.current)return;
    operation.current=true;setBusy(true);
    try{
      const result=await api.invoke<TerminateResult>('terminate_confirm',{token:plan.token,confirmed:true,force});
      if(!alive.current)return;acceptFull(result.snapshot);setPlan(undefined);
      const exited=result.results.filter(r=>r.exited).length;
      const waiting=result.results.filter(r=>r.sent&&!r.exited).length;
      setNotice(`${exited} 个进程已退出${waiting?`，${waiting} 个已发送信号、等待退出`:''}。`);
      setError([...result.results.filter(r=>r.error).map(r=>`PID ${r.pid}：${r.error}`),result.refreshError].filter(Boolean).join('；'));
    }catch(e){if(alive.current){setError(displayError(e));setPlan(undefined);}}
    finally{operation.current=false;if(alive.current)setBusy(false);}
  }
  async function loadContexts(arcTasks=false){
    if(!detail||linksBusy||!controls.contextKind)return;
    const generation=++contextGeneration.current;setLinksBusy(true);setContextError('');
    try{const next=await api.invoke<PageContexts>(arcTasks?'arc_tasks':'contexts',{groupId:detail.id,...(arcTasks?{open:true}:{})});if(alive.current&&generation===contextGeneration.current)setContexts(next);}
    catch(e){if(alive.current&&generation===contextGeneration.current)setContextError(displayError(e));}
    finally{if(alive.current&&generation===contextGeneration.current)setLinksBusy(false);}
  }
  async function openApp(group:Group,token?:string){
    if(api.preview||linksBusy||busy||plan)return;
    const generation=++contextGeneration.current;setLinksBusy(true);setContextError('');
    try{await api.invoke(token?'open_context':'focus_app',{groupId:group.id,...(token?{token}:{})});}
    catch(e){if(alive.current&&generation===contextGeneration.current)setContextError(displayError(e));}
    finally{if(alive.current&&generation===contextGeneration.current)setLinksBusy(false);}
  }

  const groups=useMemo(()=>filterRanking((data?.groups??[]).map(group=>{
    const identity=applicationIdentity(group,applications);
    return {...group,name:identity.name,source:identity.description};
  }),deferredQuery,data?.query===deferredQuery.trim().toLocaleLowerCase()?data.matchedGroupIds:[],system,sorting.key,sorting.order),[data,applications,deferredQuery,system,sorting]);
  const changeSort:TableProps<GroupSummary>['onChange']=(_pagination,_filters,sorter,extra)=>{
    if(extra.action!=='sort')return;
    const active=Array.isArray(sorter)?sorter[0]:sorter;
    const key=active?.columnKey;
    if(key==='footprint'||key==='memory'||key==='cpu'||key==='accounting'||key==='processCount')void changeView({sorting:{key,order:active.order==='ascend'?'ascend':'descend'}});
  };
  const sortable=(key:RankingSort)=>({sorter:true,sortOrder:sorting.key===key?sorting.order:null});
  const linkedRows=useMemo(()=>contexts?contextRows(contexts,{groups:[{processes:[...(detail?.processes??[]).filter(p=>!p.exited&&!p.moved),...contextProcesses]}]}):[],[contexts,detail,contextProcesses]);
  const rowDetail=linkedRows.find(row=>row.id===contextDetail);
  const processLabels=useMemo(()=>{
    const labels=new Map<string,string[]>();
    for(const row of linkedRows)for(const p of row.liveProcesses){const key=processKey(p);labels.set(key,[...(labels.get(key)??[]),row.title]);}
    return labels;
  },[linkedRows]);
  const contextSearch=contextQuery.trim().toLocaleLowerCase();
  const visibleContexts=linkedRows.filter(row=>(!linkedOnly||row.processes.length>0)&&(!contextSearch||[row.title,row.detail,...row.processes.map(p=>String(p.pid))].some(text=>text.toLocaleLowerCase().includes(contextSearch))));
  const controls=detailControls(detail,applicationState,selectedInstance,checkedInstances);
  const detailIdentity=detail?applicationIdentity(detail,applications):undefined;
  const registeredServices=[...new Map((detail?.presentation?.services??[]).map(service=>[service.label,service])).values()];
  const groupingBasis=[
    detail?(data?.groups.find(group=>group.id===detail.id)?.source??detail.source):'',
    detailIdentity?.sourceText?`来源线索：${detailIdentity.sourceText}`:'',
    registeredServices.length?`服务登记：${registeredServices.length} 项`:'',
    detailIdentity?.related?`关联应用：${detailIdentity.related.name}（独立辅助应用）`:'',
  ].filter(Boolean).join(' · ');
  const activeTab=tab==='pages'&&!controls.contextKind?'processes':tab;
  const isArc=controls.contextKind==='arc';
  const activeInstance=detail?.instances?.find(instance=>instance.id===selectedInstance);
  const shownStats=selectedInstance?activeInstance:detail;
  const detailAppPath=detail?.appPath??undefined;
  const detailStartup=detailAppPath==='/Applications/pcsuite.app'?'vivo':detailAppPath&&(detailAppPath.endsWith('/OneDrive.app')||applications[detailAppPath]?.bundleId==='com.microsoft.OneDrive')
    ?'com.microsoft.OneDriveLauncher'
    :detail?.processes.map(databaseStartupId).find(Boolean);
  const detailServices=detail?(background.data?.services??[]).filter(service=>
    (!!detailAppPath&&service.appPath===detailAppPath)||detail.processes.some(process=>!process.exited&&!process.moved&&sameServiceProcess(service,process))):[];
  const detailAccounting=detail?accountingDisplay(detail):undefined;
  const detailHint=controls.stopHint||(detail?.appPath&&!controls.canQuit?(selectedInstance&&(applicationState?.quitInstances?.length??0)>0?'当前选择的是后台或辅助实例，可按此实例单独结束。':applicationState?.message):'');
  const columns:TableColumnsType<GroupSummary>=[
    {
      title:'应用 / 工具',key:'name',fixed:'left',width:138,
      render:(_,group)=>{
        const name=applicationIdentity(group,applications).name;
        return <div className="app-identity">
          <AppMark name={name} iconKey={group.iconKey} application={group.appPath?applications[group.appPath]:undefined}/>
          <button type="button" className="name-link" aria-label={`查看 ${name} 进程`} onClick={()=>openDetail(group,query)}>{name}</button>
        </div>;
      }
    },
    {title:'进程数',key:'processCount',...sortable('processCount'),width:64,align:'right',render:(_,group)=><span className="numeric">{group.processCount}</span>},
    {title:'活跃足迹',key:'footprint',...sortable('footprint'),width:86,align:'right',render:(_,group)=><span className="numeric" title={group.footprintIncomplete?'部分不可读取':undefined}>{bytes(group.footprint)}{group.footprintIncomplete?' *':''}</span>},
    {title:'RSS',key:'memory',...sortable('memory'),width:78,align:'right',render:(_,group)=><span className="numeric" title={group.incomplete?'部分不可读取':undefined}>{bytes(group.memory)}{group.incomplete?' *':''}</span>},
    {title:'系统归属记账',key:'accounting',...sortable('accounting'),width:105,align:'right',render:(_,group)=>{
      const accounting=accountingDisplay(group);
      return <span className={accounting.available?'numeric':'muted text-xs'} title={accounting.hint}>
        {accounting.text}{accounting.available&&group.systemAccounting?.shared?<small className="block muted text-xs">共享</small>:null}
      </span>;
    }},
    {title:'CPU',key:'cpu',...sortable('cpu'),width:63,align:'right',render:(_,group)=><span className="numeric">{group.permissionLimited?'—':cpu(group.cpu)}</span>},
  ];
  const instanceColumns:TableColumnsType<Instance>=[
    {title:'运行实例',key:'root',render:(_,instance)=>{
      const process=detail?.processes.find(p=>p.pid===instance.root.pid&&p.started===instance.root.started);
      const clues=applicationIdentity({name:instance.presentation?.name??process?.name??detail?.name??'',appPath:detail?.appPath,presentation:instance.presentation},applications).sourceText;
      const service=process?serviceFor(process):undefined;
      return <div>
        <strong>PID {instance.root.pid} · {instance.presentation?.name??process?.name??'根进程'}</strong>
        {service?<div className="mt-1"><button className="text-link" title={service.restartHint} onClick={()=>openServices({ids:[service.id]})}>{restartLabel(service)} · 后台服务</button></div>:null}
        {clues?<div className="muted text-xs mt-1">来源线索：{clues}</div>:null}
        <div className="muted text-xs mt-1">{instance.root.started?`${new Date(instance.root.started/1000).toLocaleString()} 启动`:'启动时间不可读取'}</div>
        <div className="path muted text-xs mt-1">{process?.runtimeProject?.entry??instance.root.executable}</div>
      </div>;
    }},
    {title:'进程',dataIndex:'count',width:60,align:'right'},
    {title:'内存足迹',key:'footprint',width:100,align:'right',render:(_,instance)=>bytes(instance.footprint)},
    {title:'CPU',key:'cpu',width:65,align:'right',render:(_,instance)=>cpu(instance.cpu)},
    {title:'操作',key:'actions',width:210,render:(_,instance)=>{const reason=detail?instanceStopReason(detail,instance):'';return <div><div className="flex flex-wrap gap-1"><Button size="sm" className="compact-button" onClick={()=>{setSelectedInstance(instance.id);setCheckedInstances([]);setTab('processes');}}>查看进程</Button>{applicationState?.quitInstances?.includes(instance.id)?<Button size="sm" className="compact-button" disabled={api.preview||busy||!!plan||!!quitPlan} onClick={()=>void prepareQuit(instance.id)}>正常退出</Button>:null}<Button size="sm" className="compact-button" disabled={api.preview||busy||!!plan||!!quitPlan||!instance.canTerminate} title={reason||undefined} onClick={()=>detail&&void prepare(detail,instance.id)}>结束实例</Button></div>{reason?<p className="muted text-xs mt-1">{reason}</p>:null}</div>;}}
  ];
  const processColumns:TableColumnsType<Process>=[
    {title:'进程 / 来源',key:'name',render:(_,p)=><div className={p.exited?'exited':''}><button className="name-link" onClick={()=>setSource(p)}>{processName(p)}</button>{serviceFor(p)?<div className="mt-1"><button className="text-link" title={serviceFor(p)!.restartHint} onClick={()=>openServices({ids:[serviceFor(p)!.id]})}>{restartLabel(serviceFor(p)!)} · 后台服务</button></div>:null}{p.displayName?<div className="muted text-xs mt-1">可执行文件名：{p.name}</div>:null}<div className="muted text-xs mt-1">PID {p.pid}{p.ppid>0?` ← ${p.ppid} · ${p.parentName}`:' · 父进程不可读取'}{p.moved?' · 已移到其他分组':p.exited?' · 已退出':''}</div><div className="muted text-xs mt-1">{p.role} · {p.attribution}</div>{permissionLimited(p)?<div className="warning text-xs mt-1">资源指标不可读取</div>:null}{processLabels.has(processKey(p))?<div className="context-label text-xs mt-1">{(processLabels.get(processKey(p))?.length??0)>1?'共享：':'关联：'}{processLabels.get(processKey(p))?.join('、')}</div>:contexts?<div className="muted text-xs mt-1">未关联到页面或对话</div>:null}</div>},
    {title:'内存足迹',key:'footprint',width:110,align:'right',render:(_,p)=>bytes(p.footprint)},
    {title:'RSS',key:'memory',width:100,align:'right',render:(_,p)=>bytes(p.memory)},
    {title:'CPU',key:'cpu',width:75,align:'right',render:(_,p)=>p.exited||permissionLimited(p)?'—':cpu(p.cpu)},
    {title:'操作',key:'action',width:75,render:(_,p)=><Button size="sm" className="compact-button" disabled={api.preview||busy||!!plan||p.protected||p.exited} onClick={()=>void prepare(p)}>结束</Button>}
  ];
  const contextColumns:TableColumnsType<ContextRow>=[
    {title:contexts?.kind==='codex'?'对话 / 工作进程':'标签 / 任务',key:'title',render:(_,row)=><div><button className="name-link context-title" onClick={()=>setContextDetail(row.id)}>{row.title}</button><div className="muted text-xs mt-1 path context-path">{row.detail}</div><div className="muted text-xs mt-1">{row.processes.length?`${row.source} · PID ${row.processes.map(p=>p.pid).join('、')}`:'未发现可靠 PID 映射'}</div></div>},
    {title:contexts?.kind==='codex'?'子进程足迹':'进程足迹',key:'footprint',width:105,align:'right',render:(_,row)=><span className="numeric">{bytes(row.footprint)}{row.incomplete&&row.footprint!=null?' *':''}</span>},
    {title:'RSS',key:'rss',width:90,align:'right',render:(_,row)=><span className="numeric">{bytes(row.memory)}</span>},
    {title:'状态',key:'state',width:100,render:(_,row)=><Tag color={row.shared||row.ambiguous?'orange':row.liveProcesses.length?'blue':undefined}>{row.state}</Tag>},
    {title:'操作',key:'action',width:132,render:(_,row)=><div className="flex flex-wrap gap-1"><Button size="sm" className="compact-button" disabled={!row.processes.length} onClick={()=>setContextDetail(row.id)}>进程</Button><Button size="sm" className="compact-button" disabled={api.preview||row.expired||!row.token||linksBusy||busy||!!plan} onClick={()=>detail&&row.token&&void openApp(detail,row.token)}>打开 ↗</Button></div>}
  ];
  const visibleProcesses=detail?.processes.filter(p=>(!selectedInstance||p.instanceId===selectedInstance)&&(!unmappedOnly||!processLabels.has(processKey(p)))&&matchesProcess(p,processQuery.trim().toLocaleLowerCase()))??[];
  const pressure=data?.system.pressure;
  const pressureLabel=pressure==='normal'?'正常':pressure==='warning'?'偏高':pressure==='critical'?'高':'未知';
  const stale=!!data&&(data.stale||!!data.at&&Date.now()-data.at>20000);
  return <main className="monitor p-3 md:p-4">
    <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
      <div className="flex items-center gap-2"><span className={`live-dot ${stale?'stale':''}`}/><span className="muted text-xs">{api.preview?'只读预览 · 模拟数据':data?.at?`本机 · ${new Date(data.at).toLocaleTimeString()} 更新${data.sampling?' · 采样中':''}`:'正在等待首次采样'}</span><HelpPopover label="统计口径与监控范围">活跃进程足迹是当前分组内进程的 phys_footprint 合计，包含脏页、压缩及换出等记账；RSS 是当前常驻内存。系统归属记账读取应用的系统资源组账本，可包含独立任务和已退出任务的余额，各行可能重叠。三者不能相加，也不等于结束后释放的内存。CPU 按单核 100% 计。页面与对话可能共享进程。</HelpPopover></div>
      <div className="flex flex-wrap items-center gap-2"><Button size="sm" className="compact-button" onClick={()=>openServices()}>后台服务{background.data?.services.some(service=>service.paused)?` (${background.data.services.filter(service=>service.paused).length} 已暂停)`: ''}</Button><Button size="sm" className="compact-button" onClick={()=>setStartupScope('all')}>自启动</Button><Button size="sm" className="compact-button" onClick={()=>setFinderScope({})}>访达扩展</Button><Button size="sm" className="compact-button" onClick={()=>setScriptsOpen(true)}>脚本来源{data?.scriptRunningCount?` (${data.scriptRunningCount})`:''}</Button><Button size="sm" className="compact-button" disabled={refreshing} onClick={()=>void refresh(true)}>{refreshing?'刷新中…':'刷新'}</Button>{!api.widget?<Button size="sm" className="compact-button" disabled={api.preview} onClick={()=>void api.invoke('flowhub_status').catch(e=>setError(displayError(e)))}>桌面与菜单栏</Button>:null}</div>
    </div>
    <div className="system-strip grid grid-cols-3 gap-3 mb-3">
      <div><span className="muted">物理内存</span><strong>{bytes(data?.system.totalMemory)}</strong></div>
      <div><span className="muted">内存压力</span><strong className={pressure==='critical'?'danger':pressure==='warning'?'warning':''}>{pressureLabel}</strong></div>
      <div><span className="muted">已用交换空间</span><strong>{bytes(data?.system.swapUsed)}</strong></div>
    </div>
    {hasOtherUserProcesses?<Alert type={privilegedStatus?.status==='enabled'?'success':'warning'} showIcon className="mb-3" title={privilegedStatus?.message??'正在检查系统进程采集服务…'} action={<div className="flex gap-2">{canEnable&&!privilegedFailure?<Button size="sm" className="compact-button" disabled={api.preview||privilegedBusy||!!privilegedStatus?.checking||!!privilegedStatus?.stale} onClick={()=>confirmPrivileged('enable')}>{privilegedBusy?'处理中…':privilegedStatus?.status==='needsUpdate'?'授权更新':privilegedStatus?.status==='unreachable'?'授权修复':'管理员授权安装'}</Button>:null}{helperInstalled?<Button size="sm" className="compact-button" disabled={api.preview||privilegedBusy||!!privilegedFailure} onClick={()=>confirmPrivileged('disable')}>停用并卸载</Button>:null}</div>}/>:null}
    {privilegedFailure?<Alert type="warning" showIcon className="mb-3" title={privilegedFailure.action==='enable'?'安装或升级结果尚未确认':'卸载结果尚未确认'} description={<><p>{errorText(privilegedFailure.error)}</p><p>正在核实实际状态，确认完成后会自动移除此提示。若 macOS 认证窗口仍打开，请先完成或取消认证。</p>{privilegedFailure.error instanceof RequestError?<RequestDetails error={privilegedFailure.error}/>:null}</>} action={<div className="flex flex-wrap gap-2"><Button size="sm" disabled={privilegedBusy||privilegedChecking} onClick={()=>void privilegedCheck.current()}>{privilegedChecking?'核实中…':'核实状态'}</Button>{canRetryPrivilege?<Button size="sm" disabled={api.preview||privilegedBusy||privilegedChecking} onClick={()=>confirmPrivileged(privilegedFailure.action)}>{privilegedFailure.action==='enable'?'重新授权安装':'重试卸载'}</Button>:null}</div>}/>:null}
    {privilegedWarning?<div className="warning text-xs mb-3"><p role="status">{privilegedWarning instanceof Error?'授权状态暂未更新，稍后会自动重试。':''}{errorText(privilegedWarning)}</p><RequestDetails error={privilegedWarning}/></div>:null}
    {api.preview?<Alert type="info" showIcon title="只读模拟数据，结束与应用跳转已禁用。" className="mb-3"/>:null}
    {error?<Alert type="error" showIcon title={errorText(error)} description={error instanceof RequestError?<RequestDetails error={error}/>:undefined} className="mb-3"/>:null}
    {actionNotice?<Alert type="success" showIcon title={actionNotice} className="mb-3"/>:null}
    {stale?<Alert type="warning" showIcon title="数据已过期，请刷新后再操作。" className="mb-3"/>:null}
    <div className="flex flex-wrap items-center gap-3 mb-3">
      <Input aria-label="搜索应用、进程、PID 或路径" maxLength={4096} placeholder="搜索应用、进程、PID 或路径" value={query} onChange={e=>setQuery(e.target.value)} className="search-input" style={searchStyle}/>
      <label className="flex items-center gap-2 muted text-xs" title="同步应用到桌面卡片"><Switch size="small" aria-label="包含系统进程" checked={system} loading={viewSaving} disabled={!data} onChange={includeSystem=>void changeView({includeSystem})}/>包含系统进程</label>
      <span className="muted text-xs ml-auto">{groups.length} 个应用与工具</span>
    </div>
    <Table<GroupSummary> className="ranking-table" size="small" rowKey="id" columns={columns} dataSource={groups} onChange={changeSort} sortDirections={['descend','ascend','descend']} showSorterTooltip={{target:'sorter-icon'}} loading={!data&&!error} scroll={{x:534}} pagination={{pageSize:20,hideOnSinglePage:true,showSizeChanger:false,size:'small'}} locale={{emptyText:query?'没有匹配的应用或进程':'暂无应用数据',triggerDesc:'点击降序',triggerAsc:'点击升序'}}/>
    <p className="muted text-xs mt-3">每 5 秒采样 · * 表示部分可读 · 系统归属记账与活跃足迹、RSS 分别统计</p>

    <Modal title={detail?<div className="app-identity"><AppMark name={applicationIdentity(detail,applications).name} iconKey={detail.iconKey} application={detail.appPath?applications[detail.appPath]:undefined}/><span>{applicationIdentity(detail,applications).name} · 进程详情</span></div>:'进程详情'} open={!!detailId} onCancel={closeDetail} footer={<Button size="sm" className="compact-button" onClick={closeDetail}>关闭详情</Button>} width={1000} className="detail-modal" styles={{body:{height:'min(620px,calc(100dvh - 210px))',overflow:'auto'}}}>
      {!detail&&detailId?<p className="muted">{error?'详情读取失败，请重试。':detailSelection.current.sample?'应用已退出。':'正在读取进程详情…'}</p>:null}
      {detail?<>
        <div className="detail-management flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="应用管理">
            {detailStartup||detailAppPath?<Button size="sm" className="compact-button" onClick={()=>setStartupScope(detailStartup??detailAppPath)}>{detailStartup?.startsWith('homebrew.mxcl.')&&!detailServices.length?'自启动 / 后台服务':'自启动'}</Button>:null}
            {detailAppPath||detailServices.length?<Button size="sm" className="compact-button" onClick={()=>openServices({appPath:detailAppPath,ids:detailServices.map(service=>service.id),name:applicationIdentity(detail,applications).name})}>{detailServices.length?`后台服务 (${detailServices.length})`:'后台服务'}</Button>:null}
            {detailAppPath?<Button size="sm" className="compact-button" onClick={()=>setFinderScope({appPath:detailAppPath})}>访达扩展</Button>:null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {controls.canOpen?<Button size="sm" className="compact-button" disabled={api.preview||linksBusy||!!plan||!!quitPlan} onClick={()=>void openApp(detail)}>打开应用 ↗</Button>:null}
            {controls.canQuit?<Button size="sm" className="compact-button" disabled={api.preview||busy||!!plan||!!quitPlan} onClick={()=>void prepareQuit(selectedInstance)}>{controls.quitLabel}</Button>:null}
            {controls.canQuit?<HelpPopover label="正常退出与结束实例的区别">正常退出使用应用自身的退出流程，可能提示保存。结束实例会先列出目标进程供确认，再发送退出信号，可能中断正在执行的任务。</HelpPopover>:null}
          </div>
        </div>
        <dl className="detail-metrics grid grid-cols-3 gap-2">
          <div><dt>{selectedInstance?'实例活跃足迹':'活跃进程足迹'}</dt><dd className="numeric">{bytes(shownStats?.footprint)}{shownStats?.footprintIncomplete?' *':''}</dd></div>
          <div><dt>RSS</dt><dd className="numeric">{bytes(shownStats?.memory)}{shownStats?.incomplete?' *':''}</dd></div>
          <div><dt>CPU</dt><dd className="numeric">{detail.processes.length>0&&detail.processes.every(permissionLimited)?'—':cpu(shownStats?.cpu)}</dd></div>
        </dl>
        <ResourceHistory key={detail.id} api={api} groupId={detail.id}/>
        <details className="detail-accounting muted text-xs">
          <summary>统计口径与归组</summary>
          <p>系统归属记账（应用级参考） <strong className="numeric">{detailAccounting?.text}</strong>。{detailAccounting?.hint}{detail.systemAccounting?.shared?'此资源组由多条记录共享。':''}</p>
          <div className="flex items-start gap-2"><span>归组依据 {groupingBasis}</span><HelpPopover label="归组依据与结束范围">
            <p>服务登记、来源线索和关联应用用于识别。结束范围按确认框列出的独立实例核对。应用自身退出时，可能影响它管理的连接或子任务。</p>
            {registeredServices.length?<p className="mt-2">服务登记 {registeredServices.map(service=>service.label===service.name?service.name:`${service.name}（${service.label}）`).join('、')}。</p>:null}
          </HelpPopover></div>
        </details>
        {detailHint?<p className="muted text-xs mb-3">{detailHint}</p>:null}
        {detail.processes.some(p=>!p.exited&&!p.moved&&(permissionLimited(p)||(p.memory==null&&p.footprint==null)))?<Alert type="warning" showIcon title="部分进程的资源指标暂不可读取，可能受系统保护或采集服务连接影响。结束权限另行判断，请查看各实例的操作说明。" className="mb-3"/>:null}
        <Tabs activeKey={activeTab} onChange={key=>{setTab(key);if(key!=='processes')setSelectedInstance(undefined);}} items={[{key:'instances',label:`运行实例${detail.instances?.length?` (${detail.instances.length})`:''}`},{key:'processes',label:'进程'},...(controls.contextLabel?[{key:'pages',label:controls.contextLabel}]:[])]}/>
        <div className="detail-stop flex justify-end mb-3">
          <Button size="sm" variant="danger" className="compact-button" disabled={api.preview||busy||!!plan||!!quitPlan||!controls.canStop} title={controls.stopHint||undefined} onClick={()=>void prepare(detail,undefined,controls.stopIds)}>{controls.stopLabel}</Button>
        </div>
        {activeTab==='instances'?<>
          <p className="muted text-xs mb-3">一次独立启动记为一个运行实例，可包含主进程和辅助进程。勾选后仅结束所选实例。受保护实例不参与全选。</p>
          {checkedInstances.length?<div className="flex items-center gap-2 mb-3"><span className="muted text-xs">已勾选 {checkedInstances.length} 个实例</span><Button size="sm" className="compact-button" onClick={()=>setCheckedInstances([])}>清除选择</Button></div>:null}
          <Table<Instance> size="small" rowKey="id" columns={instanceColumns} dataSource={detail.instances??[]} rowSelection={{selectedRowKeys:checkedInstances,preserveSelectedRowKeys:true,onChange:keys=>setCheckedInstances(keys.map(String)),getCheckboxProps:instance=>({disabled:!instance.canTerminate||busy||!!plan||!!quitPlan,'aria-label':`选择实例 PID ${instance.root.pid}`})}} pagination={{pageSize:8,hideOnSinglePage:true,showSizeChanger:false,size:'small'}} scroll={{x:800}} locale={{emptyText:'暂无运行实例'}}/>
        </>:activeTab==='processes'?<>
          {selectedInstance?<div className="flex items-center gap-2 mb-3"><Tag>当前实例：{activeInstance?`根进程 PID ${activeInstance.root.pid}`:'已退出'}</Tag><Button size="sm" className="compact-button" onClick={()=>{setTab('instances');setSelectedInstance(undefined);}}>选择其他实例</Button><Button size="sm" className="compact-button" onClick={()=>setSelectedInstance(undefined)}>查看全部进程</Button></div>:<p className="muted text-xs mb-3">显示全部运行实例的进程。可在顶部结束全部可操作实例，或在“运行实例”中勾选要处理的实例。</p>}
          <div className="flex flex-wrap items-center gap-2 mb-3"><Input className="search-input" style={searchStyle} aria-label="搜索详情进程" placeholder="筛选进程名、PID、路径" value={processQuery} onChange={e=>setProcessQuery(e.target.value)}/><span className="muted text-xs">顺序固定，刷新只更新数值；新进程追加到末尾</span></div>
          {contexts?<label className="flex items-center gap-2 mb-3 text-xs"><Switch aria-label="只看未关联进程" checked={unmappedOnly} onChange={setUnmappedOnly}/>只看未关联进程</label>:null}
          <Table<Process> size="small" rowKey={p=>`${p.pid}:${p.started}`} dataSource={visibleProcesses} columns={processColumns} pagination={{pageSize:12,hideOnSinglePage:true,showSizeChanger:false,size:'small'}} scroll={{x:680}}/>
          <p className="muted text-xs mt-3">点击进程名查看路径、父进程和来源。{controls.contextKind?'渲染进程可能承载多个页面，占用不能直接分摊到单个页面或对话。':''}</p>
        </>:<>
          <div className="flex flex-wrap items-center gap-2 mb-3"><Button size="sm" className="compact-button" disabled={linksBusy||!detail.appPath||!!plan} onClick={()=>void loadContexts()}>{linksBusy?'读取中…':contexts?'重新读取关联':isArc?'读取标签':'读取对话与子进程'}</Button>{isArc?<Button size="sm" className="compact-button" disabled={api.preview||linksBusy||!!plan} onClick={()=>void loadContexts(true)}>读取 Arc 任务管理器</Button>:null}<HelpPopover label={`${controls.contextLabel}统计范围`}>Arc 从原生任务管理器读取标题与 PID，需要 FlowHub 辅助功能权限；未匹配的隐私窗口、子框架和扩展不绑定到普通标签。Codex 只读近期对话索引，并按工作进程的 CODEX_THREAD_ID 关联；共享界面、GPU 和后台服务不计入对话子进程合计。映射五分钟失效，PID 身份变化不会沿用。</HelpPopover></div>
          {contexts?.diagnostics&&contexts.diagnostics.state!=='ready'?<Alert type="warning" showIcon title={contexts.diagnostics.hint} className="mb-3" action={contexts.diagnostics.state==='permission-required'?<Button size="sm" className="compact-button" disabled={api.preview} onClick={()=>void api.invoke('accessibility_settings').catch(e=>setContextError(displayError(e)))}>打开辅助功能设置</Button>:undefined}/>:null}
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
        {contextError?<Alert type="error" title={errorText(contextError)} description={contextError instanceof RequestError?<RequestDetails error={contextError}/>:undefined} className="mt-3"/>:null}
        {error?<Alert type="error" title={errorText(error)} description={error instanceof RequestError?<RequestDetails error={error}/>:undefined} className="mt-3"/>:null}
        {actionNotice?<Alert type="success" title={actionNotice} className="mt-3"/>:null}
      </>:null}
    </Modal>

    <Modal title={rowDetail?.title??'关联进程'} open={!!rowDetail} onCancel={()=>setContextDetail(undefined)} footer={null} width={950} className="detail-modal context-detail-modal" zIndex={1100} styles={{body:{height:'min(550px,calc(100dvh - 170px))',overflow:'auto'}}}>
      {rowDetail?<><div className="flex flex-wrap items-center gap-2 mb-3"><Tag>{rowDetail.source}</Tag><span className="numeric">足迹 {bytes(rowDetail.footprint)} · RSS {bytes(rowDetail.memory)} · CPU {cpu(rowDetail.cpu)}</span></div>{rowDetail.shared||rowDetail.ambiguous?<Alert type="warning" showIcon title={rowDetail.shared?'同一进程承载多个标签，结束可能影响它们；各标签显示的进程占用不能相加。':'存在同名标签，无法确定唯一跳转目标。此处只展示任务管理器报告的进程。'} className="mb-3"/>:null}<p className="muted text-xs mb-3">{contexts?.kind==='codex'?'仅统计携带此对话 ID 的工作进程，未包含共享界面、GPU 与服务。':'按任务管理器 PID 关联；没有把整个应用占用分摊给标签。'} 新进程需重新读取关联。</p><Table<Process> size="small" rowKey={processKey} dataSource={rowDetail.liveProcesses} columns={processColumns} scroll={{x:680}} pagination={{pageSize:8,hideOnSinglePage:true,showSizeChanger:false,size:'small'}} locale={{emptyText:rowDetail.expired?'映射已过期，请重新读取':'没有仍在运行的关联进程'}}/>{error?<Alert type="error" title={errorText(error)} description={error instanceof RequestError?<RequestDetails error={error}/>:undefined} className="mt-3"/>:null}{actionNotice?<Alert type="success" title={actionNotice} className="mt-3"/>:null}</>:null}
    </Modal>

    <Modal title="进程来源" open={!!source} onCancel={()=>setSource(undefined)} footer={null} width={580} zIndex={1200} styles={{body:{maxHeight:'65dvh',overflow:'auto'}}}>
      {source?<><Descriptions column={1} size="small" items={[
        {key:'name',label:'进程',children:`${processName(source)} · PID ${source.pid}${source.moved?' · 已移到其他分组':source.exited?' · 已退出':''}`},
        ...(source.displayName?[{key:'binaryName',label:'可执行文件名',children:source.name}]:[]),
        {key:'role',label:'类型 / 归属',children:`${source.role} · ${source.attribution}`},
        ...(sourcePresentation?.name?[{key:'service-name',label:'服务名称',children:sourcePresentation.name}]:[]),
        ...(sourcePresentation?.services?.length?[{key:'service-registration',label:'服务登记',children:sourcePresentation.services.map(service=>`${service.label} · ${service.evidence}`).join('；')}]:[]),
        ...(sourceClues?[{key:'source-hints',label:'来源线索',children:sourceClues}]:[]),
        {key:'path',label:'可执行文件',children:<span className="path">{source.executable||'不可读取'}</span>},
        ...(source.launchExecutable?[{key:'launch-path',label:'启动路径',children:<span className="path">{source.launchExecutable}</span>}]:[]),
        ...(source.terminalOwner?[{key:'terminal-owner',label:'终端来源线索',children:<span className="path">{source.terminalOwner.executable} · PID {source.terminalOwner.pid}</span>}]:[]),
        {key:'cwd',label:'工作目录',children:<span className="path">{source.cwd||'不可读取'}</span>},
        ...(source.runtimeProject?[
          {key:'project',label:'项目 / 工具',children:`${source.runtimeProject.name} · ${source.runtimeProject.evidence}`},
          {key:'project-root',label:'项目目录',children:<span className="path">{source.runtimeProject.root}</span>},
          {key:'project-entry',label:'Node 入口脚本',children:<span className="path">{source.runtimeProject.entry||'未取得；按工作目录推断'}</span>}
        ]:[]),
        {key:'parent',label:'当前父进程',children:source.ppid>0?`${source.parentName} · PID ${source.ppid}`:'不可读取'},
        ...(detail?.instances?.find(instance=>instance.id===source.instanceId)?[{key:'instance-root',label:'实例根进程',children:`PID ${detail.instances.find(instance=>instance.id===source.instanceId)!.root.pid}`}]:[]),
        ...(source.responsible?[{key:'responsible',label:'系统归属应用',children:<span className="path">{source.responsible.executable} · PID {source.responsible.pid}</span>}]:[]),
        {key:'avd',label:'虚拟设备',children:source.avd||'—'},
        {key:'start',label:'启动时间',children:source.started?new Date(source.started/1000).toLocaleString():'不可读取'},
        {key:'usage',label:'本次占用',children:`足迹 ${bytes(source.footprint)} · RSS ${bytes(source.memory)} · CPU ${permissionLimited(source)?'—':cpu(source.cpu)}`}
      ]}/><p className="muted text-xs mt-3 mb-3">{processLabels.get(processKey(source))?`已读取的关联：${processLabels.get(processKey(source))?.join('、')}`:controls.contextKind?'当前父进程与工作目录只是来源线索，尚未取得可靠的页面或对话映射。':'当前父进程和工作目录用于解释启动来源；结束操作按当前所选进程确认。'}</p><div className="flex flex-wrap gap-2">{controls.contextLabel?<Button className="compact-button" onClick={()=>{setSource(undefined);setContextDetail(undefined);setTab('pages');}}>{controls.contextLabel}</Button>:null}{detail?.appPath?<Button className="compact-button" disabled={api.preview||linksBusy||!!plan} onClick={()=>void openApp(detail)}>打开应用 ↗</Button>:null}<Button className="compact-button" disabled={api.preview||busy||!!plan||source.exited||source.protected} onClick={()=>void prepare(source)}>结束</Button></div>{source.protected?<p className="muted text-xs mt-3">{source.protection}</p>:null}</>:null}
    </Modal>

    <Modal title={quitPlan?`退出 ${applicationIdentity({name:quitPlan.name,appPath:quitPlan.appPath},applications).name}${quitPlan.root?` · PID ${quitPlan.root.pid}`:''}？`:'退出此实例？'} open={!!quitPlan} onCancel={()=>{if(!busy)setQuitPlan(undefined);}} onOk={()=>void executeQuit()} okText={remaining>0?'确认退出此实例':'确认已过期'} cancelText="取消" confirmLoading={busy} okButtonProps={{danger:true,disabled:api.preview||remaining<=0}} cancelButtonProps={{disabled:busy}} closable={!busy} mask={{closable:!busy}} keyboard={!busy} zIndex={1300}>
      <p className="mb-3">向主应用发送正常退出请求。应用可能提示保存未保存内容，需要你在应用中处理。</p>
      <p className="mb-3">本次仅请求退出所选实例的界面主进程：{quitPlan?.targets.map(target=>`PID ${target.pid}`).join('、')}。</p>
      <p className="muted text-xs mb-3">应用自身可能关闭其管理的窗口、SSH 或脚本；监控不会额外结束仅有来源关联的独立任务。</p>
      <p className="muted text-xs">确认剩余 {remaining} 秒 · 执行前重新核对主应用身份</p>
    </Modal>

    <Modal title={plan?.scope?.kind==='instances'?`结束这 ${plan.scope.instances?.length} 个运行实例？`:plan?.scope?.kind==='instance'?(force?'强制结束此运行实例？':'结束此运行实例？'):(force?'强制结束此进程？':'结束此进程？')} open={!!plan} onCancel={()=>{if(!busy)setPlan(undefined);}} onOk={()=>void execute()} okText={remaining>0?force?'确认强制结束':'确认结束':'确认已过期'} cancelText="取消" confirmLoading={busy} okButtonProps={{danger:true,disabled:api.preview||remaining<=0}} cancelButtonProps={{disabled:busy}} closable={!busy} mask={{closable:!busy}} keyboard={!busy} zIndex={1300}>
      {plan?.scope?.kind==='instance'?<p className="mb-3"><strong>{plan.scope.name} · 根进程 PID {plan.scope.root?.pid}</strong><br/>本次操作仅包含下面列出的此实例进程。</p>:plan?.scope?.kind==='instances'?<p className="mb-3"><strong>{plan.scope.name} · {plan.scope.instances?.length} 个运行实例</strong><br/>实例根进程：{plan.scope.instances?.map(i=>`PID ${i.root.pid}`).join('、')}。仅结束确认列表中的实例，不包含受保护实例，也不包含随后新启动的实例。</p>:null}
      <Alert type="warning" showIcon title={force?'立即终止进程，未保存内容和正在执行的任务可能丢失。':'发送退出信号，可能中断任务或影响同一进程内的多个页面。'} className="mb-3"/>
      <p className="muted text-xs mb-3">结束 shell 或终端会话仍可能使其连接、子任务随之退出。</p>
      <label className="flex items-center gap-2 mb-3"><Switch aria-label="强制结束" checked={force} onChange={setForce} disabled={busy}/>强制结束<span className="muted text-xs">无响应时使用；不删除文件</span></label>
      <p className="muted text-xs mb-3">{plan?.targets.length??0} 个进程 · 确认剩余 {remaining} 秒 · 执行前重新核对身份</p>
      <div className="confirm-targets">{plan?.targets.map(p=><div key={`${p.pid}:${p.started}`} className="confirm-target"><strong>{processName(p)}</strong><span className="muted text-xs">PID {p.pid} · 足迹 {bytes(p.footprint)} · RSS {bytes(p.memory)}</span><span className="path muted text-xs">{p.executable}</span></div>)}</div>
    </Modal>
    {servicesOpen?<BackgroundServices api={api} data={background.data} error={background.error} scope={servicesScope} onClose={()=>setServicesOpen(false)} onRefresh={background.refresh} withOperation={background.withOperation} onChanged={()=>void refresh(true)} onAuthorize={()=>{setServicesOpen(false);confirmPrivileged('enable');}}/>:null}
    {startupScope?<StartupSettings api={api} scope={startupScope==='all'?undefined:startupScope}
      rootAccess={privilegedBusy||!privilegedStatus||privilegedStatus.stale||privilegedStatus.warning||privilegedWarning||privilegedStatus.status==='unreachable'?'checking':privilegedStatus.vivoStartupControl?'ready':privilegedStatus.checking?'checking':privilegedStatus.vivoStartupSupported?'authorize':'upgrade'}
      onAuthorize={()=>{setStartupScope(undefined);confirmPrivileged('enable');}} onStopped={()=>void refresh(true)}
      onClose={()=>setStartupScope(undefined)}/>:null}
    {finderScope?<FinderExtensions api={api} appPath={finderScope.appPath} onClose={()=>setFinderScope(undefined)} onChanged={()=>void refresh(true)}/>:null}
    {scriptsOpen?<ScriptDrawer api={api} selectedEventId={scriptEventId} onClose={()=>setScriptsOpen(false)}/>:null}
  </main>;
}
