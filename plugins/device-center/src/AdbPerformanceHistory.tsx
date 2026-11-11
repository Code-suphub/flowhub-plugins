import {useEffect,useRef,useState} from 'react';
import {Checkbox,EmptyState,HelpPopover,HistoryChart,Select,Tabs,TabsList,TabsPanel,TabsTrigger} from '@flowhub/plugin-common/react';
import type {Api} from './api';
import {time} from './model';

type Metric='cpu'|'memory'|'storage';
type Point={at:number;cpu:number|null;memory:[number,number]|null;storage:[number,number,number]|null};
type Report={deviceId:string;hours:number;enabled:boolean;intervalSeconds:number;from:number;to:number;points:Point[];error:string|null};
const metrics:[Metric,string][]=[['cpu','CPU'],['memory','内存'],['storage','存储']];
const retention=[{value:'48',label:'48 小时'},{value:'168',label:'7 天'}];
const gib=(kib:number)=>(kib/1024**2).toFixed(1);

export function AdbPerformanceHistory({api,id,sampledAt,online}:{api:Api;id:string;sampledAt?:number;online:boolean}){
 const [storedReport,setReport]=useState<Report|null>(null);
 const report=storedReport?.deviceId===id?storedReport:null;
 const [metric,setMetric]=useState<Metric>('cpu');
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const generation=useRef(0),saving=useRef(false);
 useEffect(()=>{
  if(api.preview)return;
  let active=true,timer:ReturnType<typeof setTimeout>;
  async function poll(){
   if(document.visibilityState==='hidden'||saving.current){timer=setTimeout(()=>void poll(),15_000);return;}
   const revision=generation.current;
   try{const next=await api.request<Report>('adb_performance_history',{id});if(active&&revision===generation.current){
    if(next.deviceId!==id){setReport(null);throw Error('历史记录与当前设备不匹配，已停止显示');}
    setReport(next);setError('');
   }}
   catch(reason){if(active&&revision===generation.current)setError(reason instanceof Error?reason.message:'无法读取性能历史');}
   if(active)timer=setTimeout(()=>void poll(),15_000);
  }
  void poll();
  return()=>{active=false;clearTimeout(timer);};
 },[api,id,sampledAt]);
 async function settings(hours:number,enabled:boolean){
  if(!report||busy||api.preview)return;
  saving.current=true;generation.current++;
  setBusy(true);setError('');
  try{const next=await api.request<Report>('adb_performance_history_settings',{id,hours,enabled});if(next.deviceId!==id){setReport(null);throw Error('历史记录与当前设备不匹配，已停止显示');}setReport(next);}
  catch(reason){setError(reason instanceof Error?reason.message:'无法保存性能记录设置');}
  finally{saving.current=false;setBusy(false);}
 }
 const readings=report?.points.filter(point=>point.cpu!==null||point.memory||point.storage)??[];
 return <section className="dc-performance-history mt-4 border-t border-[var(--fh-border)] pt-3" aria-label="性能历史" data-history-device={id}>
  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
   <div className="flex items-center gap-1"><h4 className="text-[11px] font-semibold">历史曲线</h4><HelpPopover label="性能历史说明">外设中心运行时，每分钟记录在线且已授权的 ADB 手机整机 CPU、内存和内部存储，最多同时 16 台。只保存设备匿名标识、读数和时间，不记录各 App。设置对所有手机生效；暂停、离线、读取失败或退出期间断开曲线。缩短保留时间会清理更早记录。</HelpPopover></div>
   <div className="flex flex-wrap items-center gap-2">
    <Checkbox label="持续记录" checked={report?.enabled??true} disabled={!report||busy} onChange={enabled=>void settings(report!.hours,enabled)} containerClassName="min-h-6 gap-1 text-[10px]" className="h-3.5 w-3.5"/>
    <Select ariaLabel="性能历史保留时间" className="dc-history-select" triggerClassName="dc-button" options={retention} value={String(report?.hours??48)} disabled={!report||busy} onChange={hours=>void settings(Number(hours),report!.enabled)}/>
   </div>
  </div>
  {report?.hours===168?<p className="dc-detail-note">缩短保留时间会清理更早的记录。</p>:null}
  {error||report?.error?<p role="alert" className="dc-warning">{error||report?.error}</p>:null}
  {report&&readings.length?<><Tabs value={metric} onValueChange={value=>setMetric(value as Metric)}>
   <TabsList aria-label="性能曲线指标" className="mb-2 inline-flex gap-1">{metrics.map(([key,label])=><TabsTrigger className="dc-button" key={key} value={key}>{label}</TabsTrigger>)}</TabsList>
   {metrics.map(([key,label])=><TabsPanel key={key} value={key}>
    <HistoryChart label={label+'占用历史曲线'} from={report.from} to={report.to} gapMs={150_000}
     points={report.points.map(point=>({at:point.at,value:key==='cpu'?point.cpu:point[key]&&point[key]![1]>0?point[key]![0]/point[key]![1]*100:null}))}
     formatValue={point=>{const reading=report.points.find(p=>p.at===point.at);const amount=key==='cpu'?null:reading?.[key];return key==='cpu'?point.value!.toFixed(1)+'%':amount?`${gib(amount[0])} / ${gib(amount[1])} GiB · ${point.value!.toFixed(1)}%`:'未提供';}}/>
   </TabsPanel>)}
  </Tabs><p className="dc-detail-note">{report.enabled?'每分钟记录整机占用':'已暂停记录，保留已有曲线'} · {readings.length} 次采样 · 最近 {time(readings.at(-1)!.at)}</p></>:report?<EmptyState size="compact" className="dc-performance-empty" role="status" title="暂无此设备的性能历史" description={online?'保持连接后会自动积累记录。':'设备离线，等待重新连接后采样。'}/>:!error?<p role="status" className="dc-detail-note">正在读取性能历史…</p>:null}
 </section>;
}
