import {useEffect,useState} from 'react';
import {bytes,cpu,widgetRows} from './model';
import {AppMark,applicationIdentity,useApplications} from './applications';
import type {Api,Context,StatusSnapshot} from './types';

export function Card({api,context}:{api:Api;context:Context}) {
  const [snapshot,setSnapshot]=useState<StatusSnapshot|undefined>(context.snapshot);const [error,setError]=useState('');
  useEffect(()=>{if(context.snapshot)setSnapshot(previous=>!previous||context.snapshot!.at>=previous.at?context.snapshot:previous);},[context.snapshot]);
  useEffect(()=>{
    let disposed=false,timer:ReturnType<typeof setTimeout>;
    async function tick(){if(!document.hidden){try{const next=await api.status();if(!disposed){setSnapshot(old=>!old||next.at>=old.at?next:old);setError('');}}catch(e){if(!disposed)setError(String(e));}}if(!disposed)timer=setTimeout(tick,5000);}
    void tick();return()=>{disposed=true;clearTimeout(timer);};
  },[api]);
  const rows=widgetRows(snapshot,context.config);
  const applications=useApplications(api,rows);
  const stale=!!snapshot?.at&&Date.now()-snapshot.at>20000;
  return <main className="widget widget--card p-3"><div className="widget-header flex items-center justify-between gap-2 mb-3"><strong>{context.config?.title||context.title||'应用资源'}</strong><span className="muted text-xs">{api.preview?'模拟数据':'内存足迹'}</span></div>
    <div className="muted text-xs mb-3">物理内存 {bytes(snapshot?.system?.totalMemory)} · 交换 {bytes(snapshot?.system?.swapUsed)}</div>
    {error||snapshot?.error||stale?<p role="alert" className="warning text-xs">{error||snapshot?.error||'数据已过期'}</p>:null}
    <div className="widget-list" role="region" aria-label="应用资源列表，可滚动查看" tabIndex={0}>{rows.map(r=><button className="widget-row" key={r.id} disabled={api.preview} onClick={()=>api.navigate(r.id)}><AppMark name={applicationIdentity(r,applications).name} iconKey={r.iconKey} application={r.appPath?applications[r.appPath]:undefined}/><div className="min-w-0 flex-1"><strong className="block truncate">{applicationIdentity(r,applications).name}</strong><span className="muted text-xs">{r.count} 个进程{(r.instanceCount??0)>1?` · ${r.instanceCount} 个实例`:''} · RSS {bytes(r.values.rss)} · CPU {cpu(r.values.cpu)}</span>{applicationIdentity(r,applications).sourceText?<span className="muted text-xs block truncate">来源线索：{applicationIdentity(r,applications).sourceText} · 独立任务</span>:r.presentation?.name||applicationIdentity(r,applications).related?<span className="muted text-xs block truncate">{applicationIdentity(r,applications).description}</span>:null}</div><strong className="numeric shrink-0">{bytes(r.values.footprint)}{r.incomplete?' *':''}</strong></button>)}</div>
    {!rows.length?<p className="muted text-xs py-4">{snapshot?.at?'当前范围暂无应用':'等待首次采样…'}</p>:null}
    <footer className="flex items-center justify-between gap-2 mt-3 text-xs muted"><span>{snapshot?.at?`${new Date(snapshot.at).toLocaleTimeString()} 更新`:'未采集'} · {context.config?.display==='top'?'前 ':''}{rows.length} 项</span><button className="text-link" disabled={api.preview} onClick={()=>api.navigate()}>打开排行 →</button></footer>
  </main>;
}
