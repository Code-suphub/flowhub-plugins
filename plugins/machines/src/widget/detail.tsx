import './detail-styles.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, DialogShell, Select } from '@flowhub/plugin-common/react';
import type { WidgetContext } from './types';
import { TimeSeriesChart } from '../monitoring/TimeSeriesChart';
import { HISTORY_METRICS, HISTORY_METRIC_KEYS, HISTORY_RANGES, type HistoryMetric } from '../monitoring/history-metrics';

type HistoryResult = { unit?: string; data?: Array<[number, number | null]>; error?: string };

function Chart({ metric, result, onZoom }: { metric: HistoryMetric; result?: HistoryResult; onZoom?: () => void }) {
  const valid = result?.data?.filter((item) => Number.isFinite(item[1])) ?? [];
  return <section className="chart-card"><div className="chart-head"><h2>{HISTORY_METRICS[metric]}</h2><span>{valid.length ? `最近采样 ${(valid.at(-1)![1] as number).toFixed(2)} ${result?.unit ?? ''}` : '暂无数据'}</span>{onZoom ? <Button size="sm" variant="ghost" onClick={onZoom}>放大</Button> : null}</div>{valid.length ? <TimeSeriesChart rows={result!.data!} series={[HISTORY_METRICS[metric]]} unit={result?.unit} colors={['#f7a454']} label={`${HISTORY_METRICS[metric]}历史曲线`} /> : <div className="chart-empty" role={result?.error ? "alert" : "status"}>{result?.error || (!result ? "正在读取历史…" : "这个时间范围没有已保存的采样。")}</div>}</section>;
}

function Detail({ context }: { context: WidgetContext }) {
  const [range, setRange] = useState('86400'); const [results, setResults] = useState<Record<string, HistoryResult>>({}); const [loading, setLoading] = useState(false); const [zoom, setZoom] = useState<HistoryMetric | null>(null); const row = (context.config?.row as string) || context.snapshot?.rows?.[0]?.id || ''; const name = context.title || context.snapshot?.rows?.find((item) => item.id === row)?.name || '机器详情';
  const request = useRef(0);
  const load = useCallback(async () => {
    const token = ++request.current;
    setLoading(true);
    setResults({});
    try {
      const entries = await Promise.all(HISTORY_METRIC_KEYS.map(async (metric): Promise<[string, HistoryResult]> => {
        try {
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
        } catch (error) {
          return [metric, { error: `历史读取失败：${String(error)}` }];
        }
      }));
      if (token === request.current) setResults(Object.fromEntries(entries));
    } finally {
      if (token === request.current) setLoading(false);
    }
  }, [context.preview, context.snapshot, range, row]);
  useEffect(() => { void load(); return () => { request.current++; }; }, [load]);
  const zoomResult = zoom ? results[zoom] : undefined;
  return <><header><small>机器监控</small><h1>{name}</h1><p id="identity">{context.preview ? '浏览器预览 · 模拟数据' : row}</p></header><nav className="detail-tabs" aria-label="详情页面"><Button variant="ghost" aria-pressed="true">监控曲线</Button><Button variant="ghost" onClick={() => { location.href = `machines.html?widgetSettings=1&row=${encodeURIComponent(row)}${location.hash}`; }}>设置</Button></nav><main><div className="toolbar"><Button size="sm" onClick={() => void load()} disabled={loading}>{loading ? '读取中…' : '刷新'}</Button><label>时间范围<Select options={HISTORY_RANGES} value={range} onChange={setRange} ariaLabel="时间范围" /></label></div><div id="charts">{HISTORY_METRIC_KEYS.map((metric) => <Chart key={metric} metric={metric} result={results[metric]} onZoom={() => setZoom(metric)} />)}</div><p className="note">显示已保存的监控采样。未采集、FlowHub 未运行的时段保留空档。</p></main><DialogShell open={zoom !== null} onOpenChange={(open) => !open && setZoom(null)} title={zoom ? HISTORY_METRICS[zoom] : ''} contentClassName="zoom-content">{zoom && <Chart metric={zoom} result={zoomResult} />}</DialogShell></>;
}

const root = document.querySelector('#widget-root');
const bridge = (window as Window & { FlowHubWidget: { onInit(handler: (context: WidgetContext) => void): void } }).FlowHubWidget;
if (root) {
  const app = createRoot(root);
  bridge.onInit((context) => app.render(<Detail context={context} />));
}
