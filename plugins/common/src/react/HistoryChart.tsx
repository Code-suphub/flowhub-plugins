import {useId,useMemo,useState} from 'react';
import './history-chart.css';

export type HistoryChartPoint={at:number;value:number|null};
export type HistoryChartProps={points:HistoryChartPoint[];from:number;to:number;label:string;max?:number;unit?:string;formatValue?:(point:HistoryChartPoint)=>string;gapMs?:number};
const clock=new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
const precise=new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});

export function HistoryChart({points,from,to,label,max=100,unit='%',formatValue,gapMs=120_000}:HistoryChartProps){
 const description=useId();
 const [active,setActive]=useState<number|null>(null);
 const [focused,setFocused]=useState(false);
 const model=useMemo(()=>{
  const rows=points.filter(p=>Number.isFinite(p.at)&&p.at>=from&&p.at<=to).sort((a,b)=>a.at-b.at);
  const first=rows.find(p=>p.value!==null)?.at;
  const start=Math.max(from,Math.min(first??to,to-5*60_000));
  const x=(at:number)=>32+(at-start)/Math.max(1,to-start)*348;
  const y=(value:number)=>12+(max-value)/max*90;
  let previous:HistoryChartPoint|undefined,path='';
  for(const p of rows){
   if(p.value===null||!Number.isFinite(p.value)||p.value<0||p.value>max){previous=undefined;continue;}
   path+=(previous&&p.at-previous.at<=gapMs?'L':'M')+x(p.at).toFixed(2)+','+y(p.value).toFixed(2);
   previous=p;
  }
  return {rows,start,x,y,path,count:rows.filter(p=>p.value!==null&&Number.isFinite(p.value)&&p.value>=0&&p.value<=max).length};
 },[points,from,to,max,gapMs]);
 const index=active===null?null:Math.min(active,model.rows.length-1);
 const selected=index===null?null:model.rows[index];
 const validSelected=selected?.value!=null&&Number.isFinite(selected.value)&&selected.value>=0&&selected.value<=max;
 const point=model.count===1?model.rows.find(p=>p.value!==null&&Number.isFinite(p.value)&&p.value>=0&&p.value<=max):null;
 function pointer(clientX:number,rect:DOMRect){
  const at=model.start+Math.max(0,Math.min(1,((clientX-rect.left)/Math.max(1,rect.width)*400-32)/348))*(to-model.start);
  let low=0,high=model.rows.length-1;
  while(low<high){const mid=Math.floor((low+high)/2);if(model.rows[mid].at<at)low=mid+1;else high=mid;}
  if(low>0&&at-model.rows[low-1].at<model.rows[low].at-at)low--;
  setActive(low);
 }
 return <div className="fh-history-chart">
  <svg viewBox="0 0 400 132" role="img" aria-label={label} aria-describedby={description} tabIndex={0}
   onFocus={()=>{setFocused(true);setActive(model.rows.length-1);}} onBlur={()=>{setFocused(false);setActive(null);}}
   onPointerMove={event=>{if(model.rows.length)pointer(event.clientX,event.currentTarget.getBoundingClientRect());}}
   onPointerLeave={()=>{if(!focused)setActive(null);}}
   onKeyDown={event=>{
    if(!model.rows.length||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();
    setActive(event.key==='Home'?0:event.key==='End'?model.rows.length-1:Math.max(0,Math.min(model.rows.length-1,(index??model.rows.length-1)+(event.key==='ArrowLeft'?-1:1))));
   }}>
   {[max,max/2,0].map(value=><g key={value} className="fh-history-chart__grid"><line x1="32" x2="380" y1={model.y(value)} y2={model.y(value)}/><text x="28" y={model.y(value)+3} textAnchor="end">{value}{unit}</text></g>)}
   <path d={model.path}/>
   {point&&point.value!==null?<circle cx={model.x(point.at)} cy={model.y(point.value)} r="3"/>:null}
   {selected?<g className="fh-history-chart__cursor"><line x1={model.x(selected.at)} x2={model.x(selected.at)} y1="12" y2="102"/>{validSelected?<circle cx={model.x(selected.at)} cy={model.y(selected.value!)} r="3"/>:null}</g>:null}
   <text x="32" y="124">{clock.format(model.start)}</text><text x="380" y="124" textAnchor="end">{clock.format(to)}</text>
  </svg>
  <p className="sr-only" id={description}>聚焦图表后，用左右方向键查看采样，Home 和 End 跳到首尾。中断处不连线。</p>
  <output aria-live={focused?'polite':'off'}>{selected?<><time dateTime={new Date(selected.at).toISOString()}>{precise.format(selected.at)}</time><strong>{validSelected?(formatValue?.(selected)??selected.value?.toFixed(1)+unit):'未提供'}</strong></>:!model.count?'暂无可绘制记录':model.count===1?'已记录首个采样点，下一次采样后形成曲线':'悬浮或聚焦图表可查看采样值'}</output>
 </div>;
}
