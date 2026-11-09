import { useEffect, useState } from 'react';
import { Button, EmptyState, Select, Tabs } from '@flowhub/plugin-common/react';
import type { MachinesApi } from '../api/machines';
import type { HistoryJob } from '../history/types';
import { TimeSeriesChart } from '../monitoring/TimeSeriesChart';
import type { FleetHost, FleetHostAction, FleetMetric } from './types';
import { fleetMetricStatus } from './types';

interface Props {
  host?: FleetHost;
  metric?: FleetMetric;
  interval: number;
  now: number;
  api: MachinesApi | null;
  active: boolean;
  jobs: readonly HistoryJob[];
  disabled: boolean;
  onClose: () => void;
  onAction: (action: FleetHostAction) => void;
}
type History = { data?: [number, number | null][]; unit?: string };
type CollectionSample = { id: string; at: number; status: string; error?: string | null };
const labels: Record<string, string> = { success: '采集成功', failed: '采集失败', timeout: '采集超时', stale: '采集已过期', unknown: '未采集', cancelled: '采集已取消', interrupted: '采集结果未知', queued: '排队中', running: '采集中' };

/** Reads saved history only. Inspecting a machine never probes or opens SSH. */
function InspectorHistory({ api, hostId, active }: { api: MachinesApi | null; hostId: string; active: boolean }) {
  const [range, setRange] = useState('3600');
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ hostId: string; range: string; data?: History; error?: string; loading: boolean }>();
  useEffect(() => {
    if (!api || !active) return;
    let disposed = false;
    setResult(current => ({ hostId, range, data: current?.hostId === hostId && current.range === range ? current.data : undefined, loading: true }));
    void api('metricHistory', { hostId, metric: 'cpu', seconds: Number(range) }).then(data => {
      if (!disposed) setResult({ hostId, range, data: data as History, loading: false });
    }).catch(error => {
      if (!disposed) setResult(current => ({ hostId, range, data: current?.hostId === hostId && current.range === range ? current.data : undefined, error: String(error instanceof Error ? error.message : error), loading: false }));
    });
    return () => { disposed = true; };
  }, [api, hostId, active, range, attempt]);
  const current = result?.hostId === hostId && result.range === range ? result : undefined;
  return <section className="machine-inspector__history" aria-label="CPU 历史">
    <div className="machine-inspector__chart-tools"><span>CPU 历史</span><Select aria-label="详情历史范围" value={range} onChange={setRange} options={[{ value: '3600', label: '最近 1 小时' }, { value: '86400', label: '最近 1 天' }]} /></div>
    {current?.error ? <div role="alert"><p>历史读取失败：{current.error}</p><Button size="sm" variant="ghost" onClick={() => setAttempt(value => value + 1)}>重试</Button></div> : null}
    {current?.data ? <><TimeSeriesChart compact rows={current.data.data ?? []} series={['CPU']} unit={current.data.unit ?? '%'} label="选中机器的 CPU 历史" />{current.loading ? <p role="status">正在刷新历史…</p> : null}</>
      : <p role="status">{!api ? '当前环境无法读取历史' : current?.error ? '未取得历史采样' : '正在读取历史…'}</p>}
  </section>;
}

