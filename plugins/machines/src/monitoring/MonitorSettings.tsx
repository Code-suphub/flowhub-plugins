import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, DialogShell, Field, HelpPopover, Input, Combobox, Select, Tabs } from '@flowhub/plugin-common/react';
import type { MachinesApi } from '../api/machines';
import { TimeSeriesChart } from './TimeSeriesChart';
import { HISTORY_METRICS, HISTORY_METRIC_KEYS, HISTORY_RANGES, type HistoryMetric } from './history-metrics';
import './settings.css';

interface Host { id: string; name: string }
interface Config { hosts: Host[]; retentionDays?: number; interval?: number; monitoring?: boolean }
interface History { unit?: string; data?: [number, number | null][]; error?: string }
const intervals = [{ value: '30', label: '每 30 秒' }, { value: '60', label: '每 60 秒' }, { value: '300', label: '每 5 分钟' }, { value: '900', label: '每 15 分钟' }];

function HistoryChart({ metric, history, onZoom }: { metric: HistoryMetric; history?: History; onZoom?: () => void }) {
  const valid = history?.data?.filter(row => Number.isFinite(row[1])) ?? [];
  return <section className="monitor-settings__chart">
    <div className="monitor-settings__chart-head"><h3>{HISTORY_METRICS[metric]}</h3><span>{valid.length ? `最近采样 ${(valid.at(-1)![1] as number).toFixed(2)} ${history?.unit ?? ''}` : '暂无数据'}</span>{onZoom ? <Button size="sm" variant="ghost" onClick={onZoom}>放大</Button> : null}</div>
    {valid.length ? <TimeSeriesChart rows={history!.data!} series={[HISTORY_METRICS[metric]]} unit={history?.unit} colors={['#f7a454']} label={`${HISTORY_METRICS[metric]}历史曲线`} /> : <div className="monitor-settings__chart-empty" role={history?.error ? 'alert' : 'status'}>{history?.error || (!history ? '正在读取历史…' : '这个时间范围没有已保存的采样。')}</div>}
  </section>;
}

