import type {ApplicationState,Config,ContextEntry,Group,GroupDetail,GroupSummary,Identity,PageContexts,Process,RankingSnapshot,ScriptActivity,Snapshot,StatusSnapshot,Sort} from './types';

export function instanceStopReason(group:Group,instance:NonNullable<Group['instances']>[number]) {
  if(instance.canTerminate)return '';
  const protectedMembers=group.processes.filter(p=>p.instanceId===instance.id&&p.protected&&!p.exited);
  if(protectedMembers.some(p=>p.uid===0)&&protectedMembers.every(p=>!p.protection||p.protection==='其他用户或系统账户'))return 'root 进程：当前授权仅用于采集，不支持结束。';
  const reasons=[...new Set(protectedMembers.map(p=>p.protection).filter(Boolean))];
  return reasons.length?reasons.join('；'):'此实例含受保护进程，可查看进程了解原因。';
}
export function detailControls(group:Group|undefined,state?:ApplicationState,selectedId?:string,checkedIds:readonly string[]=[]) {
  const instances=group?.instances??[];
  const instance=selectedId?instances.find(item=>item.id===selectedId):instances.length===1?instances[0]:undefined;
  const chooseInstance=!selectedId&&instances.length>1;
  const application=!!group?.appPath&&!group.origin;
  const contextKind=application&&(state?.contextKind==='arc'||state?.contextKind==='codex')?state.contextKind:null;
  const stopIds=selectedId?[selectedId]:checkedIds.length?[...checkedIds]:instances.filter(i=>i.canTerminate).map(i=>i.id);
  const invalid=stopIds.some(id=>!instances.some(i=>i.id===id&&i.canTerminate));
  const canStop=stopIds.length>0&&!invalid;
  const protectedCount=instances.filter(i=>!i.canTerminate).length;
  const stopHint=selectedId&&!instance||checkedIds.length&&invalid?'所选运行实例已退出或不可操作，请重新选择。':!instances.length?'当前没有仍在运行的实例。':!canStop&&instance&&group?instanceStopReason(group,instance):!canStop?'当前实例均受保护，无法结束。':
    !selectedId&&!checkedIds.length&&protectedCount?`将结束 ${stopIds.length} 个可操作实例，${protectedCount} 个受保护实例不在本次范围内。`:'';
  return {instance,chooseInstance,canStop,stopIds,protectedCount,canOpen:application,stopHint,stopLabel:selectedId||instances.length===1?'结束此实例':checkedIds.length?'结束所选实例':'结束全部实例',
    canQuit:application&&(selectedId?!!instance&&!!state?.quitInstances?.includes(selectedId):!!state?.canQuit||(state?.quitInstances?.length??0)>1),
    quitLabel:selectedId?'正常退出此实例':(state?.quitInstances?.length??0)>1?'选择实例退出':'正常退出应用',
    contextKind,contextLabel:contextKind==='arc'?'标签页':contextKind==='codex'?'对话与任务':undefined};
}
export function widgetRows(snapshot:StatusSnapshot|undefined,config:Config={}) {
  const sort=config.sort==='cpu'?'cpu':config.sort==='memory'?'rss':'footprint';
  const value=(row:StatusSnapshot['rows'][number])=>config.sort==='accounting'?row.systemAccounting?.footprint:row.values[sort];
  const rows=[...(snapshot?.rows??[])].filter(row=>!config.groupId||row.id===config.groupId)
    .sort((a,b)=>(value(b)??-1)-(value(a)??-1)||a.id.localeCompare(b.id));
  const limit=typeof config.limit==='number'&&Number.isFinite(config.limit)?Math.max(3,Math.min(10,Math.floor(config.limit))):5;
  return config.display==='top'?rows.slice(0,limit):rows;
}
export function sampleScriptActivity():ScriptActivity {
  const at=Date.now();
  const owner={pid:100,started:(at-600000)*1000,uid:501,executable:'/Applications/FlowHub.app/Contents/MacOS/flowhub-tauri',name:'FlowHub',appPath:'/Applications/FlowHub.app'};
  const script={pid:101,started:(at-30000)*1000,uid:501,executable:'/usr/bin/osascript',name:'osascript',appPath:null};
  return {at,system:{},memoryMetric:'footprint',interval:5,records:[
    {id:'preview-running',process:script,chain:[owner,script],responsible:owner,source:{name:'FlowHub',appPath:owner.appPath,evidence:'已核验当前父进程链'},chainNote:'',firstSeen:at-25000,lastSeen:at,running:true},
    {id:'preview-recent',process:{...script,pid:99,started:(at-120000)*1000},chain:[{...script,pid:99,started:(at-120000)*1000}],responsible:null,source:null,chainNote:'父链到达 launchd；更早的启动来源不可追溯。',firstSeen:at-120000,lastSeen:at-60000,running:false},
  ]};
}
export const processKey=(p:Identity)=>`${p.pid}:${p.started}:${p.uid}:${p.executable}`;
export function contextRows(contexts:PageContexts,snapshot:{groups:readonly {processes:readonly Process[]}[]}|undefined,now=Date.now()) {
  const current=new Map((snapshot?.groups??[]).flatMap(g=>g.processes).map(p=>[processKey(p),p]));
  const expired=now-(contexts.diagnostics?.at??contexts.at)>=300000;
  return contexts.entries.map(entry=>{
    const identities=[...new Map(entry.processes.map(p=>[processKey(p),p])).values()];
    const processes=expired?[]:identities.flatMap(id=>{const process=current.get(processKey(id));return process?[process]:[];});
    const sum=(key:'memory'|'footprint'|'cpu')=>{const values=processes.flatMap(p=>p[key]==null?[]:[p[key]!]);return values.length?values.reduce((a,b)=>a+b,0):null;};
    return {...entry,liveProcesses:processes,memory:sum('memory'),footprint:sum('footprint'),cpu:sum('cpu'),expired,
      incomplete:processes.length!==identities.length||processes.some(p=>p.memory==null||p.footprint==null),
      state:expired?'映射已过期':!identities.length?'未关联':!processes.length?'进程已退出':entry.shared?'共享进程':entry.ambiguous?'同名标签':processes.length<identities.length?'部分已退出':'已关联'};
  });
}
export type ContextRow=ReturnType<typeof contextRows>[number];
export function sampleContexts(kind:'arc'|'codex',snapshot=sampleSnapshot()):PageContexts {
  const group=snapshot.groups.find(g=>g.id===(kind==='arc'?'app:arc':'app:codex'))!,p=group.processes[kind==='arc'?1:2];
  const entry=(id:string,title:string,processes:Identity[],shared=false):ContextEntry=>({id,title,detail:kind==='codex'?'/Users/demo/projects/flowhub':'普通窗口标签',token:id,processes,source:kind==='codex'?'CODEX_THREAD_ID':'Arc 任务管理器',shared,ambiguous:false});
  return {kind,mapping:'process-linked',at:snapshot.at,unmappedProcesses:2,diagnostics:{state:'ready',at:snapshot.at,hint:kind==='codex'?'模拟对话子进程关联，不包含共享界面内存。':'模拟任务管理器映射，同一 PID 不重复相加。'},hint:'只读模拟关联数据；未关联不代表零占用。',entries:[entry('demo-1','FlowHub 应用资源监控',[p],kind==='arc'),entry('demo-2','开发与调试',kind==='arc'?[p]:[],kind==='arc')]};
}
export const bytes = (value:number|null|undefined) => {
  if (value == null || !Number.isFinite(value)) return '—';
  return value >= 1073741824 ? `${(value/1073741824).toFixed(2)} GiB` : `${(value/1048576).toFixed(0)} MiB`;
};
export function accountingDisplay(group:Pick<Partial<Group>,'appPath'|'origin'|'systemAccounting'>) {
  const reference='系统资源组账本可包含独立任务和已退出任务的记账余额；仅作应用级参考，不代表可释放内存。';
  if(!group.appPath||group.origin)return {available:false,text:'不适用',hint:'独立进程或任务按活跃进程统计，不借用来源应用的系统归属记账。'};
  const value=group.systemAccounting?.footprint;
  if(value!=null&&Number.isFinite(value)&&value>=0)return {available:true,text:bytes(value),hint:reference};
  if(group.systemAccounting)return {available:false,text:'暂不可读',hint:'已找到应用资源组，但本次未能读取完整记账；稍后采样会重试。'};
  return {available:false,text:'未获取',hint:'尚未取得运行中主程序的资源组；可能仅有后台组件，或应用主程序无法核验。'};
}
export const cpu = (value:number|null|undefined) => value == null || !Number.isFinite(value) ? '采样中' : `${value.toFixed(1)}%`;
export const processName = (p:Process) => p.displayName || p.name;
export function matchesProcess(p:Process,q:string) {
  return [p.name,p.displayName??'',p.executable,p.launchExecutable??'',p.terminalOwner?.executable??'',p.cwd,p.parentName,String(p.pid),String(p.ppid),p.avd,p.runtimeProject?.name??'',p.runtimeProject?.root??'',p.runtimeProject?.entry??''].some(s=>s.toLocaleLowerCase().includes(q));
}
export function matchesGroup(g:Omit<Group,'processes'|'instances'>,q:string) {
  return [g.name,g.source,g.appPath??'',g.origin?.name??'',g.origin?.appPath??'',g.presentation?.name??'',...(g.presentation?.sources??[]).flatMap(source=>[source.name,source.appPath??'']),...(g.presentation?.services??[]).flatMap(service=>[service.name,service.label])].some(s=>s.toLocaleLowerCase().includes(q));
}
function sortGroups<T extends Pick<Group,'id'|'memory'|'footprint'|'cpu'|'systemAccounting'>>(groups:T[],sort:Sort,order:'ascend'|'descend') {
  const value=(g:T)=>sort==='accounting'?g.systemAccounting?.footprint:g[sort];
  return groups.sort((a,b)=>{const left=value(a),right=value(b);if(left==null||right==null)return left==null?(right==null?a.id.localeCompare(b.id):1):-1;return (order==='ascend'?left-right:right-left)||a.id.localeCompare(b.id);});
}
export function filterGroups(groups:Group[],query:string,system:boolean,sort:Sort,order:'ascend'|'descend'='descend') {
  const q=query.trim().toLocaleLowerCase();
  return sortGroups(groups.filter(g=>(system||!g.system)&&(!q||matchesGroup(g,q)||g.processes.some(p=>matchesProcess(p,q)))),sort,order);
}
export function filterRanking(groups:GroupSummary[],query:string,matchedGroupIds:readonly string[],system:boolean,sort:Sort,order:'ascend'|'descend'='descend') {
  const q=query.trim().toLocaleLowerCase(),matched=new Set(matchedGroupIds);
  // Backend matches include all process/project/service fields. Locally resolved
  // application names and descriptions remain searchable as well.
  return sortGroups(groups.filter(g=>(system||!g.system)&&(!q||matched.has(g.id)||matchesGroup(g,q))),sort,order);
}
export function rankingFrom(snapshot:Snapshot,query='',includeSystem=true):RankingSnapshot {
  const q=query.trim().toLocaleLowerCase();
  const groups=snapshot.groups.map(({processes,instances,presentation,...group}):GroupSummary=>({...group,
    presentation:presentation?{name:presentation.name,sources:presentation.sources}:presentation,
    processCount:processes.length,instanceCount:instances?.length??0,onlyInstanceId:instances?.length===1?instances[0].id:null,
    permissionLimited:processes.length>0&&processes.every(p=>p.protection.startsWith('当前用户权限不足')),
    hasRestrictedProcesses:processes.some(p=>p.uid===0||p.protection.includes('其他用户')||p.protection.startsWith('当前用户权限不足'))}));
  return {...snapshot,groups:groups.filter(g=>includeSystem||!g.system),includeSystem,hasRestrictedProcesses:groups.some(g=>g.hasRestrictedProcesses),query:q,matchedGroupIds:q?filterGroups(snapshot.groups,q,true,'footprint').map(g=>g.id):[]};
}
export function detailFrom(snapshot:Snapshot,groupId:string,trackedPids:readonly number[]=[],contextPids:readonly number[]=[]):GroupDetail {
  const tracked=new Set(trackedPids),contexts=new Set(contextPids),other=snapshot.groups.filter(g=>g.id!==groupId).flatMap(g=>g.processes);
  return {at:snapshot.at,revision:snapshot.revision,sampling:snapshot.sampling,stale:snapshot.stale,system:snapshot.system,error:snapshot.error,memoryMetric:snapshot.memoryMetric,interval:snapshot.interval,
    groupId,group:snapshot.groups.find(g=>g.id===groupId)??null,elsewhere:other.filter(p=>tracked.has(p.pid)).map(({pid,started,uid,executable})=>({pid,started,uid,executable})),contextProcesses:other.filter(p=>contexts.has(p.pid))};
}
export function newerSnapshot(next:{at:number;revision?:number},previous:{at:number;revision?:number}|undefined) {
  return !previous||(next.revision!=null&&previous.revision!=null?next.revision>=previous.revision:next.at>=previous.at);
}
export function updateDetail(previous:Group,latest:Group|undefined,live:readonly (Identity&{groupId?:string})[]=[]):Group {
  const key=processKey;
  const elsewhere=new Set(live.filter(p=>p.groupId!==previous.id).map(key));
  const fresh=new Map((latest?.processes??[]).map(p=>[key(p),p]));
  const processes=previous.processes.map(p=>{const current=fresh.get(key(p));fresh.delete(key(p));return current?{...current,exited:false,moved:false}:elsewhere.has(key(p))?{...p,exited:false,moved:true,protected:true,protection:'已移到其他分组，请重新打开对应条目',memory:null,footprint:null,cpu:null}:{...p,exited:true,moved:false,memory:null,footprint:null,cpu:null};});
  return {...(latest??previous),systemAccounting:latest?.systemAccounting??null,memory:latest?.memory??null,footprint:latest?.footprint??null,cpu:latest?.cpu??null,canTerminate:latest?.canTerminate??false,instances:latest?.instances??[],processes:[...processes,...fresh.values()]};
}
export function statusFrom(snapshot:Snapshot):StatusSnapshot {
  return {at:snapshot.at,system:snapshot.system,error:snapshot.error,rows:snapshot.groups.filter(g=>!g.system).map(g=>({id:g.id,name:g.name,systemAccounting:g.systemAccounting,appPath:g.appPath,origin:g.origin,iconKey:g.iconKey,presentation:g.presentation?{name:g.presentation.name,sources:g.presentation.sources}:undefined,at:snapshot.at,status:'healthy',summary:`${bytes(g.footprint)} 活跃足迹 · CPU ${cpu(g.cpu)}`,values:{memory:g.memory,footprint:g.footprint,rss:g.memory,cpu:g.cpu},count:g.processes.length,instanceCount:g.instances?.length,incomplete:g.footprintIncomplete}))};
}
export function sampleSnapshot():Snapshot {
  const appPath=(processes:Process[])=>{const exe=processes.find(p=>p.executable.includes('.app/'))?.executable;return exe?exe.split('.app/')[0]+'.app':null;};
  const make=(pid:number,name:string,executable:string,memory:number,ppid=1,role='进程'):Process=>({pid,ppid,name,executable,memory,footprint:Math.round(memory*1.7),cpu:pid%10+0.2,started:1700000000000000+pid,uid:501,cwd:'/Users/demo/projects/mobile-automation',role,avd:'',protected:false,protection:'',parentName:'Codex',groupId:'',attribution:'应用包路径'});
  const definitions:Array<[string,string,string,Process[]]>=[
    ['app:codex','Codex','应用包及子进程',[make(400,'Codex','/Applications/Codex.app/Contents/MacOS/Codex',490000000),make(401,'Codex Helper (Renderer)','/Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper',1650000000,400,'渲染进程'),make(402,'node','/Applications/Codex.app/Contents/Resources/node',260000000,400,'后台服务')]],
    ['app:arc','Arc','应用包路径',[make(470,'Arc','/Applications/Arc.app/Contents/MacOS/Arc',220000000),make(471,'Arc Helper (Renderer)','/Applications/Arc.app/Contents/Frameworks/Arc Helper.app/Contents/MacOS/Arc Helper',624000000,470,'渲染进程')]],
    ['android:410','Android 模拟器 · Pixel_Test','Android SDK · 可执行路径识别',[{...make(410,'qemu-system-aarch64-headless','/Users/demo/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64-headless',1420000000,400,'虚拟机'),avd:'Pixel_Test',attribution:'路径识别'}]],
    ['app:qq','QQ','应用包路径',[make(420,'QQ','/Applications/QQ.app/Contents/MacOS/QQ',390000000),make(421,'QQ Helper','/Applications/QQ.app/Contents/Frameworks/QQ Helper.app/Contents/MacOS/QQ Helper',480000000,420,'渲染进程')]],
    ['app:safari','Safari','应用包路径',[make(430,'Safari','/Applications/Safari.app/Contents/MacOS/Safari',560000000)]],
    ['app:flowhub','FlowHub','应用包路径',[{...make(440,'FlowHub','/Applications/FlowHub.app/Contents/MacOS/FlowHub',98000000),protected:true,protection:'FlowHub 及其宿主进程'}]],
    ['tool:unknown','background-worker','独立进程 · 可执行路径',[make(450,'background-worker','/usr/local/bin/background-worker',54000000)]],
    ['system:windowserver','WindowServer','系统进程',[{...make(460,'WindowServer','/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer',670000000),protected:true,protection:'系统进程',uid:88}]],
  ];
  const groups=definitions.map(([id,name,source,processes])=>({id,name,source,processes:processes.map(p=>({...p,groupId:id})),memory:processes.reduce((s,p)=>s+(p.memory??0),0),footprint:processes.reduce((s,p)=>s+(p.footprint??0),0),footprintIncomplete:false,appPath:appPath(processes),cpu:processes.reduce((s,p)=>s+(p.cpu??0),0),system:id.startsWith('system:'),canTerminate:processes.every(p=>!p.protected),incomplete:false}));
  return {at:Date.now(),groups,system:{totalMemory:34359738368,swapUsed:810000000,pressure:'normal'},memoryMetric:'footprint',interval:5};
}
