import {useEffect,useRef,useState} from 'react';
import {Button,Checkbox,HelpPopover} from '@flowhub/plugin-common/react';
import type {Api} from './api';
type Reply={status:'idle'|'running'|'success'|'failed'|'deferred';stage?:string;error?:string;identityVerified?:boolean;autoEnabled?:boolean;automatic?:{reason?:string;attempts?:number;maxAttempts?:number}};
const reasons:Record<string,string>={'online':'ADB 在线','waiting-offline':'等待持续离线','cooldown':'等待下次尝试','exhausted':'自动尝试已达上限','viewing':'正在远控，暂缓恢复','phone-busy':'手机忙，等待空闲','foreground-unknown':'等待确认手机空闲','user-active':'手机正在使用','manual-required':'需要检查绑定、授权或解锁','bridge-offline':'等待 Phone Bridge 上线','upgrade-required':'请升级手机 Phone Bridge','awaiting-scan':'等待连接检查','storage-error':'自动恢复状态保存失败','start-failed':'自动恢复未能启动','recovering':'正在自动恢复'};
const stages:Record<string,string>={'connecting-phone':'连接 Phone Bridge','wake':'点亮手机','easytier':'确认 EasyTier 网络','wireless-settings':'打开无线调试','wireless-enable':'开启无线调试','wireless-port':'读取连接端口','phone-ready':'手机准备完成','connecting-adb':'恢复电脑连接','verifying-adb':'核对手机身份','ready':'ADB 已恢复'};
export function PhoneRecovery({api,id,available,disabled,onBusy}:{api:Api;id:string;available:boolean;disabled:boolean;onBusy:(value:boolean)=>void}) {
 const [reply,setReply]=useState<Reply>({status:'idle'}),[error,setError]=useState(''),[pending,setPending]=useState(false),[configSaving,setConfigSaving]=useState(false);
 const mounted=useRef(true),requesting=useRef(false),generation=useRef(0),busyCallback=useRef(onBusy);busyCallback.current=onBusy;
 useEffect(()=>{mounted.current=true;if(!api.preview){const version=generation.current;void api.request<Reply>('phone_recovery_status',{id}).then(r=>{if(mounted.current&&generation.current===version)setReply(r);}).catch(()=>{});}return()=>{mounted.current=false;busyCallback.current(false);};},[api,id]);
 useEffect(()=>{busyCallback.current(pending||configSaving||reply.status==='running');},[pending,configSaving,reply.status]);
 useEffect(()=>{
  if((reply.status!=='running'&&!reply.autoEnabled)||api.preview)return;
  let alive=true,inflight=false;
  const poll=async()=>{if(inflight)return;inflight=true;try{const next=await api.request<Reply>('phone_recovery_status',{id});if(alive){setReply(next);setError('');}}catch(e){if(alive)setError(e instanceof Error?e.message:'无法读取恢复进度');}finally{inflight=false;}};
  const timer=setInterval(()=>void poll(),reply.status==='running'?900:10000);void poll();return()=>{alive=false;clearInterval(timer);};
 },[api,id,reply.status,reply.autoEnabled]);
 async function start(){if(requesting.current||api.preview||!available||reply.status==='running')return;requesting.current=true;generation.current++;setPending(true);setError('');
  try{const r=await api.request<Reply>('phone_recover',{id});if(mounted.current)setReply(previous=>({...previous,...r}));}catch(e){if(mounted.current)setError(e instanceof Error?e.message:'无法启动恢复');}finally{requesting.current=false;if(mounted.current)setPending(false);}
 }
 async function configure(enabled:boolean){if(configSaving||api.preview)return;setConfigSaving(true);setError('');try{const r=await api.request<Reply>('phone_auto_recovery',{id,enabled});if(mounted.current)setReply(previous=>({...previous,...r}));}catch(e){if(mounted.current)setError(e instanceof Error?e.message:'无法保存自动恢复设置');}finally{if(mounted.current)setConfigSaving(false);}}
 return <div className="flex max-w-[240px] flex-col gap-1" aria-label="ADB 恢复">
  <div className="flex items-center gap-1"><Button className="dc-button" data-phone-recover disabled={api.preview||disabled||!available||pending||reply.status==='running'} onClick={()=>void start()}>{pending||reply.status==='running'?'恢复中…':'恢复 ADB'}</Button><HelpPopover label="ADB 恢复说明">通过 Phone Bridge 打开手机上的 EasyTier 和无线调试，再连接这台已配对手机。会切换手机前台，通常需要几十秒。优先使用上海中转，适合私网或调试连接失效时恢复。需要既有配对和设备绑定；身份核验通过才报告成功，不会重新配对或操作其他手机。</HelpPopover></div>
  <div className="flex items-center gap-1"><Checkbox label="自动恢复" checked={reply.autoEnabled??false} disabled={api.preview||!available||configSaving} onChange={value=>void configure(value)} containerClassName="min-h-6 gap-1 text-[11px]" className="h-3.5 w-3.5"/><HelpPopover label="自动恢复规则">Flowhub 运行期间每 30 秒检查，持续离线 90 秒后在手机空闲时恢复。失败后间隔 5 分钟，每次离线最多尝试 3 次。正在远控、前台有其他应用或需要密码解锁时等待。关闭开关停止后续自动触发，进行中的恢复会完成当前流程。</HelpPopover></div>
  {reply.autoEnabled&&reply.status!=='running'?<p className="dc-detail-note" data-auto-recovery-state role="status">{reasons[reply.automatic?.reason||'']||'自动监测中'}{(reply.automatic?.attempts||0)>0?' · '+reply.automatic?.attempts+'/'+(reply.automatic?.maxAttempts||3):''}</p>:null}
  {reply.status==='running'?<p className="dc-detail-note" role="status">{stages[reply.stage||'']||'正在恢复…'}</p>:reply.status==='success'&&reply.identityVerified?<p className="dc-detail-note" role="status">ADB 已恢复，手机身份已核对</p>:null}
  {error||reply.error?<p className="dc-warning" role="alert">{error||reply.error}</p>:null}
 </div>;
}
