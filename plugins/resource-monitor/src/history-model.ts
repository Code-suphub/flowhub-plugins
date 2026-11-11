import type {HistoryChartPoint} from '@flowhub/plugin-common/react';
export type ResourceMetric='cpu'|'footprint'|'rss';
export interface ResourcePoint {at:number;cpu:number|null;footprint:number|null;rss:number|null;run:number;segment:number}
export interface ResourceReport {groupId:string;hours:number;intervalSeconds:number;from:number;to:number;points:ResourcePoint[];truncated:boolean;error:string|null}
export function historyModel(report:ResourceReport,metric:ResourceMetric){
 const values=report.points.map(p=>p[metric]).filter((v):v is number=>v!==null&&Number.isFinite(v)&&v>=0);
 const maximum=Math.max(0,...values);
 const factor=metric==='cpu'?1:maximum<1024**3?1024**2:1024**3;
 const unit=metric==='cpu'?'%':factor===1024**2?' MiB':' GiB';
 const scaled=maximum/factor;
 const magnitude=10**Math.floor(Math.log10(Math.max(1,scaled)));
 const max=metric==='cpu'?Math.max(100,Math.ceil(scaled/100)*100):[1,2,5,10].map(n=>n*magnitude).find(n=>n>=scaled)??10*magnitude;
 const points:HistoryChartPoint[]=[];let previous:ResourcePoint|undefined;
 for(const row of report.points){
  if(previous&&(row.run!==previous.run||row.segment!==previous.segment)&&row.at>previous.at)points.push({at:previous.at+Math.min(1,(row.at-previous.at)/2),value:null});
  const value=row[metric];points.push({at:row.at,value:value!==null&&Number.isFinite(value)&&value>=0?value/factor:null});previous=row;
 }
 return {points,max,unit,factor};
}
