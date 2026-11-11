import {memo,useEffect,useMemo,useRef,useState} from 'react';
import {Button,EmptyState,HelpPopover,HistoryChart,Select,Tabs,TabsList,TabsPanel,TabsTrigger} from '@flowhub/plugin-common/react';
import type {Api} from './types';
import {bytes} from './model';
import {historyModel,type ResourceMetric,type ResourceReport} from './history-model';
const metrics:[ResourceMetric,string][]=[['cpu','CPU'],['footprint','活跃足迹'],['rss','RSS']];
const retention=[{value:'48',label:'48 小时'},{value:'168',label:'7 天'}];

export const ResourceHistory=memo(function ResourceHistory({api,groupId}:{api:Api;groupId:string}){
 const [stored,setStored]=useState<ResourceReport>();const report=stored?.groupId===groupId?stored:undefined;
 const [metric,setMetric]=useState<ResourceMetric>('footprint'),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const live=useRef(true),reading=useRef(false),saving=useRef(false),revision=useRef(0);
 const [reload,setReload]=useState(0);
 useEffect(()=>{
  live.current=true;let disposed=false,timer:ReturnType<typeof setTimeout>;
  async function read(){
   clearTimeout(timer);
   if(!reading.current&&!saving.current&&!document.hidden){
    reading.current=true;const version=revision.current;
    try{const next=await api.invoke<ResourceReport>('resource_history',{groupId});if(!disposed&&live.current&&version===revision.current){
     if(next.groupId!==groupId){setStored(undefined);throw Error('历史记录与当前应用不匹配，已停止显示');}
     setStored(next);setError('');
    }}catch(reason){if(!disposed&&live.current&&version===revision.current)setError(reason instanceof Error?reason.message:'无法读取资源历史');}
    finally{reading.current=false;}
   }
   if(!disposed){clearTimeout(timer);timer=setTimeout(()=>void read(),15_000);}
  }
  const visible=()=>{if(!document.hidden)void read();};
  void read();document.addEventListener('visibilitychange',visible);
  return()=>{disposed=true;live.current=false;clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
 },[api,groupId,reload]);
 async function change(hours:number){
  if(api.preview||saving.current)return;saving.current=true;revision.current++;setBusy(true);setError('');
  try{const next=await api.invoke<ResourceReport>('resource_history_settings',{groupId,hours});if(live.current){
   if(next.groupId!==groupId){setStored(undefined);throw Error('历史记录与当前应用不匹配，已停止显示');}
   setStored(next);
  }}catch(reason){if(live.current)setError(reason instanceof Error?reason.message:'无法保存保留时间');}
  finally{saving.current=false;if(live.current)setBusy(false);}
 }
 const model=useMemo(()=>report?historyModel(report,metric):undefined,[report,metric]);
 return <section className="resource-history" aria-label="资源历史" data-history-group={groupId}>
  <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
   <div className="flex items-center gap-1"><strong className="text-xs">历史曲线</strong><HelpPopover label="资源历史说明">后台运行期间，每分钟保存一次各应用的 CPU、活跃足迹和 RSS，页面关闭后继续记录。保留时间对所有应用生效；缩短时会清理过期记录。CPU 按单核 100% 计算，可超过 100%；这是采样时的读数，不是分钟均值。应用退出、重启或采样失败保留断点，未取得的指标不填零。只保存匿名应用标识、指标和时间。</HelpPopover></div>
   <div className="flex items-center gap-2"><span className="muted text-xs">保留</span><Select ariaLabel="资源历史保留时间" options={retention} value={String(report?.hours??48)} disabled={!report||busy||api.preview} onChange={hours=>void change(Number(hours))}/></div>
  </div>
  {report?.hours===168?<p className="muted text-xs mb-2">改回 48 小时会清理更早记录。</p>:null}
  {error||report?.error?<div className="flex items-center gap-2 mb-2"><p role="alert" className="danger text-xs">{error||report?.error}</p><Button size="sm" variant="ghost" disabled={busy} onClick={()=>setReload(value=>value+1)}>重新读取</Button></div>:null}
  {report?<Tabs value={metric} onValueChange={value=>setMetric(value as ResourceMetric)}>
   <TabsList aria-label="资源历史指标" className="flex gap-1 mb-2">{metrics.map(([key,label])=><TabsTrigger key={key} value={key} className="resource-history-tab">{label}</TabsTrigger>)}</TabsList>
   {metrics.map(([key,label])=><TabsPanel key={key} value={key}>
    <div className="resource-history-plot">{report.points.length&&model?<HistoryChart points={model.points} from={report.from} to={report.to} max={model.max} unit={model.unit} gapMs={95_000} label={label+'历史曲线'} formatValue={point=>key==='cpu'?point.value!.toFixed(1)+'%':bytes(point.value!*model.factor)}/>:<EmptyState size="compact" title="暂无此应用的历史记录" description="后台会自动积累，下一分钟继续采样。"/>}</div>
   </TabsPanel>)}
  </Tabs>:!error?<p role="status" className="muted text-xs py-3">正在读取已保存的历史…</p>:null}
  {report?.points.length?<p className="muted text-xs mt-1">每分钟记录 · {report.points.length} 次采样 · 最近 {new Date(report.points.at(-1)!.at).toLocaleString()}{report.truncated?' · 仅显示最近 12000 次采样':''}</p>:null}
 </section>;
});
