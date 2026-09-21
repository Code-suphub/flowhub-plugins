import { useEffect, useRef, useState } from 'react';
import { Button, DialogShell, EmptyState, Field, HelpPopover, Input, Select, Tabs } from '@flowhub/plugin-common/react';
import type { MachinesApi } from '../api/machines';
import './settings.css';

interface Host { id: string; name: string }
interface Exporter { url: string; device: string }
interface Config { hosts: Host[]; retentionDays?: number; exporters?: Record<string, Exporter> }
interface History { unit: string; data: [number, number | null][] }
const metrics = [{ value: 'cpu', label: 'CPU 使用率' }, { value: 'memory', label: '内存使用率' }, { value: 'disk', label: '根磁盘使用率' }, { value: 'load', label: '负载' }, { value: 'rx', label: '下载速率' }, { value: 'tx', label: '上传速率' }];
const ranges = [{ value: '3600', label: '最近 1 小时' }, { value: '86400', label: '最近 1 天' }, { value: '604800', label: '最近 7 天' }, { value: '2592000', label: '最近 30 天' }, { value: '7776000', label: '最近 90 天' }];

function HistoryChart({ history }: { history: History }) {
  const valid = history.data.filter((row): row is [number, number] => Number.isFinite(row[1]));
  if (!valid.length) return <EmptyState size="compact" title="此时间范围暂无采样" />;
  let min = 0, max = 1;
  for (const [, value] of valid) { min = Math.min(min, value); max = Math.max(max, value); }
  const first = history.data[0][0], last = history.data[history.data.length - 1][0];
  let path = '', pen = false;
  const points = history.data.map(([time, value]) => {
    if (value === null || !Number.isFinite(value)) { pen = false; return null; }
    const x = 40 + (time - first) / (last - first || 1) * 610, y = 175 - (value - min) / (max - min) * 140;
    path += `${pen ? 'L' : 'M'}${x},${y} `; pen = true;
    return { x, y, time, value };
  });
  return <figure className="monitor-settings__chart">
    <svg viewBox="0 0 690 210" role="img" aria-label="本地监控历史曲线，缺失采样处断开">
      <text x="8" y="18">{max.toFixed(1)} {history.unit}</text><text x="8" y="190">{min.toFixed(1)}</text>
      <path d={path} fill="none" stroke="#a9e0b8" strokeWidth="2" />
      {points.map((point, index) => point ? <circle key={index} cx={point.x} cy={point.y} r="2" fill="#a9e0b8"><title>{new Date(point.time * 1000).toLocaleString()} · {point.value.toFixed(2)} {history.unit}</title></circle> : null)}
    </svg>
    <figcaption><time>{new Date(first * 1000).toLocaleString()}</time><time>{new Date(last * 1000).toLocaleString()}</time></figcaption>
  </figure>;
}

