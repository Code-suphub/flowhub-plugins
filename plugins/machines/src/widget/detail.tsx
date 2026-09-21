import '../../ui/widget/detail.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, DialogShell, Select } from '@flowhub/plugin-common/react';
import type { WidgetContext } from './types';

const metrics = { load: '负载', cpu: 'CPU', memory: '内存', disk: '磁盘', rx: '下载速度', tx: '上传速度' } as const;
const ranges = [{ value: '3600', label: '最近 1 小时' }, { value: '86400', label: '最近 1 天' }, { value: '604800', label: '最近 7 天' }, { value: '2592000', label: '最近 30 天' }, { value: '7776000', label: '最近 90 天' }];
type HistoryResult = { unit?: string; data?: Array<[number, number | null]> };

function Chart({ metric, result, onZoom }: { metric: keyof typeof metrics; result?: HistoryResult; onZoom: () => void }) {
  const rows = result?.data ?? []; const valid = rows.filter((item) => Number.isFinite(item[1])); const max = Math.max(1, ...valid.map((item) => item[1] as number)); let path = ''; let pen = false;
  rows.forEach(([time, value], index) => { if (!Number.isFinite(value)) { pen = false; return; } const x = 60 + index / (rows.length - 1 || 1) * 680; const y = 260 - (value as number) / max * 240; path += `${pen ? 'L' : 'M'}${x},${y} `; pen = true; });
  return <section className="chart-card" tabIndex={0} role="button" aria-label={`放大${metrics[metric]}曲线`} onClick={onZoom} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onZoom(); } }}><div className="chart-head"><h2>{metrics[metric]}</h2><span>{valid.length ? `最近采样 ${(valid.at(-1)![1] as number).toFixed(2)} ${result?.unit ?? ''}` : '暂无数据'}</span></div>{valid.length ? <svg viewBox="0 0 760 310" role="img" aria-label={`${metrics[metric]}历史曲线`}>{[0, 1, 2, 3, 4].map((step) => <g key={step}><line x1="60" x2="740" y1={20 + step * 60} y2={20 + step * 60} /><text x="5" y={24 + step * 60}>{(max * (1 - step / 4)).toFixed(1)}</text></g>)}<path d={path} /><text x="60" y="292">{new Date(rows[0][0] * 1000).toLocaleString()}</text><text x="740" y="292" textAnchor="end">{new Date(rows.at(-1)![0] * 1000).toLocaleString()}</text></svg> : <div className="chart-empty">这个时间范围没有已保存的采样。</div>}</section>;
}

function Detail({ context }: { context: WidgetContext }) {
  const [range, setRange] = useState('86400'); const [results, setResults] = useState<Record<string, HistoryResult>>({}); const [loading, setLoading] = useState(false); const [zoom, setZoom] = useState<keyof typeof metrics | null>(null); const row = (context.config?.row as string) || context.snapshot?.rows?.[0]?.id || ''; const name = context.title || context.snapshot?.rows?.find((item) => item.id === row)?.name || '机器详情';
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const entries = await Promise.all(Object.keys(metrics).map(async (metric): Promise<[string, HistoryResult]> => {
        const result = context.preview
          ? {
              unit: metric === 'rx' || metric === 'tx' ? 'KB/s' : metric === 'load' ? '' : '%',
              data: Array.from({ length: 90 }, (_, index) => [
                Date.now() / 1000 - Number(range) + index * Number(range) / 89,
                index > 35 && index < 43 ? null : Math.max(0, metric === 'load' ? 1 + Math.sin(index / 8) : 40 + 20 * Math.sin(index / 8)),
              ] as [number, number | null]),
            }
          : await (window as Window & { FlowHubWidget: { invoke(params: Record<string, unknown>): Promise<unknown> } }).FlowHubWidget.invoke({ action: 'history', row, metric, seconds: Number(range) });
        return [metric, result as HistoryResult];
      }));
      setResults(Object.fromEntries(entries));
    } finally {
      setLoading(false);
    }
  }, [context.preview, range, row]);
  useEffect(() => { void load(); }, [load]);
  const zoomResult = zoom ? results[zoom] : undefined;
  return <><header><small>机器监控</small><h1>{name}</h1><p id="identity">{context.preview ? '浏览器预览 · 模拟数据' : row}</p></header><nav className="detail-tabs" aria-label="详情页面"><Button variant="ghost" aria-pressed="true">监控曲线</Button><Button variant="ghost" onClick={() => { location.href = `machines.html?widgetSettings=1&row=${encodeURIComponent(row)}${location.hash}`; }}>设置</Button></nav><main><div className="toolbar"><Button size="sm" onClick={() => void load()} disabled={loading}>{loading ? '读取中…' : '刷新'}</Button><label>时间范围<Select options={ranges} value={range} onChange={setRange} ariaLabel="时间范围" /></label></div><div id="charts">{Object.keys(metrics).map((metric) => <Chart key={metric} metric={metric as keyof typeof metrics} result={results[metric]} onZoom={() => setZoom(metric as keyof typeof metrics)} />)}</div><p className="note">显示已保存的监控采样。未采集、FlowHub 未运行的时段保留空档。</p></main><DialogShell open={zoom !== null} onOpenChange={(open) => !open && setZoom(null)} title={zoom ? metrics[zoom] : ''} contentClassName="zoom-content">{zoom && <Chart metric={zoom} result={zoomResult} onZoom={() => undefined} />}</DialogShell></>;
}

const root = document.querySelector('#widget-root');
const bridge = (window as Window & { FlowHubWidget: { onInit(handler: (context: WidgetContext) => void): void } }).FlowHubWidget;
if (root) bridge.onInit((context) => createRoot(root).render(<Detail context={context as WidgetContext} />));
