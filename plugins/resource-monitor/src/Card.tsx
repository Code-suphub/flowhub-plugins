import {useEffect,useState} from 'react';
import {accountingDisplay,bytes,cpu,widgetRows} from './model';
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
  return <main className="widget widget--card p-3"><div className="widget-header flex items-center justify-between gap-2 mb-3"><strong>{context.config?.title||context.title||'应用资源'}</strong><span className="muted text-xs" title="活跃：当前分组进程的内存足迹。记账：仅在取得可用的应用资源组数据时显示；未获取或不适用的原因可在详情查看。记账可能含独立任务和已退出任务余额，不可相加，不代表可释放内存。">{api.preview?'模拟数据':'活跃足迹 / 记账'}</span></div>
    <div className="muted text-xs mb-3">物理内存 {bytes(snapshot?.system?.totalMemory)} · 交换 {bytes(snapshot?.system?.swapUsed)}</div>
    {error||snapshot?.error||stale?<p role="alert" className="warning text-xs">{error||snapshot?.error||'数据已过期'}</p>:null}
    <div className="widget-list" role="region" aria-label="应用资源列表，可滚动查看" tabIndex={0}>{rows.map(r=>{
      const label=applicationIdentity(r,applications),accounting=accountingDisplay(r);
      return <button className="widget-row" key={r.id} disabled={api.preview} onClick={()=>api.navigate(r.id)}><AppMark name={label.name} iconKey={r.iconKey} application={r.appPath?applications[r.appPath]:undefined}/><div className="min-w-0 flex-1"><strong className="block truncate">{label.name}</strong><span className="muted text-xs">{r.count} 个进程{(r.instanceCount??0)>1?` · ${r.instanceCount} 个实例`:''} · RSS {bytes(r.values.rss)} · CPU {cpu(r.values.cpu)}</span>{label.sourceText?<span className="muted text-xs block truncate">来源线索：{label.sourceText} · 独立任务</span>:r.presentation?.name||label.related?<span className="muted text-xs block truncate">{label.description}</span>:null}</div><div className="widget-memory numeric"><strong><span className="muted text-xs">活跃 </span>{bytes(r.values.footprint)}{r.incomplete?' *':''}</strong>{accounting.available?<span className="muted text-xs" title={accounting.hint}>记账 {accounting.text}{r.systemAccounting?.shared?' · 共享':''}</span>:null}</div></button>;
    })}</div>
    {!rows.length?<p className="muted text-xs py-4">{snapshot?.at?'当前范围暂无应用':'等待首次采样…'}</p>:null}
    <footer className="flex items-center justify-between gap-2 mt-3 text-xs muted"><span>{snapshot?.at?`${new Date(snapshot.at).toLocaleTimeString()} 更新`:'未采集'} · {context.config?.display==='top'?'前 ':''}{rows.length} 项</span><button className="text-link" disabled={api.preview} onClick={()=>api.navigate()}>打开排行 →</button></footer>
  </main>;
}
