import {useEffect,useRef,useState,type CSSProperties} from 'react';
import {Button,Checkbox,DialogShell} from '@flowhub/plugin-common/react';
import {RequestDetails} from './RequestDetails';
import {displayError,errorText} from './errors';
import type {DisplayError} from './errors';
import {accountingDisplay,bytes,cpu,defaultRankingOrder,newerSnapshot,widgetRows} from './model';
import {AppMark,applicationIdentity,useApplications} from './applications';
import {cardLimitOptions,cardMetricFields,cardPreferences,cardRowLimit,cardSortOptions} from './card-preferences';
import type {Api,Config,Context,Sort,StatusSnapshot} from './types';

export function Card({api,context}:{api:Api;context:Context}) {
  const [snapshot,setSnapshot]=useState<StatusSnapshot|undefined>(context.snapshot);const [error,setError]=useState<DisplayError>('');
  const hasWidgetSnapshot=useRef(false);
  const [settingsOpen,setSettingsOpen]=useState(false);
  const [sortingSaving,setSortingSaving]=useState(false);
  const [sortingError,setSortingError]=useState<DisplayError>('');
  const [overrides,setOverrides]=useState<Partial<Config>>({});
  const [saveState,setSaveState]=useState<'idle'|'saving'|'failed'>('idle');
  const pending=useRef<Partial<Config>>({}), saveSequence=useRef(0);
  const saved=context.config;
  const canSave=!api.preview&&context.canSaveConfig===true;
  useEffect(()=>{
    if(saveState==='idle'&&Object.keys(overrides).length>0&&Object.entries(overrides).every(([key,value])=>saved?.[key as keyof Config]===value)){
      pending.current={};
      setOverrides({});
    }
  },[saved,overrides,saveState]);
  useEffect(()=>{
    const seed=context.snapshot;
    if(seed&&!hasWidgetSnapshot.current)setSnapshot(previous=>newerSnapshot(seed,previous)?seed:previous);
  },[context.snapshot]);
  useEffect(()=>{
    let disposed=false,timer:ReturnType<typeof setTimeout>;
    async function tick(){if(!document.hidden){try{const next=await api.status();if(!disposed){hasWidgetSnapshot.current=true;setSnapshot(old=>newerSnapshot(next,old)?next:old);setError('');}}catch(e){if(!disposed)setError(displayError(e));}}if(!disposed)timer=setTimeout(tick,5000);}
    void tick();return()=>{disposed=true;clearTimeout(timer);};
  },[api]);
  const config={...saved,...overrides};
  const preferences=cardPreferences(config);
  const {showAccounting}=preferences;
  const sorting=snapshot?.sorting??{...defaultRankingOrder,key:preferences.sort};
  const arrow=sorting.order==='ascend'?'↑':'↓';
  const metrics=cardSortOptions.filter(({value})=>value==='cpu'||preferences[cardMetricFields[value]]);
  const hiddenSort=metrics.some(metric=>metric.value===sorting.key)?undefined:sorting.key==='processCount'?'进程数':cardSortOptions.find(metric=>metric.value===sorting.key)?.label;
  const rows=widgetRows(snapshot,{...config,sort:preferences.sort});
  const applications=useApplications(api,rows);
  const stale=!!snapshot?.at&&Date.now()-snapshot.at>20000;
  function change(patch:Partial<Config>) {
    if(!canSave)return;
    const next={...pending.current,...patch};
    const sequence=++saveSequence.current;
    pending.current=next;
    setOverrides(next);
    setSaveState('saving');
    void api.saveCardConfig(next).then(()=>{
      if(sequence!==saveSequence.current)return;
      setSaveState('idle');
    }).catch(()=>{
      if(sequence===saveSequence.current)setSaveState('failed');
    });
  }
  async function changeSorting(key:Sort) {
    setSortingSaving(true);
    setSortingError('');
    try{
      await api.invoke('set_view_preferences',{sorting:{key,order:sorting.key===key&&sorting.order==='descend'?'ascend':'descend'}});
      const next=await api.status();
      setSnapshot(previous=>newerSnapshot(next,previous)?next:previous);
    }catch(error){setSortingError(displayError(error));}
    finally{setSortingSaving(false);}
  }
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
    {saveState==='failed'?<div className="flex items-center gap-2 text-xs warning" role="alert">卡片设置未保存<Button size="sm" disabled={!canSave} onClick={()=>change(pending.current)}>重试</Button></div>:null}
    {sortingError?<div className="warning text-xs"><p role="alert">{errorText(sortingError)}</p><RequestDetails error={sortingError}/></div>:null}
    {error||snapshot?.error||stale?<div className="warning text-xs"><p role="alert">{errorText(error||snapshot?.error||'数据已过期')}</p><RequestDetails error={error}/></div>:null}
    <div className="widget-list" role="region" aria-label="应用资源列表，可滚动查看" tabIndex={0}>
      <div className="widget-grid widget-columns muted text-xs">
        <span className="widget-identity">应用</span>
        {metrics.map(metric=><button key={metric.value} type="button" className="widget-sort" title={`按${metric.label}${sorting.key===metric.value&&sorting.order==='descend'?'升序':'降序'}排列，排行和卡片同步`}
          aria-label={`按${metric.label}排序`} aria-pressed={sorting.key===metric.value} disabled={api.preview||!snapshot?.sorting||sortingSaving} onClick={()=>void changeSorting(metric.value)}>
          {metric.value==='accounting'?'记账':metric.label}{sorting.key===metric.value?<span aria-hidden="true"> {arrow}</span>:null}
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
      <span>{config.display==='top'?'前 ':'全部 '}{rows.length} 项 · {hiddenSort?`按${hiddenSort} ${arrow}`:snapshot?.at?`${new Date(snapshot.at).toLocaleTimeString()} 更新`:'未采集'}</span>
      <button type="button" className="text-link" disabled={api.preview} onClick={()=>api.navigate()}>打开排行 →</button>
    </footer>
    <DialogShell open={settingsOpen} onOpenChange={setSettingsOpen} title="显示设置" className="widget-settings-dialog" contentClassName="widget-settings-content"
      footer={!api.preview?<span className="mr-auto muted text-xs" role="status">{canSave?(saveState==='saving'?'保存中…':saveState==='failed'?'未保存':'修改自动保存'):'当前无法保存卡片设置'}</span>:undefined}>
      <fieldset className="widget-settings-group">
        <legend>显示指标</legend>
        <div className="flex flex-wrap gap-x-3">
          {cardSortOptions.map(({value,label})=>value==='cpu'?null:<Checkbox key={value} label={label}
            checked={preferences[cardMetricFields[value]]} disabled={!canSave} onChange={checked=>change({[cardMetricFields[value]]:checked})} containerClassName="widget-setting-checkbox"/>)}
        </div>
      </fieldset>
      <fieldset className="widget-settings-group">
        <legend>显示范围</legend>
        <div className="flex flex-wrap gap-1">{(['all',...cardLimitOptions(rowLimit)] as const).map(value=><Button key={value} size="sm" className="compact-button"
          variant={value===limit?'primary':'secondary'} aria-pressed={value===limit} disabled={!canSave} onClick={()=>change(value==='all'?{display:'all'}:{display:'top',limit:value})}>
          {value==='all'?'完整列表':`前 ${value}`}
        </Button>)}</div>
      </fieldset>
    </DialogShell>
  </main>;
}
