import {useEffect,useRef,useState} from 'react';
import {Alert,Select} from 'antd';
import {Input} from '@flowhub/plugin-common/react';
import {bytes,cpu} from './model';
import type {Api,Config,Context,StatusSnapshot} from './types';

export function Card({api,context}:{api:Api;context:Context}) {
  const [snapshot,setSnapshot]=useState<StatusSnapshot|undefined>(context.snapshot);const [error,setError]=useState('');
  useEffect(()=>{if(context.snapshot)setSnapshot(previous=>!previous||context.snapshot!.at>=previous.at?context.snapshot:previous);},[context.snapshot]);
  useEffect(()=>{
    let disposed=false,timer:ReturnType<typeof setTimeout>;
    async function tick(){if(!document.hidden){try{const next=await api.status();if(!disposed){setSnapshot(old=>!old||next.at>=old.at?next:old);setError('');}}catch(e){if(!disposed)setError(String(e));}}if(!disposed)timer=setTimeout(tick,5000);}
    void tick();return()=>{disposed=true;clearTimeout(timer);};
  },[api]);
  const sort=context.config?.sort==='cpu'?'cpu':context.config?.sort==='memory'?'rss':'footprint';
  const rows=[...(snapshot?.rows??[])].filter(r=>!context.config?.groupId||r.id===context.config.groupId)
    .sort((a,b)=>(b.values[sort]??-1)-(a.values[sort]??-1)).slice(0,Math.max(3,Math.min(10,context.config?.limit??5)));
  const stale=!!snapshot?.at&&Date.now()-snapshot.at>20000;
  return <main className="widget p-3"><div className="flex items-center justify-between gap-2 mb-3"><strong>{context.config?.title||context.title||'应用资源'}</strong><span className="muted text-xs">{api.preview?'模拟数据':'内存足迹'}</span></div>
    <div className="muted text-xs mb-3">物理内存 {bytes(snapshot?.system?.totalMemory)} · 交换 {bytes(snapshot?.system?.swapUsed)}</div>
    {error||snapshot?.error||stale?<p role="alert" className="warning text-xs">{error||snapshot?.error||'数据已过期'}</p>:null}
    {rows.map(r=><button className="widget-row" key={r.id} disabled={api.preview} onClick={()=>api.navigate(r.id)}><div className="min-w-0"><strong className="block truncate">{r.name}</strong><span className="muted text-xs">{r.count} 个进程 · RSS {bytes(r.values.rss)} · CPU {cpu(r.values.cpu)}</span></div><strong className="numeric shrink-0">{bytes(r.values.footprint)}{r.incomplete?' *':''}</strong></button>)}
    {!rows.length?<p className="muted text-xs py-4">{snapshot?.at?'当前范围暂无应用':'等待首次采样…'}</p>:null}
    <footer className="flex items-center justify-between gap-2 mt-3 text-xs muted"><span>{snapshot?.at?`${new Date(snapshot.at).toLocaleTimeString()} 更新`:'未采集'}</span><button className="text-link" disabled={api.preview} onClick={()=>api.navigate()}>打开排行 →</button></footer>
  </main>;
}

export function Editor({api,context}:{api:Api;context:Context}) {
  const [config,setConfig]=useState<Config>(context.config??{});const draft=useRef(config);draft.current=config;
  // Register the save callback before announcing ready in main.tsx.
  api.editor(()=>({title:(draft.current.title??'').trim().slice(0,40),sort:draft.current.sort==='cpu'?'cpu':draft.current.sort==='memory'?'memory':'footprint',limit:Math.min(10,Math.max(3,draft.current.limit??5)),groupId:draft.current.groupId??''}));
  useEffect(()=>{setConfig(context.config??{});},[context.config]);
  const change=(patch:Partial<Config>)=>setConfig(old=>({...old,...patch}));
  return <main className="editor grid gap-4 p-4">
    <label className="grid gap-2 text-sm">卡片标题<Input maxLength={40} value={config.title??''} placeholder="应用资源" onChange={e=>change({title:e.target.value})}/></label>
    <label className="grid gap-2 text-sm">关注范围<Select aria-label="关注范围" showSearch optionFilterProp="label" value={config.groupId??''} onChange={groupId=>change({groupId})} options={[{value:'',label:'全部应用'},...(context.snapshot?.rows??[]).map(r=>({value:r.id,label:r.name})),...(config.groupId&&!context.snapshot?.rows?.some(r=>r.id===config.groupId)?[{value:config.groupId,label:'已退出的关注应用'}]:[])]}/></label>
    <label className="grid gap-2 text-sm">排行方式<Select aria-label="卡片排行方式" value={config.sort??'footprint'} onChange={sort=>change({sort})} options={[{value:'footprint',label:'按内存足迹'},{value:'memory',label:'按 RSS'},{value:'cpu',label:'按 CPU'}]}/></label>
    <label className="grid gap-2 text-sm">显示数量<Select aria-label="显示数量" value={config.limit??5} onChange={limit=>change({limit})} options={[3,5,8,10].map(n=>({value:n,label:`${n} 个`}))}/></label>
    <Alert type="info" title="卡片点击应用可查看进程和来源，清理在详情页确认后执行。"/>
  </main>;
}
