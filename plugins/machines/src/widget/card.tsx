import '../../ui/widget/card.css';
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { flag, expiry, traffic } from './metadata.cjs';
import type { WidgetContext, WidgetRow } from './types';

const labels: Record<string, string> = { healthy: '正常', error: '异常', stale: '已过期', unknown: '未采集' };
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;

function Gauge({ label, value }: { label: string; value: number | null }) {
  const amount = value == null ? 0 : Math.max(0, Math.min(100, value));
  return <div className={`fh-gauge ${amount >= 85 ? 'warning' : ''}`}><svg viewBox="0 0 100 86" role="img" aria-label={`${label} ${value == null ? '无数据' : `${value.toFixed(1)}%`}`}><path className="track" d="M 16 67 A 39 39 0 1 1 84 67" pathLength="100"/><path className="fill" d="M 16 67 A 39 39 0 1 1 84 67" pathLength="100" strokeDasharray={`${amount} 100`}/><text x="50" y="48">{value == null ? '—' : `${Math.round(value)}%`}</text><text className="unit" x="50" y="65">{label}</text></svg></div>;
}

function Network({ row, metrics }: { row: WidgetRow; metrics: string[] }) {
  const hasRates = metrics.includes('tx') || metrics.includes('rx');
  const rate = (key: 'tx' | 'rx') => { const value = number(row.values?.[key]); return value == null ? '—' : value >= 1000 ? `${(value / 1000).toFixed(1)} MB/s` : `${value.toFixed(1)} KB/s`; };
  const trafficInfo = metrics.includes('traffic') ? traffic(row.traffic) : null;
  if (!trafficInfo && !hasRates) return null;
  return <div className="network-row">{trafficInfo ? <div className="traffic-metric" title={[trafficInfo.title, trafficInfo.hint].filter(Boolean).join(" · ")} aria-label={[trafficInfo.kind === 'usage' ? '流量采集结果' : '', trafficInfo.label, trafficInfo.title, trafficInfo.hint].filter(Boolean).join(" · ")}><b>{trafficInfo.label}</b></div> : <span />}{hasRates && <div className="network-rates">{metrics.includes('tx') && <span aria-label={`上传速率 ${rate('tx')}`}>↑ {rate('tx')}</span>}{metrics.includes('rx') && <span aria-label={`下载速率 ${rate('rx')}`}>↓ {rate('rx')}</span>}</div>}</div>;
}

function Card({ context }: { context: WidgetContext }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const config = context.config ?? {};
  const view = !config.view || config.view === 'widget' ? 'machine' : config.view as string;
  const rows = context.snapshot?.rows ?? [];
  const row = config.row ? rows.find((item) => item.id === config.row) : (view === 'machine' ? rows[0] : undefined);
  const metrics = Array.isArray(config.metrics) ? config.metrics as string[] : ['cpu', 'memory', 'disk'];
  const title = context.title || (config.title as string) || row?.name || '机器管理';
  if (!context.snapshot) return <article className="card"><p className="empty">正在等待插件状态…</p></article>;
  if (context.snapshot?.error) return <article className="card"><p className="empty">{context.snapshot.error}</p></article>;
  if (view === 'overview') return <article className="card"><div className="overview-total">{rows.length}<small>个实例</small></div><div className="overview-status"><span className="healthy">● {rows.filter((item) => item.status === 'healthy').length} 正常</span><span className="error">{rows.filter((item) => item.status === 'error' || item.status === 'stale').length} 异常 / 过期</span></div></article>;
  if (view !== 'machine') {
    const visible = view === 'alerts' ? rows.filter((item) => item.status !== 'healthy') : rows;
    return <article className="card"><div className="card-head"><h2>{title}</h2></div><div className="card-body">{visible.length ? visible.map((item) => <div className="row" key={item.id}><div className="row-head"><b>{item.name}</b><span className={labels[item.status ?? 'unknown'] ? item.status : 'unknown'}>● {labels[item.status ?? 'unknown'] ?? '未知'}</span></div><div className="values">{Object.entries(item.values ?? {}).filter(([, value]) => number(value) != null).slice(0, 5).map(([key, value]) => <span key={key}><small>{({ cpu: 'CPU', memory: '内存', disk: '磁盘', load: '负载', uptime: '运行秒数' } as Record<string, string>)[key] ?? key}</small>{number(value)?.toLocaleString(undefined, { maximumFractionDigits: 1 })}{['cpu', 'memory', 'disk'].includes(key) ? '%' : ''}</span>)}</div><time>{item.at ? new Date(item.at).toLocaleTimeString() : '尚无采集数据'}</time></div>) : <p className="empty">{view === 'alerts' ? '当前没有异常' : '暂无状态数据'}</p>}</div></article>;
  }
  if (!row) return <article className="card"><p className="empty">{context.snapshot ? '目标已移除或尚无数据' : '正在等待插件状态…'}</p></article>;
  const expiryInfo = config.showExpiry === false ? null : expiry(row.expiresAt, now);
  return <article className="card card--machine"><div className="card-head"><h2>{config.showCountry === false ? '' : `${flag(row.countryCode)} `}{title}</h2><span className={`status ${labels[row.status ?? 'unknown'] ? row.status : 'unknown'}`}>● {labels[row.status ?? 'unknown'] ?? '未知'}</span></div><div className="card-body"><div className="gauges">{(['cpu', 'memory', 'disk'] as const).filter((key) => metrics.includes(key)).map((key) => <Gauge key={key} label={{ cpu: 'CPU', memory: '内存', disk: '磁盘' }[key]} value={number(row.values?.[key])} />)}</div><Network row={row} metrics={metrics} /><div className="widget-foot">{metrics.some((key) => ['load', 'uptime'].includes(key)) && <div className="bottom-metrics">{metrics.includes('load') && <span>负载 {number(row.values?.load)?.toFixed(1) ?? '—'}</span>}{metrics.includes('uptime') && <span>运行 {number(row.values?.uptime) == null ? '—' : `${(number(row.values?.uptime)! / 86400).toFixed(1)}天`}</span>}</div>}{expiryInfo && <span className={`expiry ${expiryInfo.expired ? 'expired' : expiryInfo.urgent ? 'urgent' : ''}`} title={`到期时间：${new Date(row.expiresAt!).toLocaleString()}`}>{expiryInfo.text}</span>}</div></div></article>;
}

const root = document.querySelector('#widget-root');
const bridge = (window as Window & { FlowHubWidget: { onInit(handler: (context: WidgetContext) => void): void } }).FlowHubWidget;
if (root) {
  const app = createRoot(root);
  bridge.onInit((context) => app.render(<Card context={context} />));
}
