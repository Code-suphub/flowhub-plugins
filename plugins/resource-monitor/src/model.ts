import type {ApplicationState,Config,ContextEntry,Group,Identity,PageContexts,Process,Snapshot,StatusSnapshot,Sort} from './types';

export function detailControls(group:Group|undefined,state?:ApplicationState,selectedId?:string) {
  const instances=group?.instances??[];
  const instance=selectedId?instances.find(item=>item.id===selectedId):instances.length===1?instances[0]:undefined;
  const chooseInstance=!selectedId&&instances.length>1;
  const application=!!group?.appPath&&!group.origin;
  const contextKind=application&&(state?.contextKind==='arc'||state?.contextKind==='codex')?state.contextKind:null;
  const canStop=chooseInstance||!!instance?.canTerminate;
  const stopHint=selectedId&&!instance?'所选运行实例已退出，请重新选择。':!instances.length?'当前没有仍在运行的实例。':!chooseInstance&&!canStop?'此实例含受保护进程，可在进程列表中查看允许单独处理的进程。':
    !application?'独立进程可通过“结束此实例”停止；确认框会先列出本次目标进程。':'';
  return {instance,chooseInstance,canStop,canOpen:application,stopHint,stopLabel:chooseInstance?'选择实例结束':'结束此实例',
    canQuit:application&&(selectedId?!!instance&&!!state?.quitInstances?.includes(selectedId):!!state?.canQuit||(state?.quitInstances?.length??0)>1),
    quitLabel:selectedId?'正常退出此实例':(state?.quitInstances?.length??0)>1?'选择实例退出':'正常退出应用',
    contextKind,contextLabel:contextKind==='arc'?'标签页':contextKind==='codex'?'对话与任务':undefined};
}
export function widgetRows(snapshot:StatusSnapshot|undefined,config:Config={}) {
  const sort=config.sort==='cpu'?'cpu':config.sort==='memory'?'rss':'footprint';
  const rows=[...(snapshot?.rows??[])].filter(row=>!config.groupId||row.id===config.groupId)
    .sort((a,b)=>(b.values[sort]??-1)-(a.values[sort]??-1)||a.id.localeCompare(b.id));
  const limit=typeof config.limit==='number'&&Number.isFinite(config.limit)?Math.max(3,Math.min(10,Math.floor(config.limit))):5;
  return config.display==='top'?rows.slice(0,limit):rows;
}
export const processKey=(p:Identity)=>`${p.pid}:${p.started}:${p.uid}:${p.executable}`;
export function contextRows(contexts:PageContexts,snapshot:Snapshot|undefined,now=Date.now()) {
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
export const cpu = (value:number|null|undefined) => value == null || !Number.isFinite(value) ? '采样中' : `${value.toFixed(1)}%`;
export const processName = (p:Process) => p.displayName || p.name;
export function matchesProcess(p:Process,q:string) {
  return [p.name,p.displayName??'',p.executable,p.launchExecutable??'',p.terminalOwner?.executable??'',p.cwd,p.parentName,String(p.pid),String(p.ppid),p.avd,p.runtimeProject?.name??'',p.runtimeProject?.root??'',p.runtimeProject?.entry??''].some(s=>s.toLocaleLowerCase().includes(q));
}
export function filterGroups(groups:Group[],query:string,system:boolean,sort:Sort,order:'ascend'|'descend'='descend') {
  const q=query.trim().toLocaleLowerCase();
  return groups.filter(g=>(system||!g.system)&&(!q||[g.name,g.source,g.origin?.name??'',g.origin?.appPath??'',g.presentation?.name??'',...(g.presentation?.sources??[]).flatMap(source=>[source.name,source.appPath??'']),...(g.presentation?.services??[]).flatMap(service=>[service.name,service.label])].some(s=>s.toLocaleLowerCase().includes(q))||g.processes.some(p=>matchesProcess(p,q))))
    .sort((a,b)=>{
      const left=a[sort],right=b[sort];
      if(left==null||right==null)return left==null?(right==null?a.id.localeCompare(b.id):1):-1;
      return (order==='ascend'?left-right:right-left)||a.id.localeCompare(b.id);
    });
}
export function updateDetail(previous:Group,latest:Group|undefined,live:readonly Process[]=[]):Group {
  const key=processKey;
  const elsewhere=new Set(live.filter(p=>p.groupId!==previous.id).map(key));
  const fresh=new Map((latest?.processes??[]).map(p=>[key(p),p]));
  const processes=previous.processes.map(p=>{const current=fresh.get(key(p));fresh.delete(key(p));return current?{...current,exited:false,moved:false}:elsewhere.has(key(p))?{...p,exited:false,moved:true,protected:true,protection:'已移到其他分组，请重新打开对应条目',memory:null,footprint:null,cpu:null}:{...p,exited:true,moved:false,memory:null,footprint:null,cpu:null};});
  return {...(latest??previous),memory:latest?.memory??null,footprint:latest?.footprint??null,cpu:latest?.cpu??null,canTerminate:latest?.canTerminate??false,instances:latest?.instances??[],processes:[...processes,...fresh.values()]};
}
export function statusFrom(snapshot:Snapshot):StatusSnapshot {
  return {at:snapshot.at,system:snapshot.system,error:snapshot.error,rows:snapshot.groups.filter(g=>!g.system).map(g=>({id:g.id,name:g.name,appPath:g.appPath,origin:g.origin,iconKey:g.iconKey,presentation:g.presentation?{name:g.presentation.name,sources:g.presentation.sources}:undefined,at:snapshot.at,status:'healthy',summary:`${bytes(g.footprint)} 足迹 · CPU ${cpu(g.cpu)}`,values:{memory:g.memory,footprint:g.footprint,rss:g.memory,cpu:g.cpu},count:g.processes.length,instanceCount:g.instances?.length,incomplete:g.footprintIncomplete}))};
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