function SettingsSession({ api, onSaved }: { api: MachinesApi; onSaved: () => void }) {
  const [tab, setTab] = useState('settings');
  const [config, setConfig] = useState<Config | null>(null);
  const [days, setDays] = useState('30');
  const [exporters, setExporters] = useState<Record<string, Exporter>>({});
  const [hostId, setHostId] = useState('');
  const [metric, setMetric] = useState('cpu');
  const [range, setRange] = useState('86400');
  const [history, setHistory] = useState<History | null>(null);
  const [status, setStatus] = useState<{ error: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true), pending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

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
      setExporters(state.config.exporters ?? {}); setHostId(state.config.hosts[0]?.id ?? '');
    });
  }
  useEffect(() => { void load(); }, [api]);

  function changeExporter(id: string, field: keyof Exporter, value: string) {
    setExporters(current => ({ ...current, [id]: { ...(current[id] ?? { url: '', device: '' }), [field]: value } }));
    setStatus(null);
  }
  if (!config) return <div aria-busy={busy}>{status?.error ? <><p role="alert">读取失败：{status.text}</p><Button onClick={() => void load()} disabled={busy}>重试</Button></> : <p role="status">正在读取监控配置…</p>}</div>;
  return <Tabs value={tab} onValueChange={value => { if (!busy) { setTab(value); setStatus(null); } }}>
    <Tabs.List aria-label="监控设置页签"><Tabs.Trigger value="settings" disabled={busy}>采集设置</Tabs.Trigger><Tabs.Trigger value="history" disabled={busy}>历史曲线</Tabs.Trigger></Tabs.List>
    <Tabs.Panel value="settings">
      <form className="monitor-settings__form" onSubmit={event => {
        event.preventDefault();
        void run(async () => {
          const retention = Number(days);
          if (!Number.isInteger(retention) || retention < 1 || retention > 365) throw new Error('保留时长须为 1–365 的整数');
          const next: Record<string, Exporter> = {};
          for (const host of config.hosts) { const value = exporters[host.id]; if (value?.url.trim()) next[host.id] = { url: value.url.trim(), device: value.device?.trim() || '' }; }
          await api('monitorSettings', { days: retention, exporters: next });
          // Persisted changes still refresh the parent if this dialog was closed while saving.
          onSaved();
          if (!alive.current) return;
          setConfig({ ...config, retentionDays: retention, exporters: next });
          setHistory(null);
          setStatus({ error: false, text: '监控设置已保存。' });
        });
      }}>
        <div className="monitor-settings__retention"><Field label="历史保留天数" htmlFor="monitor-retention"><Input id="monitor-retention" type="text" inputMode="numeric" pattern="[0-9]+" required value={days} disabled={busy} onChange={event => { setDays(event.currentTarget.value); setStatus(null); }} /></Field><HelpPopover label="历史保留说明">默认 30 天，可设 1–365 天，最多保留 20 万条采样。缩短时长会清理过期监控数据，命令执行记录不受影响。FlowHub 未运行期间保留空档，不补造历史。</HelpPopover></div>
        <div className="monitor-settings__heading"><h3>机器采集来源</h3><HelpPopover label="采集来源说明">填写 Node Exporter 的完整 metrics 地址；留空使用 SSH。配置后连接失败会报错，不自动切换来源。网卡留空时汇总常见非虚拟网卡。定时采集需在机器列表开启后台监控。</HelpPopover></div>
        {config.hosts.map(host => <section key={host.id} className="monitor-settings__source" aria-label={host.name}>
          <strong>{host.name}</strong><div className="monitor-settings__fields">
            <Field label="Exporter 地址" htmlFor={`exporter-${host.id}`}><Input id={`exporter-${host.id}`} type="url" placeholder="http://机器地址:9100/metrics" value={exporters[host.id]?.url ?? ''} disabled={busy} onChange={event => changeExporter(host.id, 'url', event.currentTarget.value)} /></Field>
            <Field label="网卡（可选）" htmlFor={`device-${host.id}`}><Input id={`device-${host.id}`} maxLength={100} placeholder="例如 eth0" value={exporters[host.id]?.device ?? ''} disabled={busy} onChange={event => changeExporter(host.id, 'device', event.currentTarget.value)} /></Field>
          </div>
          <Button size="sm" variant="ghost" disabled={busy || !exporters[host.id]?.url.trim()} onClick={() => void run(async () => {
            const value = exporters[host.id];
            await api('exporterTest', { url: value.url.trim(), device: value.device?.trim() || '' });
            if (alive.current) setStatus({ error: false, text: `${host.name}：Exporter 连接成功。` });
          })}>测试 Exporter</Button>
        </section>)}
        {!config.hosts.length ? <EmptyState size="compact" title="请先添加机器" /> : null}
        {Number(days) < (config.retentionDays || 30) ? <p className="monitor-settings__warning">保存将清理超过 {days} 天的监控数据，此操作不可撤销。</p> : null}
        <div className="monitor-settings__actions"><Button type="submit" variant="primary" disabled={busy}>{busy ? '处理中…' : '保存监控设置'}</Button></div>
      </form>
    </Tabs.Panel>
    <Tabs.Panel value="history"><div className="monitor-settings__form">
      <div className="monitor-settings__queries">
        <Select ariaLabel="机器" value={hostId} options={config.hosts.map(host => ({ value: host.id, label: host.name }))} disabled={busy} onChange={value => { setHostId(value); setHistory(null); }} />
        <Select ariaLabel="指标" value={metric} options={metrics} disabled={busy} onChange={value => { setMetric(value); setHistory(null); }} />
        <Select ariaLabel="时间范围" value={range} options={ranges} disabled={busy} onChange={value => { setRange(value); setHistory(null); }} />
      </div><div className="monitor-settings__actions"><Button disabled={busy || !hostId} onClick={() => void run(async () => {
        setHistory(null);
        const result = await api('metricHistory', { hostId, metric, seconds: Number(range) }) as History;
        if (alive.current) setHistory(result);
      })}>{busy ? '读取中…' : '查看曲线'}</Button></div>
      {history ? <HistoryChart history={history} /> : <p>选择机器和时间范围后查询。</p>}
    </div></Tabs.Panel>
    {status ? <p className="monitor-settings__status" data-error={status.error} role={status.error ? 'alert' : 'status'}>{status.text}</p> : null}
  </Tabs>;
}

export function MonitorSettings({ api, onSaved }: { api: MachinesApi | null; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  return <><Button disabled={!api} onClick={() => setOpen(true)}>监控设置</Button>
    <DialogShell open={open} onOpenChange={setOpen} title="监控设置" className="monitor-settings" contentClassName="monitor-settings__shell">
      {open && api ? <SettingsSession api={api} onSaved={onSaved} /> : null}
    </DialogShell></>;
}
