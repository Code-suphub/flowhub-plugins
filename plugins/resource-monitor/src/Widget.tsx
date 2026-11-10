import {useEffect,useRef,useState} from 'react';
import {Alert,Select} from 'antd';
import {Checkbox,Input} from '@flowhub/plugin-common/react';
import {cardLimitOptions,cardMetricFields,cardPreferences,cardRowLimit,cardSortOptions,showCardMetric,sortCardBy} from './card-preferences';
import type {Api,Config,Context} from './types';

// Keep existing consumers compatible; the card entry imports Card directly.
export {Card} from './Card';

export function Editor({api,context}:{api:Api;context:Context}) {
  const [config,setConfig]=useState<Config>(context.config??{});const draft=useRef(config);draft.current=config;
  // Register the save callback before announcing ready in main.tsx.
  api.editor(()=>({
    title:(draft.current.title??'').trim().slice(0,40),
    ...cardPreferences(draft.current),
    display:draft.current.display==='top'?'top':'all',
    limit:cardRowLimit(draft.current.limit),
    groupId:draft.current.groupId??'',
  }));
  useEffect(()=>{setConfig(context.config??{});},[context.config]);
  const change=(patch:Partial<Config>)=>setConfig(old=>({...old,...patch}));
  const preferences=cardPreferences(config);
  const rowLimit=cardRowLimit(config.limit);
  return <main className="editor grid gap-4 p-4">
    <label className="grid gap-2 text-sm">卡片标题<Input maxLength={40} value={config.title??''} placeholder="应用资源" onChange={e=>change({title:e.target.value})}/></label>
    <label className="grid gap-2 text-sm">关注范围<Select aria-label="关注范围" showSearch optionFilterProp="label" value={config.groupId??''} onChange={groupId=>change({groupId})} options={[{value:'',label:'全部应用'},...(context.snapshot?.rows??[]).map(r=>({value:r.id,label:r.name})),...(config.groupId&&!context.snapshot?.rows?.some(r=>r.id===config.groupId)?[{value:config.groupId,label:'已退出的关注应用'}]:[])]}/></label>
    <fieldset className="widget-settings-group">
      <legend>额外显示指标</legend>
      <div className="flex flex-wrap gap-x-4">
        {cardSortOptions.map(({value,label})=>value==='cpu'?null:<Checkbox key={value} label={label}
          checked={preferences[cardMetricFields[value]]} onChange={checked=>change(showCardMetric(value,checked,preferences.sort))}/>)}
      </div>
    </fieldset>
    <label className="grid gap-2 text-sm">排行方式<Select aria-label="卡片排行方式" value={preferences.sort} onChange={sort=>change({...preferences,...sortCardBy(sort)})} options={cardSortOptions.map(option=>({value:option.value,label:`按 ${option.label}`}))}/></label>
    <label className="grid gap-2 text-sm">显示范围<Select aria-label="显示范围" value={config.display??'all'} onChange={display=>change({display})} options={[{value:'all',label:'完整列表 · 滚动查看'},{value:'top',label:'只显示排名靠前的应用'}]}/></label>
    {config.display==='top'?<label className="grid gap-2 text-sm">显示数量<Select aria-label="显示数量" value={rowLimit} onChange={limit=>change({limit})} options={cardLimitOptions(rowLimit).map(n=>({value:n,label:`前 ${n} 个`}))}/></label>:null}
    <Alert type="info" title="卡片点击应用可查看进程和来源，清理在详情页确认后执行。"/>
  </main>;
}
