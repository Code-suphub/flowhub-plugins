import {demo} from './fixtures';
import type {Context} from './model';

export function createApi(host:Window,timeout=44_000) {
 const preview=host.parent===host;
 const widget=host.document.body.dataset.surface==='detail';
 const token=new URLSearchParams(host.location.hash.slice(1)).get('flowhubWidgetToken');
 const pending=new Map<string,{resolve:(result:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 const subscribers=new Set<(context:Context)=>void>();
 let context:Context={},ready=preview||!widget,closed=false,sequence=0;
 const scenario=preview?new URLSearchParams(host.location.search).get('scenario')||'':'';
 function receive(event:MessageEvent) {
  if(closed||event.source!==host.parent)return;
  const msg=event.data;if(!msg||typeof msg!=='object'||widget&&msg.token!==token)return;
  if(widget&&msg.type==='flowhub:widget-init') {context=msg.context||{};ready=true;subscribers.forEach(fn=>fn(context));return;}
  if(msg.type!==(widget?'flowhub:widget-result':'flowhub:response'))return;
  const entry=pending.get(msg.id);if(!entry)return;pending.delete(msg.id);clearTimeout(entry.timer);
  if(msg.error)entry.reject(Error(String(msg.error)));else entry.resolve(msg.result);
 }
 host.addEventListener('message',receive);
 function request<T>(method:string,params:Record<string,unknown>={}):Promise<T> {
  if(closed)return Promise.reject(Error('页面已关闭'));
  if(preview){if(method==='device_icons')return Promise.resolve({available:false,icons:{}} as T);if(method==='snapshot'||method==='refresh'||method==='adb_refresh')return Promise.resolve(demo(scenario) as T);return Promise.reject(Error('只读预览不执行设备操作'));}
  if(!ready)return Promise.reject(Error('等待组件初始化'));
  return new Promise((resolve,reject)=>{
   const id='dc-'+Date.now()+'-'+ ++sequence;
   const timer=setTimeout(()=>{pending.delete(id);reject(Error('设备响应超时，请重试'));},timeout);
   pending.set(id,{resolve:resolve as (result:unknown)=>void,reject,timer});
   host.parent.postMessage(widget?{type:'flowhub:widget-rpc',token,id,params:{action:'management',method,params}}:{type:'flowhub:request',id,method,params},'*');
  });
 }
 return {preview,widget,request,getContext:()=>context,
  onReady(fn:(context:Context)=>void){subscribers.add(fn);if(ready)fn(context);return ()=>{subscribers.delete(fn);};},
  start(){if(widget&&!preview&&token)host.parent.postMessage({type:'flowhub:widget-ready',token},'*');},
  dispose(){closed=true;host.removeEventListener('message',receive);subscribers.clear();for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(Error('页面已关闭'));}pending.clear();}
 };
}
export type Api=ReturnType<typeof createApi>;
