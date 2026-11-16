import {Button,HelpPopover} from '@flowhub/plugin-common/react';
import {summaryLayouts} from './card-preferences';
import {bytes,cpu} from './model';
import type {SummaryLayout,SystemInfo} from './types';

export function SummaryLayoutPicker({value,disabled=false,onChange}:{value:SummaryLayout;disabled?:boolean;onChange:(value:SummaryLayout)=>void}) {
  return <fieldset className="widget-settings-group">
    <legend>整机摘要布局</legend>
    <div className="flex flex-wrap gap-1" role="group" aria-label="整机摘要布局">
      {summaryLayouts.map(option=><Button key={option.value} size="sm" className="compact-button" variant={value===option.value?'primary':'secondary'} aria-pressed={value===option.value} disabled={disabled} onClick={()=>onChange(option.value)}>{option.label}</Button>)}
      <HelpPopover label="整机摘要布局说明">自动模式在组件内容宽度达到 400 像素时分栏，较窄时显示两行；也可固定为分栏或两行。物理内存为已用／总容量，Swap 单独显示已用量。整机 CPU 上限为 100%，列表 CPU 仍按单核 100% 计。应用足迹包含压缩和换出等记账，不能相加作为整机物理内存。</HelpPopover>
    </div>
  </fieldset>;
}

export function SystemSummary({system,layout}:{system?:SystemInfo;layout:SummaryLayout}) {
  const gib=1024**3;
  const valid=(value:number|null|undefined):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
  const total=system?.totalMemory,used=system?.usedMemory;
  const usedText=valid(used)?(used/gib).toFixed(1):'—';
  const totalText=valid(total)&&total>0?(total/gib).toFixed(total%gib===0?0:1):'—';
  const cpuText=valid(system?.cpuUsage)?cpu(system.cpuUsage):'—';
  const swapText=bytes(system?.swapUsed);
  return <section className="widget-system-summary" data-layout={layout} aria-label="整机资源摘要">
    <dl className="widget-summary-columns grid-cols-3 gap-2">
      <div className="min-w-0"><dt>整机 CPU</dt><dd>{cpuText}</dd><small>整机上限 100%</small></div>
      <div className="min-w-0"><dt>物理内存</dt><dd><span>{usedText}</span><span className="widget-summary-capacity"> / {totalText} GiB</span></dd><small>已用 / 总容量</small></div>
      <div className="min-w-0"><dt>Swap 已用</dt><dd>{swapText}</dd></div>
    </dl>
    <div className="widget-summary-compact grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2">
      <strong>整机 CPU {cpuText}</strong>
      <div className="widget-summary-memory flex flex-col items-end gap-1 whitespace-nowrap"><span>物理已用 {valid(used)?bytes(used):'—'}</span><span>Swap 已用 {swapText}</span></div>
    </div>
  </section>;
}