function SettingsSession({ api, onSaved }: { api: MachinesApi; onSaved: () => void }) {
  const [tab, setTab] = useState('settings');
  const [config, setConfig] = useState<Config | null>(null);
  const [days, setDays] = useState('30');
  const [interval, setInterval] = useState('60');
  const [monitoring, setMonitoring] = useState(false);
  const [hostId, setHostId] = useState('');
  const [range, setRange] = useState('86400');
  const [history, setHistory] = useState<Partial<Record<HistoryMetric, History>>>({});
  const [historyLoading, setHistoryLoading] = useState(false);
  const [zoom, setZoom] = useState<HistoryMetric | null>(null);
  const [status, setStatus] = useState<{ error: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true), pending = useRef(false);
  const historyRequest = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (tab !== 'history') return;
    const token = ++historyRequest.current;
    setHistory({});
    setZoom(null);
    if (!hostId) { setHistoryLoading(false); return; }
    setHistoryLoading(true);
    void Promise.all(HISTORY_METRIC_KEYS.map(async (metric): Promise<readonly [HistoryMetric, History]> => {
      try { return [metric, await api('metricHistory', { hostId, metric, seconds: Number(range) }) as History]; }
      catch (reason) { return [metric, { error: `历史读取失败：${String(reason instanceof Error ? reason.message : reason)}` }]; }
    })).then(entries => {
      if (alive.current && token === historyRequest.current) setHistory(Object.fromEntries(entries));
    }).finally(() => {
      if (alive.current && token === historyRequest.current) setHistoryLoading(false);
    });
    return () => { historyRequest.current++; };
  }, [api, hostId, range, tab]);

  async function run(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setStatus(null);
    try { await work(); }
    catch (reason) { if (alive.current) setStatus({ error: true, text: String(reason instanceof Error ? reason.message : reason) }); }
    finally { if (alive.current) { pending.current = false; setBusy(false); } }
  }
  function load() {
    return run(async () => {
      const state = await api('state') as { config: Config };
      if (!alive.current) return;
      setConfig(state.config); setDays(String(state.config.retentionDays || 30));
      setInterval(String(state.config.interval || 60)); setMonitoring(Boolean(state.config.monitoring)); setHostId(state.config.hosts[0]?.id ?? '');
    });
  }
  useEffect(() => { void load(); }, [api]);

  if (!config) return <div aria-busy={busy}>{status?.error ? <><p role="alert">读取失败：{status.text}</p><Button onClick={() => void load()} disabled={busy}>重试</Button></> : <p role="status">正在读取监控配置…</p>}</div>;
  return <Tabs value={tab} onValueChange={value => { if (!busy) { setTab(value); setStatus(null); } }}>
    <Tabs.List aria-label="监控设置页签"><Tabs.Trigger value="settings" disabled={busy}>全局采集</Tabs.Trigger><Tabs.Trigger value="history" disabled={busy}>历史曲线</Tabs.Trigger></Tabs.List>
    <Tabs.Panel value="settings">
      <form className="monitor-settings__form" onSubmit={event => {
        event.preventDefault();
        void run(async () => {
          const retention = Number(days);
          if (!Number.isInteger(retention) || retention < 1 || retention > 365) throw new Error('保留时长须为 1–365 的整数');
          await api('monitorSettings', { days: retention, interval: Number(interval), enabled: monitoring });
          // Persisted changes still refresh the parent if this dialog was closed while saving.
          onSaved();
          if (!alive.current) return;
          setConfig({ ...config, retentionDays: retention, interval: Number(interval), monitoring });
          setHistory({});
          setStatus({ error: false, text: '监控设置已保存。' });
        });
      }}>
        <p className="monitor-settings__intro">这些设置适用于所有机器。单机 SSH / Node Exporter 来源请到“编辑机器 → 监控与流量”配置。</p>
        <div className="monitor-settings__monitoring"><Checkbox label="后台监控" checked={monitoring} disabled={busy} onChange={setMonitoring} /><HelpPopover label="后台监控说明">仅在 FlowHub 运行且电脑保持唤醒时按采集间隔工作；失败后会逐步延长重试间隔。</HelpPopover></div>
        <Field label="采集间隔" htmlFor="monitor-interval"><Select id="monitor-interval" value={interval} disabled={busy} options={intervals.some(item => item.value === interval) ? intervals : [{ value: interval, label: `每 ${interval} 秒` }, ...intervals]} onChange={setInterval} /></Field>
        <div className="monitor-settings__retention"><div className="monitor-settings__retention-label"><label className="fh-field__label pointer-events-none" htmlFor="monitor-retention">历史保留天数</label><HelpPopover label="历史保留说明">默认 30 天，可设 1–365 天，最多保留 20 万条采样。缩短时长会清理过期监控数据，命令执行记录不受影响。FlowHub 未运行期间保留空档，不补造历史。</HelpPopover></div><Input id="monitor-retention" type="text" inputMode="numeric" pattern="[0-9]+" required value={days} disabled={busy} onChange={event => { setDays(event.currentTarget.value); setStatus(null); }} /></div>
        {Number(days) < (config.retentionDays || 30) ? <p className="monitor-settings__warning">保存将清理超过 {days} 天的监控数据，此操作不可撤销。</p> : null}
        <div className="monitor-settings__actions"><Button type="submit" variant="primary" disabled={busy}>{busy ? '处理中…' : '保存监控设置'}</Button></div>
      </form>
    </Tabs.Panel>
    <Tabs.Panel value="history"><div className="monitor-settings__form">
      <div className="monitor-settings__queries">
        <Combobox placeholder="搜索机器" ariaLabel="机器" value={hostId} options={config.hosts.map(host => ({ value: host.id, label: host.name }))} disabled={busy} onChange={setHostId} />
        <Select ariaLabel="时间范围" value={range} options={HISTORY_RANGES} disabled={busy} onChange={setRange} />
      </div>
      {hostId ? <div className="monitor-settings__charts" aria-busy={historyLoading}>{HISTORY_METRIC_KEYS.map(metric => <HistoryChart key={metric} metric={metric} history={history[metric]} onZoom={() => setZoom(metric)} />)}</div> : <p>请选择机器以查看历史曲线。</p>}
      <p className="monitor-settings__intro">显示已保存的监控采样。未采集、FlowHub 未运行的时段保留空档。</p>
    </div></Tabs.Panel>
    {status ? <p className="monitor-settings__status" data-error={status.error} role={status.error ? 'alert' : 'status'}>{status.text}</p> : null}
    <DialogShell open={zoom !== null} onOpenChange={open => !open && setZoom(null)} title={zoom ? HISTORY_METRICS[zoom] : ''} className="monitor-settings__zoom">
      {zoom ? <HistoryChart metric={zoom} history={history[zoom]} /> : null}
    </DialogShell>
  </Tabs>;
}

export function MonitorSettings({ api, onSaved }: { api: MachinesApi | null; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  return <><Button disabled={!api} onClick={() => setOpen(true)}>监控设置</Button>
    <DialogShell open={open} onOpenChange={setOpen} title="监控设置" className="monitor-settings" contentClassName="monitor-settings__shell">
      {open && api ? <SettingsSession api={api} onSaved={onSaved} /> : null}
    </DialogShell></>;
}
