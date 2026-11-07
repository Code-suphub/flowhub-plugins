import {useEffect,useState} from 'react';
import {Button,HelpPopover} from '@flowhub/plugin-common/react';
import type {Api} from './api';
import {time} from './model';

type Sample={status:'read';sampledAt:number;cpuPercent:number|null;memory:{usedKiB:number;totalKiB:number}|null};
type Reply=Sample|{status:'pending'}|{status:'unavailable';error:string};
const gib=(kib:number)=>(kib/1024**2).toFixed(1);

export function AdbPerformance({api,id}:{api:Api;id:string}) {
 const [attempt,setAttempt]=useState(0);
 const [reply,setReply]=useState<Reply>({status:'pending'});
 useEffect(()=>{
  if(api.preview)return;
  let active=true,timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=Date.now()+6500;
  async function poll(refresh=false) {
   try {
    const value=await api.request<Reply>('adb_performance',{id,refresh});
    if(!active)return;
    if(value.status!=='pending'){setReply(value);return;}
    if(Date.now()>=deadline)throw Error('采样等待超时，请重试');
    timer=setTimeout(()=>void poll(),250);
   } catch(error){
    if(active)setReply({status:'unavailable',error:error instanceof Error?error.message:'无法读取设备性能'});
   }
  }
  void poll(attempt>0);
  return ()=>{active=false;clearTimeout(timer);};
 },[api,id,attempt]);
 if(api.preview)return null;
 const busy=reply.status==='pending';
 const sample=reply.status==='read'?reply:null;
 const memory=sample?.memory;
 return <section className="my-3" aria-label="设备性能">
  <div className="mb-1 flex items-center justify-between gap-2">
   <div className="flex items-center gap-1"><h4 className="text-[11px] font-semibold">设备性能</h4><HelpPopover label="设备性能说明">CPU 为一次短采样期间的全核使用率。内存已用量按总量减去系统报告的可用量计算。</HelpPopover></div>
   <Button className="dc-button" disabled={busy} onClick={()=>{setReply({status:'pending'});setAttempt(value=>value+1);}}>重新采样</Button>
  </div>
  {sample?<><dl className="dc-detail-facts">
   <div><dt>CPU 使用率</dt><dd>{sample.cpuPercent==null?'未提供':sample.cpuPercent+'%'}</dd></div>
   <div><dt>内存占用</dt><dd>{memory?`${gib(memory.usedKiB)} / ${gib(memory.totalKiB)} GiB`:'未提供'}</dd></div>
  </dl><p className="dc-detail-note">采样于 {time(sample.sampledAt)}</p></>:<p className="dc-detail-note" role="status">{reply.status==='unavailable'?reply.error:'正在读取 CPU 和内存…'}</p>}
 </section>;
}
