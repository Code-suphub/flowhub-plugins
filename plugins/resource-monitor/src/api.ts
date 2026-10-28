import {sampleContexts,sampleSnapshot,statusFrom} from './model';
import type {Api,Config,Context} from './types';

export function createApi(host:Window):Api {
  const surface=host.document.body.dataset.surface;
  const widget=surface!=='main';
  const token=new URLSearchParams(host.location.hash.slice(1)).get('flowhubWidgetToken');
  let context:Context|undefined,disposed=false,editor:(()=>Config)|undefined;
  const hosted=host.parent!==host;
  const listeners=new Set<(context:Context)=>void>();
  const pending=new Map<string,{resolve(value:unknown):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>();
  let sequence=0;
  const requestId=()=>host.crypto.randomUUID?.()??`resource-${Date.now()}-${++sequence}`;
  function send(message:object) {host.parent.postMessage({...message,...(widget?{token}:{})},'*');}
  function receive(event:MessageEvent) {
    if(event.source!==host.parent||disposed)return;
    const d=event.data;
    if(!d||typeof d!=='object'||(widget&&(!token||d.token!==token)))return;
    if(widget&&d.type==='flowhub:widget-init') {context=d.context;listeners.forEach(fn=>fn(context??{}));}
    if(d.type===(widget?'flowhub:widget-result':'flowhub:response')) {
      const item=pending.get(d.id);if(!item)return;
      pending.delete(d.id);clearTimeout(item.timer);d.error?item.reject(new Error(String(d.error))):item.resolve(d.result);
    }
    if(widget&&d.type==='flowhub:widget-save') {
      try {if(!editor)throw Error('配置未就绪');send({type:'flowhub:widget-config',id:d.id,config:editor()});}
      catch(e){send({type:'flowhub:widget-config',id:d.id,error:String(e)});}
    }
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
        if(method==='contexts')return Promise.resolve(sampleContexts(params.groupId==='app:arc'?'arc':'codex') as T);
        return Promise.reject(new Error('浏览器预览不执行清理操作'));
      }
      return new Promise<T>((resolve,reject)=>{
        const id=requestId(),timer=setTimeout(()=>{pending.delete(id);reject(new Error('插件响应超时，请刷新核实状态'));},20000);
        pending.set(id,{resolve:value=>resolve(value as T),reject,timer});
        try {send(widget?{type:'flowhub:widget-rpc',id,params:{action:'management',method,params}}:{type:'flowhub:request',id,method,params});}
        catch {clearTimeout(timer);pending.delete(id);reject(new Error('无法连接 FlowHub'));}
      });
    },
    async status(){
      if(disposed)throw new Error('插件连接已关闭');
      if(widget&&hosted&&token&&!context)throw new Error('组件上下文尚未就绪');
      if(api.preview)return statusFrom(sampleSnapshot());
      if(!widget)return statusFrom(await api.invoke('snapshot'));
      return new Promise((resolve,reject)=>{
        const id=requestId(),timer=setTimeout(()=>{pending.delete(id);reject(new Error('状态读取超时'));},20000);
        pending.set(id,{resolve:value=>resolve(value as Awaited<ReturnType<Api['status']>>),reject,timer});
        send({type:'flowhub:widget-rpc',id,params:{action:'snapshot'}});
      });
    },
    subscribe(fn){listeners.add(fn);if(context)fn(context);return()=>{listeners.delete(fn);};},
    editor(fn){editor=fn;},
    ready(){
      if(!widget)return;
      if(hosted&&token)send({type:'flowhub:widget-ready'});
      else {context={preview:true,config:{sort:'memory',limit:5},snapshot:statusFrom(sampleSnapshot())};listeners.forEach(fn=>fn(context!));}
    },
    navigate(groupId){if(!api.preview&&widget)send({type:'flowhub:widget-navigate',action:'detail',selection:groupId?{groupId}:{}});},
    dispose(){disposed=true;host.removeEventListener('message',receive);listeners.clear();for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('插件连接已关闭'));}pending.clear();}
  };
  return api;
}
