import {useEffect,useState,type CSSProperties} from 'react';
import {Button,Checkbox,DialogShell} from '@flowhub/plugin-common/react';
import {RequestDetails} from './RequestDetails';
import {displayError,errorText} from './errors';
import type {DisplayError} from './errors';
import {accountingDisplay,bytes,cpu,widgetRows} from './model';
import {AppMark,applicationIdentity,useApplications} from './applications';
import {cardLimitOptions,cardMetricFields,cardPreferences,cardRowLimit,cardSortOptions,showCardMetric} from './card-preferences';
import type {Api,Config,Context,Sort,StatusSnapshot} from './types';

export function Card({api,context}:{api:Api;context:Context}) {
  const [snapshot,setSnapshot]=useState<StatusSnapshot|undefined>(context.snapshot);const [error,setError]=useState<DisplayError>('');
  const [settingsOpen,setSettingsOpen]=useState(false);
  const [overrides,setOverrides]=useState<Partial<Config>>({});
  const saved=context.config;
  useEffect(()=>setOverrides({}),[saved?.sort,saved?.display,saved?.limit,saved?.showFootprint,saved?.showRss,saved?.showAccounting,saved?.groupId]);
  useEffect(()=>{if(context.snapshot)setSnapshot(previous=>!previous||context.snapshot!.at>=previous.at?context.snapshot:previous);},[context.snapshot]);
  useEffect(()=>{
    let disposed=false,timer:ReturnType<typeof setTimeout>;
    async function tick(){if(!document.hidden){try{const next=await api.status();if(!disposed){setSnapshot(old=>!old||next.at>=old.at?next:old);setError('');}}catch(e){if(!disposed)setError(displayError(e));}}if(!disposed)timer=setTimeout(tick,5000);}
    void tick();return()=>{disposed=true;clearTimeout(timer);};
  },[api]);
  const config={...saved,...overrides};
  const preferences=cardPreferences(config);
  const {sort,showAccounting}=preferences;
  const metrics=cardSortOptions.filter(({value})=>value==='cpu'||preferences[cardMetricFields[value]]);
  const rows=widgetRows(snapshot,{...config,sort});
  const applications=useApplications(api,rows);
  const stale=!!snapshot?.at&&Date.now()-snapshot.at>20000;
  const change=(patch:Partial<Config>)=>setOverrides(previous=>({...previous,...patch}));
  const rowLimit=cardRowLimit(config.limit);
  const limit=config.display==='top'?rowLimit:'all';
  const style={'--widget-metrics':metrics.length} as CSSProperties;

  return <main className="widget widget--card p-3" style={style}>
    <div className="widget-header flex items-center justify-between gap-2 mb-2">
      <strong className="min-w-0 truncate">{config.title||context.title||'应用资源'}</strong>
      <Button size="sm" className="compact-button widget-settings-trigger" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={event=>{
        // WebKit does not focus buttons on pointer click. Give the dialog the same opener as keyboard input.
        event.currentTarget.focus({preventScroll:true});
        setSettingsOpen(true);
      }}>
        显示设置<span className="widget-settings-chevron" aria-hidden="true"/>
      </Button>
    </div>
    {api.preview?<p className="muted text-xs mb-1">模拟数据</p>:null}
    {error||snapshot?.error||stale?<div className="warning text-xs"><p role="alert">{errorText(error||snapshot?.error||'数据已过期')}</p><RequestDetails error={error}/></div>:null}
    <div className="widget-list" role="region" aria-label="应用资源列表，可滚动查看" tabIndex={0}>
      <div className="widget-grid widget-columns muted text-xs">
        <span className="widget-identity">应用</span>
        {metrics.map(metric=><button key={metric.value} type="button" className="widget-sort" title={`按${metric.label}从高到低排序`}
          aria-label={`按${metric.label}排序`} aria-pressed={sort===metric.value} onClick={()=>change({...preferences,sort:metric.value})}>
          {metric.value==='accounting'?'记账':metric.label}{sort===metric.value?<span aria-hidden="true"> ↓</span>:null}
        </button>)}
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
          {metrics.map(metric=><span key={metric.value} className="numeric" title={metric.value==='accounting'?accounting?.hint:values[metric.value]}>
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
      footer={!api.preview?<><span className="mr-auto muted text-xs">仅本次生效</span><Button size="sm" className="compact-button" onClick={()=>{setSettingsOpen(false);api.openEditor();}}>编辑默认设置</Button></>:undefined}>
      <fieldset className="widget-settings-group">
        <legend>显示指标</legend>
        <div className="flex flex-wrap gap-x-3">
          {cardSortOptions.map(({value,label})=>value==='cpu'?null:<Checkbox key={value} label={label}
            checked={preferences[cardMetricFields[value]]} onChange={checked=>change(showCardMetric(value,checked,sort))} containerClassName="widget-setting-checkbox"/>)}
        </div>
      </fieldset>
      <fieldset className="widget-settings-group">
        <legend>显示范围</legend>
        <div className="flex flex-wrap gap-1">{(['all',...cardLimitOptions(rowLimit)] as const).map(value=><Button key={value} size="sm" className="compact-button"
          variant={value===limit?'primary':'secondary'} aria-pressed={value===limit} onClick={()=>change(value==='all'?{display:'all'}:{display:'top',limit:value})}>
          {value==='all'?'完整列表':`前 ${value}`}
        </Button>)}</div>
      </fieldset>
    </DialogShell>
  </main>;
}
