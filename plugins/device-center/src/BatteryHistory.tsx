import {useEffect,useState} from 'react';
import {Button,HelpPopover,Select} from '@flowhub/plugin-common/react';
import type {Api} from './api';
import {demoBatteryHistory,type BatteryReport} from './model';

const options=[{value:'48',label:'48 小时'},{value:'168',label:'7 天'}];
const sourceNames={system_profiler:'macOS 蓝牙',pmset:'macOS 配件电源',adb:'ADB'};
const shortTime=new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
const preciseTime=new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});

function BatteryChart({report}:{report:BatteryReport}){
 const points=report.points.filter(point=>point.percent!==undefined);
 if(!points.length)return <p className="dc-history-empty">还没有可绘制的电量记录</p>;
 const end=report.to;
 const start=Math.max(report.from,Math.min(points[0].at,end-3_600_000));
 const x=(at:number)=>30+(at-start)/Math.max(1,end-start)*350;
 const y=(percent:number)=>12+(100-percent)*.85;
 let previous=0;
 let path='';
 for(const point of report.points){
  if(point.percent===undefined||point.at<start){previous=0;continue;}
  const position=x(point.at).toFixed(2),level=y(point.percent).toFixed(2);
  path+=previous&&point.at-previous<=30*60_000?`H${position}V${level}`:`M${position},${level}`;
  previous=point.at;
 }
 const recent=points.slice(-5).reverse();
 return <>
  <svg className="dc-history-chart" viewBox="0 0 400 124" role="img" aria-label="电量历史曲线，纵轴零到百分之百，横轴为采样时间">
   {[100,50,0].map(value=><g key={value}><line x1="30" x2="380" y1={y(value)} y2={y(value)}/><text x="26" y={y(value)+3} textAnchor="end">{value}%</text></g>)}
   <path d={path}/>
   {points.map(point=><circle key={point.at+'-'+point.source} cx={x(point.at)} cy={y(point.percent!)} r={points.length>120?1:2}/>)}
   <text x="30" y="116">{shortTime.format(start)}</text><text x="380" y="116" textAnchor="end">{shortTime.format(end)}</text>
  </svg>
  <ul className="dc-history-readings" aria-label="最近五条电量记录">
   {recent.map(point=><li key={point.at+'-'+point.source}><time dateTime={new Date(point.at).toISOString()}>{preciseTime.format(point.at)}</time><strong>{point.percent}%</strong><small>{point.source?sourceNames[point.source]:''}</small></li>)}
  </ul>
 </>;
}

function HistoryContent({api,id}:{api:Api;id:string}){
 const [report,setReport]=useState<BatteryReport|null>(()=>api.preview?demoBatteryHistory(id):null);
 const [busy,setBusy]=useState(!api.preview);
 const [error,setError]=useState('');
 useEffect(()=>{
  if(api.preview)return;
  let active=true;
  api.request<BatteryReport>('battery_history',{id}).then(value=>{if(active)setReport(value);})
   .catch(reason=>{if(active)setError(String(reason instanceof Error?reason.message:reason));})
   .finally(()=>{if(active)setBusy(false);});
  return ()=>{active=false;};
 },[api,id]);
 async function request(hours?:number){
  if(api.preview||busy)return;
  setBusy(true);setError('');
  try{setReport(await api.request<BatteryReport>(hours===undefined?'battery_history':'battery_history_set_retention',{id,hours}));}
  catch(reason){setError(String(reason instanceof Error?reason.message:reason));}
  finally{setBusy(false);}
 }
 return <>
  <div className="dc-history-tools">
   <span>全局保留</span>
   <Select ariaLabel="电量日志保留时间" className="dc-history-select" triggerClassName="dc-button" options={options} value={String(report?.hours??48)} disabled={api.preview||busy||!report} onChange={value=>void request(Number(value))}/>
   <HelpPopover label="电量日志说明">只在外设中心运行时采样。本机保存读数、来源和时间。变化时记录，读数不变时每 15 分钟补一点。中断时曲线断开。缩短保留时间会清理更早的记录。</HelpPopover>
   <Button className="dc-button" variant="ghost" disabled={api.preview||busy} onClick={()=>void request()}>刷新记录</Button>
  </div>
  {error||report?.error?<p role="alert" className="dc-warning">{error||report?.error}</p>:null}
  {report?<BatteryChart report={report}/>:busy?<p role="status" className="dc-history-empty">正在读取电量日志…</p>:null}
 </>;
}

export function BatteryHistory({api,id}:{api:Api;id:string}){
 const [expanded,setExpanded]=useState(false);
 return <details className="dc-battery-history" onToggle={event=>setExpanded(event.currentTarget.open)}>
  <summary>电量历史</summary>
  {expanded?<HistoryContent api={api} id={id}/>:null}
 </details>;
}
