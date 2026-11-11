import {defaultRankingOrder,detailFrom,rankingFrom,sampleContexts,sampleScriptActivity,sampleSnapshot,statusFrom} from './model';
import type {Api,Config,Context,GroupDetail,RankingOrder} from './types';
import {RequestError,requestLabel} from './errors';

export function createApi(host:Window):Api {
  const surface=host.document.body.dataset.surface??'unknown';
  const widget=surface!=='main';
  const token=new URLSearchParams(host.location.hash.slice(1)).get('flowhubWidgetToken');
  let context:Context|undefined,disposed=false,editor:(()=>Config)|undefined;
  let previewIncludeSystem=false;
  let previewSorting=defaultRankingOrder;
  const hosted=host.parent!==host;
  const listeners=new Set<(context:Context)=>void>();
  type Request={resolve(value:unknown):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>;method:string;traceId:string;started:number;hidden:boolean};
  const pending=new Map<string,Request>(),expired=new Map<string,Pick<Request,'method'|'traceId'|'started'|'hidden'>>(),failed=new Set<string>();
  let sequence=0;
  const requestId=()=>host.crypto.randomUUID?.().replaceAll('-','')??`${Date.now().toString(16).padStart(12,'0')}${(++sequence%65536).toString(16).padStart(4,'0')}${Math.random().toString(16).slice(2).padEnd(16,'0').slice(0,16)}`;
  const metadata=(id:string)=>({traceId:id,surface});
  function requestError(message:string,item:Pick<Request,'method'|'traceId'|'started'>,code:string){return new RequestError(message,item.method,item.traceId,surface,item.started,Math.max(0,Date.now()-item.started),code);}
  function send(message:object) {host.parent.postMessage({...message,...(widget?{token}:{})},'*');}
  function diagnose(code:string,item:Pick<Request,'method'|'traceId'|'started'|'hidden'>,reason?:string){
    if(disposed||api.preview)return;
    const params={code,method:item.method,traceId:item.traceId,surface,elapsedMs:Math.max(0,Date.now()-item.started),hidden:!!host.document.hidden,hiddenAtStart:item.hidden,...(reason?{reason}:{})};
    // Best effort, with no pending request or retry. A broken transport must not
    // recursively report itself. Never include original params or error text.
    try{send(widget?{type:'flowhub:widget-rpc',id:requestId(),params:{action:'management',method:'diagnostic_event',params}}:{type:'flowhub:request',id:requestId(),method:'diagnostic_event',params});}catch{}
  }
  function timedOut(id:string,item:Request){
    pending.delete(id);expired.set(id,{method:item.method,traceId:item.traceId,started:item.started,hidden:item.hidden});if(expired.size>32)expired.delete(expired.keys().next().value!);
    const action=['terminate_confirm','quit_confirm','service_confirm','startup_set','startup_stop','finder_extension_set','script_observer_config','privileged_enable','privileged_disable','resource_history_settings'].includes(item.method);
    const message=action?'请求等待超时，操作结果尚未确认。请刷新核实状态，再决定是否重试。':`${requestLabel(item.method)}超时，请稍后刷新。`;
    failed.add(item.method);diagnose('timeout',item);item.reject(requestError(message,item,'timeout'));
  }
  function receive(event:MessageEvent) {
    if(event.source!==host.parent||disposed)return;
    const d=event.data;
    if(!d||typeof d!=='object'||(widget&&(!token||d.token!==token)))return;
    if(widget&&d.type==='flowhub:widget-init') {context=d.context;listeners.forEach(fn=>fn(context??{}));}
    if(d.type===(widget?'flowhub:widget-result':'flowhub:response')) {
      const item=pending.get(d.id);
      if(!item){const late=expired.get(d.id);if(late){expired.delete(d.id);diagnose('late_response',late);}return;}
      pending.delete(d.id);clearTimeout(item.timer);
      if(d.error){
        const text=String(d.error),reason=text.includes('组件刷新已暂停')?'paused':/插件进程已退出|插件连接已关闭|插件连接已断开/.test(text)?'backend_closed':text.includes('超时')?'timeout':/请求过多|操作过多/.test(text)?'busy':text.includes('数据过大')?'oversized':text.includes('采样版本已更新')?'revision_changed':'request_failed';
        failed.add(item.method);diagnose('response_error',item,reason);item.reject(requestError(text,item,reason));
      }
      else{if(failed.delete(item.method))diagnose('recovered',item);item.resolve(d.result);}
    }
    if(widget&&d.type==='flowhub:widget-save') {
      try {if(!editor)throw Error('配置未就绪');send({type:'flowhub:widget-config',id:d.id,config:editor()});}
      catch(e){send({type:'flowhub:widget-config',id:d.id,error:String(e)});}
    }
  }
  function widgetRequest<T>(method:string,params:object):Promise<T>{
    return new Promise((resolve,reject)=>{
      const id=requestId(),timer=setTimeout(()=>{const item=pending.get(id);if(item)timedOut(id,item);},20000);
      const item:Request={resolve:value=>resolve(value as T),reject,timer,method,traceId:id,started:Date.now(),hidden:!!host.document.hidden};pending.set(id,item);
      try{send({type:'flowhub:widget-rpc',id,params:{...params,_trace:metadata(id)}});}
      catch{clearTimeout(timer);pending.delete(id);failed.add(method);diagnose('send_failed',item);reject(requestError('无法连接 FlowHub',item,'send_failed'));}
    });
  }
  host.addEventListener('message',receive);
  const api:Api={
    // Native detail contexts omit preview; browser canvas/detail always set preview:true.
    get preview(){return !hosted||(widget&&(!token||!context||context.preview===true));},widget,
    invoke<T>(method:string,params:Record<string,unknown>={}) {
      if(disposed)return Promise.reject(new Error('插件连接已关闭'));
      if(widget&&hosted&&token&&!context)return Promise.reject(new Error('组件上下文尚未就绪'));
      if(api.preview){
        if(method==='snapshot'||method==='refresh')return Promise.resolve(sampleSnapshot() as T);
        if(method==='set_view_preferences'){
          if(typeof params.includeSystem==='boolean')previewIncludeSystem=params.includeSystem;
          if(params.sorting)previewSorting=params.sorting as RankingOrder;
        }
        if(method==='ranking_snapshot'||method==='refresh_summary'||method==='set_view_preferences')return Promise.resolve(rankingFrom({...sampleSnapshot(),sorting:previewSorting},String(params.query??''),typeof params.includeSystem==='boolean'?params.includeSystem:previewIncludeSystem) as T);
        if(method==='group_detail')return Promise.resolve(detailFrom(sampleSnapshot(),String(params.groupId??''),params.trackedPids as number[]|undefined,params.contextPids as number[]|undefined) as T);
        if(method==='resource_history')return Promise.resolve({groupId:params.groupId,hours:48,intervalSeconds:60,from:Date.now()-48*3600000,to:Date.now(),points:[],truncated:false,error:null} as T);
        if(method==='services_snapshot')return Promise.resolve({at:Date.now(),supported:true,services:[]} as T);
        if(method==='finder_extensions_snapshot')return Promise.resolve({rows:[
          {id:'example.finder',name:'文件同步扩展',appPath:'/Applications/Example.app',bundlePath:'/Applications/Example.app/Contents/PlugIns/Finder.appex',state:'enabled',runningCount:1,revision:null},
        ]} as T);
        if(method==='startup_snapshot')return Promise.resolve({rows:[
          {id:'homebrew.mxcl.mysql',name:'MySQL',kind:'mysql',state:'enabled'},
          {id:'com.microsoft.OneDriveLauncher',name:'OneDrive',kind:'onedrive',state:'disabled'},
        ]} as T);
        if(method==='script_observer_status')return Promise.resolve({supported:true,enabled:false,available:true,at:Date.now(),interval:1,records:sampleScriptActivity().records,observations:[]} as T);
        if(method==='script_activity')return Promise.resolve(sampleScriptActivity() as T);
        if(method==='contexts')return Promise.resolve(sampleContexts(params.groupId==='app:arc'?'arc':'codex') as T);
        if(method==='application_state')return Promise.resolve({canQuit:false,quitInstances:[],message:'预览模式不执行退出操作。',contextKind:params.groupId==='app:arc'?'arc':params.groupId==='app:codex'?'codex':null} as T);
        return Promise.reject(new Error('浏览器预览不执行清理操作'));
      }
      return new Promise<T>((resolve,reject)=>{
        const timeout=method==='privileged_enable'||method==='privileged_disable'?300000:20000;
        const id=requestId(),timer=setTimeout(()=>{const item=pending.get(id);if(item)timedOut(id,item);},timeout);
        const item:Request={resolve:value=>resolve(value as T),reject,timer,method,traceId:id,started:Date.now(),hidden:!!host.document.hidden};pending.set(id,item);
        try {send(widget?{type:'flowhub:widget-rpc',id,params:{action:'management',method,params,_trace:metadata(id)}}:{type:'flowhub:request',id,method,params:{...params,_trace:metadata(id)}});}
        catch {clearTimeout(timer);pending.delete(id);failed.add(method);diagnose('send_failed',item);reject(requestError('无法连接 FlowHub',item,'send_failed'));}
      });
    },
    async status(){
      if(disposed)throw new Error('插件连接已关闭');
      if(widget&&hosted&&token&&!context)throw new Error('组件上下文尚未就绪');
      if(api.preview)return statusFrom(sampleSnapshot());
      if(!widget)return api.invoke('status_snapshot');
      return widgetRequest<Awaited<ReturnType<Api['status']>>>('status_snapshot',{action:'snapshot'});
    },
    subscribe(fn){listeners.add(fn);if(context)fn(context);return()=>{listeners.delete(fn);};},
    editor(fn){editor=fn;},
    ready(){
      if(!widget)return;
      if(hosted&&token)send({type:'flowhub:widget-ready'});
      else {context={preview:true,config:{limit:5},snapshot:statusFrom(sampleSnapshot())};listeners.forEach(fn=>fn(context!));}
    },
    navigate(groupId){if(!api.preview&&widget)send({type:'flowhub:widget-navigate',action:'detail',selection:groupId?{groupId}:{}});},
    async saveCardConfig(patch){
      if(disposed||api.preview||surface!=='card'||!context?.canSaveConfig)throw Error('当前无法保存卡片设置');
      const result=await widgetRequest<{saved:boolean}>('configureCard',{action:'configureCard',patch});
      if(result?.saved!==true)throw Error('保存结果尚未确认');
    },
    dispose(){disposed=true;host.removeEventListener('message',receive);listeners.clear();for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('插件连接已关闭'));}pending.clear();expired.clear();failed.clear();}
  };
  return api;
}