export function MachineInspector({ host, metric, interval, now, api, active, jobs, disabled, onClose, onAction }: Props) {
  const [tab, setTab] = useState('overview');
  const [saved, setSaved] = useState<{ hostId: string; items?: CollectionSample[]; error?: string }>();
  const hostId = host?.id;
  useEffect(() => {
    if (!api || !active || tab !== 'collections' || !hostId) return;
    let disposed = false;
    void api('collectionHistory', { hostId }).then(items => {
      if (!disposed) setSaved({ hostId, items: items as CollectionSample[] });
    }).catch(error => {
      if (!disposed) setSaved({ hostId, error: String(error instanceof Error ? error.message : error) });
    });
    return () => { disposed = true; };
  }, [api, active, tab, hostId, metric?.at]);
  const status = fleetMetricStatus(metric, interval, now);
  const values = status === 'success' ? metric?.values : undefined;
  const stored = saved?.hostId === hostId ? saved : undefined;
  const records: CollectionSample[] = stored?.items ?? jobs.filter(job => job.hostId === hostId && job.kind === 'collect').slice(0, 10).map(job => ({ id: job.id, status: job.status, at: job.finishedAt ?? job.startedAt }));
  return <aside className="machine-inspector" aria-label="机器详情">
    <header className="machine-inspector__header"><Button size="sm" variant="ghost" onClick={onClose} aria-label="返回机器列表">← 返回机器</Button><span>{host?.group || '未分组'}</span><Button size="sm" variant="ghost" onClick={onClose} aria-label="收起详情">收起</Button></header>
    {!host ? <EmptyState title="目标机器已移除" description="返回列表重新选择；不会将操作转移到另一台机器。" /> : <>
      <div className="machine-inspector__identity"><h2>{host.name}</h2><code>{host.alias}</code>{host.readOnly ? <span>仅查询</span> : null}</div>
      <Tabs value={tab} onValueChange={setTab}>
        <Tabs.List aria-label="机器详情页面"><Tabs.Trigger value="overview">概览</Tabs.Trigger><Tabs.Trigger value="connection">连接</Tabs.Trigger><Tabs.Trigger value="collections">采集记录</Tabs.Trigger></Tabs.List>
        <Tabs.Panel value="overview" forceMount>
          <dl className="machine-inspector__facts"><div><dt>最近采集</dt><dd data-status={status}>{labels[status]}{metric?.at ? ` · ${new Date(metric.at).toLocaleTimeString()}` : ''}</dd></div><div><dt>连接状态</dt><dd>在任务与会话中查看</dd></div></dl>
          {metric?.error ? <p className="machine-inspector__error" role="alert">{metric.error}</p> : null}
          <div className="machine-inspector__metrics">{([['cpu', 'CPU'], ['memory', '内存'], ['disk', '根磁盘']] as const).map(([key, label]) => <div key={key}><span>{label}</span><strong>{Number.isFinite(values?.[key]) ? values![key].toFixed(1) : '—'}{Number.isFinite(values?.[key]) ? <small>%</small> : null}</strong><div className="machine-inspector__track"><span style={{ width: `${Math.min(100, Math.max(0, values?.[key] ?? 0))}%` }} /></div></div>)}</div>
          <dl className="machine-inspector__facts"><div><dt>运行时长</dt><dd>{Number.isFinite(values?.uptime) ? `${Math.floor(values!.uptime / 86400)} 天 ${Math.floor(values!.uptime % 86400 / 3600)} 时` : '—'}</dd></div><div><dt>系统负载</dt><dd>{Number.isFinite(values?.load) ? values!.load.toFixed(2) : '—'}</dd></div></dl>
          <InspectorHistory api={api} hostId={host.id} active={active && tab === 'overview'} />
        </Tabs.Panel>
        <Tabs.Panel value="connection" forceMount><dl className="machine-inspector__facts"><div><dt>连接标识</dt><dd>{host.alias}</dd></div><div><dt>方式</dt><dd>{host.bastion ? '堡垒机 / 共享会话' : 'SSH'}</dd></div><div><dt>权限</dt><dd>{host.readOnly ? '仅查询' : '按配置授权'}</dd></div></dl><p>查看详情不会建立连接；可打开现有配置查看和测试。</p><Button size="sm" disabled={disabled} onClick={() => onAction('connection')}>管理连接配置</Button></Tabs.Panel>
        <Tabs.Panel value="collections" forceMount><div className="machine-inspector__records">
          {stored?.error ? <p className="machine-inspector__error" role="alert">{stored.error}</p> : null}
          {records.length ? records.map(sample => <section key={sample.id}>
            <div><span>{labels[sample.status] ?? sample.status}</span><time>{new Date(sample.at).toLocaleString()}</time></div>
            {sample.error ? <p className="machine-inspector__error">{sample.error}</p> : null}
          </section>) : <EmptyState size="compact" title="暂无近期采集记录" />}
          <Button size="sm" variant="ghost" onClick={() => onAction('collections')}>查看采集输出</Button>
        </div></Tabs.Panel>
      </Tabs>
      <footer className="machine-inspector__actions"><Button variant="primary" disabled={disabled} onClick={() => onAction('command')}>执行命令</Button><Button disabled={disabled} onClick={() => onAction('edit')}>编辑配置</Button></footer>
    </>}
  </aside>;
}
