import type {ContextEntry,Group,Identity,PageContexts,Process,Snapshot,StatusSnapshot,Sort} from './types';
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
export function matchesProcess(p:Process,q:string) {
  return [p.name,p.executable,p.cwd,p.parentName,String(p.pid),String(p.ppid),p.avd].some(s=>s.toLocaleLowerCase().includes(q));
}
export function filterGroups(groups:Group[],query:string,system:boolean,sort:Sort) {
  const q=query.trim().toLocaleLowerCase();
  return groups.filter(g=>(system||!g.system)&&(!q||[g.name,g.source].some(s=>s.toLocaleLowerCase().includes(q))||g.processes.some(p=>matchesProcess(p,q))))
    .slice().sort((a,b)=>(b[sort]??-1)-(a[sort]??-1)||a.id.localeCompare(b.id));
}
export function updateDetail(previous:Group,latest:Group|undefined):Group {
  const key=(p:Process)=>`${p.pid}:${p.started}`;
  const fresh=new Map((latest?.processes??[]).map(p=>[key(p),p]));
  const processes=previous.processes.map(p=>{const current=fresh.get(key(p));fresh.delete(key(p));return current?{...current,exited:false}:{...p,exited:true,memory:null,footprint:null,cpu:null};});
  return {...(latest??previous),memory:latest?.memory??null,footprint:latest?.footprint??null,cpu:latest?.cpu??null,canTerminate:latest?.canTerminate??false,processes:[...processes,...fresh.values()]};
}
export function statusFrom(snapshot:Snapshot):StatusSnapshot {
  return {at:snapshot.at,system:snapshot.system,error:snapshot.error,rows:snapshot.groups.filter(g=>!g.system).map(g=>({id:g.id,name:g.name,at:snapshot.at,status:'healthy',summary:`${bytes(g.footprint)} 足迹 · CPU ${cpu(g.cpu)}`,values:{memory:g.memory,footprint:g.footprint,rss:g.memory,cpu:g.cpu},count:g.processes.length,incomplete:g.footprintIncomplete}))};
}
export function sampleSnapshot():Snapshot {
  const appPath=(processes:Process[])=>{const exe=processes.find(p=>p.executable.includes('.app/'))?.executable;return exe?exe.split('.app/')[0]+'.app':null;};
  const make=(pid:number,name:string,executable:string,memory:number,ppid=1,role='进程'):Process=>({pid,ppid,name,executable,memory,footprint:Math.round(memory*1.7),cpu:pid%10+0.2,started:1700000000000000+pid,uid:501,cwd:'/Users/demo/projects/mobile-automation',role,avd:'',protected:false,protection:'',parentName:'Codex',groupId:'',attribution:'应用包路径'});
  const definitions:Array<[string,string,string,Process[]]>=[
    ['app:codex','Codex','应用包及子进程',[make(400,'Codex','/Applications/Codex.app/Contents/MacOS/Codex',490000000),make(401,'Codex Helper (Renderer)','/Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper',1650000000,400,'渲染进程'),make(402,'node','/usr/local/bin/node',260000000,400,'后台服务')]],
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