// Keep detail requests below the native 64 KiB request limit, even after a very
// large group accumulates fixed historical rows. Only the first chunk includes
// group data; subsequent chunks must come from that same publication revision.
export async function readGroupDetail(api:Api,groupId:string,trackedPids:number[]=[],contextPids:number[]=[]):Promise<GroupDetail> {
  const tracked=new Set(trackedPids),contexts=new Set(contextPids),pids=[...new Set([...tracked,...contexts])];
  const chunks:Array<{trackedPids:number[];contextPids:number[]}>=[];
  for(let offset=0;offset<pids.length;offset+=2048){const chunk=pids.slice(offset,offset+2048);chunks.push({trackedPids:chunk.filter(pid=>tracked.has(pid)),contextPids:chunk.filter(pid=>contexts.has(pid))});}
  if(!chunks.length)chunks.push({trackedPids:[],contextPids:[]});
  for(let attempt=0;;attempt++){
    const first=await api.invoke<GroupDetail>('group_detail',{groupId,...chunks[0]});
    if(chunks.length===1)return first;
    try{
      const rest=await Promise.all(chunks.slice(1).map(chunk=>api.invoke<GroupDetail>('group_detail',{groupId,...chunk,includeGroup:false,revision:first.revision})));
      return {...first,elsewhere:[...first.elsewhere,...rest.flatMap(part=>part.elsewhere)],contextProcesses:[...first.contextProcesses,...rest.flatMap(part=>part.contextProcesses)]};
    }catch(error){if(attempt>=2||!String(error).includes('详情采样版本已更新'))throw error;}
  }
}
