import {useEffect,useRef,useState} from 'react';
import {Button,HelpPopover} from '@flowhub/plugin-common/react';
import type {Api} from './api';
import {Icon} from './Icons';

type Reply={status:'idle'|'connecting'|'starting'|'running'|'stopping'|'failed';route?:string|null;error?:string|null};
const active=(status:Reply['status'])=>['connecting','starting','running','stopping'].includes(status);

export function AdbMirror({api,id,unauthorized=false}:{api:Api;id:string;unauthorized?:boolean}) {
 const [reply,setReply]=useState<Reply>({status:'idle'});
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const mounted=useRef(true),pending=useRef(false),generation=useRef(0);
 useEffect(()=>{
  mounted.current=true;
  if(api.preview)return ()=>{mounted.current=false;};
  let timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{
   const version=generation.current;
   try{const next=await api.request<Reply>('adb_mirror_status',{id});if(mounted.current&&!pending.current&&generation.current===version)setReply(next);}
   catch(e){if(mounted.current&&!pending.current&&generation.current===version)setError(e instanceof Error?e.message:'无法读取投屏状态');}
   if(mounted.current)timer=setTimeout(()=>void poll(),1000);
  };
  void poll();
  return ()=>{mounted.current=false;clearTimeout(timer);};
 },[api,id]);
 async function act(method:'adb_mirror_start'|'adb_mirror_stop') {
  if(pending.current||api.preview)return;
  pending.current=true;generation.current++;setBusy(true);setError('');
  try{const next=await api.request<Reply>(method,{id});if(mounted.current)setReply(next);}
  catch(e){if(mounted.current)setError(e instanceof Error?e.message:'投屏操作失败');}
  finally{pending.current=false;if(mounted.current)setBusy(false);}
 }
 const working=active(reply.status);
 const status=reply.status==='connecting'?'正在检查可用线路…':reply.status==='starting'?'正在等待视频…':reply.status==='running'?'投屏窗口已打开':reply.status==='stopping'?'正在关闭投屏…':'';
 return <section className="min-w-0 max-w-[45%] shrink-0" aria-label="手机投屏">
  <div className="flex flex-wrap items-center justify-between gap-2">
   <HelpPopover label="手机投屏说明">在本机 scrcpy 窗口查看和操作所选手机。自动检查 USB、在线主线路和已登记的备用线路，连接前核对手机身份。首次使用需在手机开启调试并完成配对。受保护的登录或支付页面可能显示黑屏。关闭详情后投屏继续运行；关闭投屏窗口或点击结束投屏即可停止。</HelpPopover>
   <div className="flex items-center gap-2">
    {working?<Button className="dc-button" data-mirror-stop disabled={busy||reply.status==='stopping'} onClick={()=>void act('adb_mirror_stop')}>结束投屏</Button>:<Button className="dc-button" data-mirror-start disabled={api.preview||busy||unauthorized} onClick={()=>void act('adb_mirror_start')}><Icon name="display"/>{busy?'正在连接…':'投屏'}</Button>}
   </div>
  </div>
  {api.preview?<p className="dc-detail-note">只读预览不连接手机</p>:unauthorized?<p className="dc-warning" role="status">请先在手机上确认调试授权，然后刷新设备。</p>:null}
  {status?<p className="dc-detail-note" role="status">{status}{reply.route?' · '+reply.route:''}</p>:null}
  {error||reply.error?<p className="dc-warning" role="alert">{error||reply.error}</p>:null}
 </section>;
}
