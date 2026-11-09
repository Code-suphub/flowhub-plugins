import {useEffect,useState,type CSSProperties} from 'react';
import {Button,Checkbox,DialogShell} from '@flowhub/plugin-common/react';
import {RequestDetails} from './RequestDetails';
import {displayError,errorText} from './errors';
import type {DisplayError} from './errors';
import {accountingDisplay,bytes,cpu,widgetRows} from './model';
import {AppMark,applicationIdentity,useApplications} from './applications';
import {cardLimits,cardPreferences,cardSortOptions,sortCardBy} from './card-preferences';
import type {Api,Config,Context,Sort,StatusSnapshot} from './types';

export function Card({api,context}:{api:Api;context:Context}) {
  const [snapshot,setSnapshot]=useState<StatusSnapshot|undefined>(context.snapshot);const [error,setError]=useState<DisplayError>('');
  const [settingsOpen,setSettingsOpen]=useState(false);
  const [overrides,setOverrides]=useState<Partial<Config>>({});
  const saved=context.config;
  useEffect(()=>setOverrides({}),[saved?.sort,saved?.display,saved?.limit,saved?.showFootprint,saved?.showRss,saved?.groupId]);
  useEffect(()=>{if(context.snapshot)setSnapshot(previous=>!previous||context.snapshot!.at>=previous.at?context.snapshot:previous);},[context.snapshot]);
  useEffect(()=>{
    let disposed=false,timer:ReturnType<typeof setTimeout>;
    async function tick(){if(!document.hidden){try{const next=await api.status();if(!disposed){setSnapshot(old=>!old||next.at>=old.at?next:old);setError('');}}catch(e){if(!disposed)setError(displayError(e));}}if(!disposed)timer=setTimeout(tick,5000);}
    void tick();return()=>{disposed=true;clearTimeout(timer);};
  },[api]);
  const config={...saved,...overrides};
  const preferences=cardPreferences(config);
  const {sort,showFootprint,showRss}=preferences;
  const showAccounting=sort==='accounting';
  const metrics=cardSortOptions.filter(option=>
    option.value==='cpu'||(option.value==='footprint'&&showFootprint)||(option.value==='memory'&&showRss)||(option.value==='accounting'&&showAccounting));
  const rows=widgetRows(snapshot,config);
  const applications=useApplications(api,rows);
  const stale=!!snapshot?.at&&Date.now()-snapshot.at>20000;
  const change=(patch:Partial<Config>)=>setOverrides(previous=>({...previous,...patch}));
  function setMetric(metric:'showFootprint'|'showRss',checked:boolean) {
    const selected=metric==='showFootprint'?'footprint':'memory';
    change({[metric]:checked,...(!checked&&sort===selected?{sort:'cpu'}:{})});
  }
  const limit=config.display==='top'?config.limit??5:'all';
  const style={'--widget-metrics':metrics.length} as CSSProperties;

  return <main className="widget widget--card p-3" style={style} data-expanded={metrics.length>1||undefined}>
    <div className="widget-header flex items-center justify-between gap-2 mb-2">
      <strong className="min-w-0 truncate">{config.title||context.title||'应用资源'}</strong>
      <Button size="sm" className="compact-button widget-settings-trigger" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={()=>setSettingsOpen(true)}>
        显示设置<span className="widget-settings-chevron" aria-hidden="true"/>
      </Button>
    </div>
    {api.preview?<p className="muted text-xs mb-1">模拟数据</p>:null}
    {error||snapshot?.error||stale?<div className="warning text-xs"><p role="alert">{errorText(error||snapshot?.error||'数据已过期')}</p><RequestDetails error={error}/></div>:null}
    <div className="widget-list" role="region" aria-label="应用资源列表，可滚动查看" tabIndex={0}>
      <div className="widget-grid widget-columns muted text-xs" aria-hidden="true">
        <span className="widget-identity">应用</span>
        {metrics.map(metric=><span key={metric.value}>{metric.value==='accounting'?'记账':metric.label}{sort===metric.value?' ↓':''}</span>)}
      </div>
      {rows.map(row=>{
        const label=applicationIdentity(row,applications);
        const accounting=showAccounting?accountingDisplay(row):undefined;
        const values:Record<Sort,string>={
          cpu:cpu(row.values.cpu),
          footprint:bytes(row.values.footprint)+(row.incomplete?' *':''),
          memory:bytes(row.values.rss),
          accounting:accounting?.text??'—',
        };
        return <button type="button" className="widget-row widget-grid" key={row.id} disabled={api.preview} onClick={()=>api.navigate(row.id)}>
          <span className="widget-identity flex items-center gap-2 min-w-0">
            <AppMark name={label.name} iconKey={row.iconKey} application={row.appPath?applications[row.appPath]:undefined}/>
            <strong className="truncate" title={label.name}>{label.name}</strong>
          </span>
          {metrics.map(metric=><span key={metric.value} className="numeric" title={metric.value==='accounting'?accounting?.hint:undefined}>
            <span className="sr-only">{metric.label} </span>{values[metric.value]}
          </span>)}
        </button>;
      })}
      {!rows.length?<p className="muted text-xs py-4">{snapshot?.at?'当前范围暂无应用':'等待首次采样…'}</p>:null}
    </div>
    <footer className="flex flex-wrap items-center justify-between gap-1 mt-2 text-xs muted">
      <span>{config.display==='top'?'前 ':'全部 '}{rows.length} 项 · {snapshot?.at?`${new Date(snapshot.at).toLocaleTimeString()} 更新`:'未采集'}</span>
      <button type="button" className="text-link" disabled={api.preview} onClick={()=>api.navigate()}>打开排行 →</button>
    </footer>
    <DialogShell open={settingsOpen} onOpenChange={setSettingsOpen} title="显示设置" className="widget-settings-dialog" contentClassName="widget-settings-content"
      footer={!api.preview?<Button size="sm" className="compact-button" onClick={()=>{setSettingsOpen(false);api.openEditor();}}>编辑默认设置</Button>:undefined}>
      <fieldset className="widget-settings-group">
        <legend>显示指标</legend>
        <div className="flex flex-wrap gap-x-3">
          <Checkbox label="活跃足迹" checked={showFootprint} onChange={checked=>setMetric('showFootprint',checked)} containerClassName="widget-setting-checkbox"/>
          <Checkbox label="RSS" checked={showRss} onChange={checked=>setMetric('showRss',checked)} containerClassName="widget-setting-checkbox"/>
        </div>
      </fieldset>
      <fieldset className="widget-settings-group">
        <legend>排序依据</legend>
        <div className="flex flex-wrap gap-1">{cardSortOptions.map(option=><Button key={option.value} size="sm" className="compact-button widget-setting-option" aria-pressed={sort===option.value} onClick={()=>change(sortCardBy(option.value))}>{option.label}</Button>)}</div>
      </fieldset>
      <fieldset className="widget-settings-group">
        <legend>显示范围</legend>
        <div className="flex flex-wrap gap-1">{(['all',...cardLimits] as const).map(value=><Button key={value} size="sm" className="compact-button widget-setting-option" aria-pressed={value===limit} onClick={()=>change(value==='all'?{display:'all'}:{display:'top',limit:value})}>{value==='all'?'完整列表':`前 ${value}`}</Button>)}</div>
      </fieldset>
      {!api.preview?<p className="muted text-xs mt-2">即时调整用于本次查看，默认设置由组件编辑器保存。</p>:null}
    </DialogShell>
  </main>;
}
