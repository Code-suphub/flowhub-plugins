import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Field, HelpPopover, Input, Select } from '@flowhub/plugin-common/react';
import { NetdataPanel } from './netdata';
import type { AsyncState, NetdataChart, NetdataDraft, NetdataHistory, NetdataHistoryQuery, NetdataInstallDraft, NetdataInstallPreview, NetdataInstance, NetdataSuggestion } from './netdata';
import { CloudTrafficPanel, CLOUD_PROVIDERS, SECRET_FIELDS, emptyCloudDraft } from '../traffic/cloud';
import type { CloudField, CloudTrafficDraft, CloudTrafficResult, CloudTrafficState } from '../traffic/cloud';
import type { HostEditorMachineApi } from '../host-editor/types';

type View = 'collector' | 'traffic' | 'netdata';
type CollectorDraft = { mode: 'ssh' | 'exporter'; url: string; device: string };
type MachineState = { config?: { hosts?: readonly { id: string; name: string; alias: string; bastion?: unknown; readOnly?: boolean }[]; netdata?: readonly NetdataInstance[]; exporters?: Record<string, { url: string; device: string }> } };
type TestResult = { charts?: readonly NetdataChart[] };
type InstallResult = { id: string };
type JobResult = { status: string; finishedAt?: number | string | null; stdout?: string; stderr?: string };

const idle = (message?: string): AsyncState => ({ status: 'idle', message });
const errorMessage = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^(?:Error:\s*)+/, '');

function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export function MonitoringWorkspace({ hostId, hostName, api, footerTarget }: { hostId: string; hostName: string; api: HostEditorMachineApi; footerTarget: HTMLElement | null }) {
  const [view, setView] = useState<View>('collector');
  const [machineState, setMachineState] = useState<MachineState>({});
  const [busy, setBusy] = useState(false);
  const [netState, setNetState] = useState<AsyncState>(idle());
  const [instances, setInstances] = useState<readonly NetdataInstance[]>([]);
  const [charts, setCharts] = useState<readonly NetdataChart[]>([]);
  const [chartLoad, setChartLoad] = useState<'idle' | 'loading' | 'error'>('idle');
  const [netDraft, setNetDraft] = useState<NetdataDraft>({ name: hostName, url: '', networkChart: 'system.net' });
  const [historyQuery, setHistoryQuery] = useState<NetdataHistoryQuery>({ instanceId: '', chartId: '', seconds: 86400 });
  const [history, setHistory] = useState<NetdataHistory>();
  const [installDraft, setInstallDraft] = useState<NetdataInstallDraft>({ hostId, port: 19999, bind: '0.0.0.0', retentionDays: 30, diskMiB: 1024 });
  const [installPreview, setInstallPreview] = useState<NetdataInstallPreview>();
  const [suggestion, setSuggestion] = useState<NetdataSuggestion>();
  const [trafficDraft, setTrafficDraft] = useState<CloudTrafficDraft>(emptyCloudDraft());
  const [trafficState, setTrafficState] = useState<CloudTrafficState>({ status: 'loading', message: '正在自动读取已保存配置…', configured: false });
  const [trafficResult, setTrafficResult] = useState<CloudTrafficResult>();
  const [trafficDirty, setTrafficDirty] = useState(false);
  const [collectorDraft, setCollectorDraft] = useState<CollectorDraft>({ mode: 'ssh', url: '', device: '' });
  const [collectorState, setCollectorState] = useState<AsyncState>(idle());
  const latestInstall = useLatest(installDraft);

  async function refreshState() {
    const next = await api('state') as MachineState;
    setMachineState(next);
    setInstances(next.config?.netdata ?? []);
    const current = next.config?.netdata?.find((item) => item.hostId === hostId);
    setNetDraft(current ? { ...current } : { name: hostName, url: '', networkChart: 'system.net' });
    setHistoryQuery((value) => ({ ...value, instanceId: current?.id ?? '' }));
    setHistory(undefined);
    return next;
  }

  function loadTrafficDraft(saved: Record<string, unknown>) {
    const next = emptyCloudDraft();
    next.provider = CLOUD_PROVIDERS.some((item) => item.id === saved.provider) ? saved.provider as CloudTrafficDraft['provider'] : 'tencent';
    for (const key of Object.keys(next) as (keyof CloudTrafficDraft)[]) {
      if (key === 'provider' || key === 'clearToken' || SECRET_FIELDS.includes(key as CloudField)) continue;
      if (typeof saved[key] === 'string' || typeof saved[key] === 'number') next[key] = String(saved[key]) as never;
    }
    setTrafficDraft(next);
    setTrafficDirty(false);
    setTrafficResult(undefined);
    const configured = saved.configured === true;
    setTrafficState({ status: configured ? 'success' : 'idle', configured, message: configured ? '已自动载入保存配置；密钥留空会沿用。' : '尚未配置，请填写后保存。' });
  }

  function loadCollectorDraft(state: MachineState) {
    const saved = state.config?.exporters?.[hostId];
    setCollectorDraft({ mode: saved ? 'exporter' : 'ssh', url: saved?.url ?? '', device: saved?.device ?? '' });
    setCollectorState(idle());
  }

  useEffect(() => {
    let active = true;
    setView('collector');
    setNetDraft({ name: hostName, url: '', networkChart: 'system.net' });
    setCharts([]);
    setChartLoad('idle');
    setInstallDraft((current) => ({ ...current, hostId }));
    setTrafficState({ status: 'loading', configured: false, message: '正在自动读取已保存配置…' });
    Promise.all([api('state'), api('trafficRead', { hostId })]).then(([next, saved]) => {
      if (!active) return;
      const state = next as MachineState;
      setMachineState(state);
      setInstances(state.config?.netdata ?? []);
      const current = state.config?.netdata?.find((item) => item.hostId === hostId);
      setNetDraft(current ? { ...current } : { name: hostName, url: '', networkChart: 'system.net' });
      setHistoryQuery((value) => ({ ...value, instanceId: current?.id ?? '' }));
      setHistory(undefined);
      loadCollectorDraft(state);
      loadTrafficDraft(saved as Record<string, unknown>);
    }).catch((error) => active && setTrafficState({ status: 'error', configured: false, message: errorMessage(error) }));
    return () => { active = false; };
  }, [api, hostId, hostName]);

  const hostInstances = useMemo(() => instances.filter((item) => item.hostId === hostId), [instances, hostId]);
  const unassigned = useMemo(() => instances.filter((item) => !item.hostId || !(machineState.config?.hosts ?? []).some((host) => host.id === item.hostId)), [instances, machineState]);
  const netdataNodes = useMemo(() => hostInstances.map((item) => ({ value: item.id, label: `${item.name} · ${item.url}` })), [hostInstances]);
  const currentAgent = hostInstances.find((item) => item.id === netDraft.id);
  const historyInstance = hostInstances.find((item) => item.id === historyQuery.instanceId);

  useEffect(() => {
    if (!historyInstance) {
      setCharts([]);
      setChartLoad('idle');
      return;
    }
    let active = true;
    setCharts([]);
    setChartLoad('loading');
    void api('netdataTest', historyInstance).then((result) => {
      if (!active) return;
      const available = (result as TestResult).charts ?? [];
      setCharts(available);
      setHistoryQuery((current) => ({ ...current, chartId: available.some((chart) => chart.id === current.chartId) ? current.chartId : available[0]?.id ?? '' }));
      setChartLoad('idle');
    }).catch(() => {
      if (!active) return;
      setCharts([]);
      setChartLoad('error');
    });
    return () => { active = false; };
  }, [api, historyInstance?.id, historyInstance?.url]);

  async function runNet(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try { await work(); } catch (error) { setNetState({ status: 'error', message: errorMessage(error) }); } finally { setBusy(false); }
  }

  const netActions = {
    onDraftChange: <K extends keyof NetdataDraft>(field: K, value: NetdataDraft[K]) => setNetDraft((current) => ({ ...current, [field]: value })),
    onEdit: (instance: NetdataInstance) => { setNetDraft({ ...instance }); setHistoryQuery((value) => ({ ...value, instanceId: instance.id })); setHistory(undefined); setNetState(idle()); },
    onClaim: (instance: NetdataInstance) => void runNet(async () => { await api('netdataSave', { ...instance, hostId }); await refreshState(); setNetState({ status: 'success', message: `已将「${instance.name}」关联到当前机器。` }); }),
    onRemove: (instance: NetdataInstance) => void runNet(async () => { await api('netdataRemove', { id: instance.id, hostId }); await refreshState(); if (historyQuery.instanceId === instance.id) { setHistoryQuery((current) => ({ ...current, instanceId: '' })); setHistory(undefined); } setNetState({ status: 'success', message: '已移除接入，远端 Agent 未更改。' }); }),
    onTest: () => void runNet(async () => { if (!netDraft.name.trim() || !netDraft.url.trim()) throw new Error('请填写节点名称和 Agent 地址'); setNetState({ status: 'loading', message: '正在连接 Agent…' }); const result = await api('netdataTest', { ...netDraft, id: netDraft.id || crypto.randomUUID() }) as TestResult; const available = result.charts ?? []; setCharts(available); setHistoryQuery((current) => ({ ...current, chartId: available.some((chart) => chart.id === current.chartId) ? current.chartId : available[0]?.id ?? '' })); setChartLoad('idle'); setNetState({ status: 'success', message: `连接成功，发现 ${available.length} 项指标。` }); }),
    onSave: () => void runNet(async () => { if (!netDraft.name.trim() || !netDraft.url.trim()) throw new Error('请填写节点名称和 Agent 地址'); await api('netdataSave', { ...netDraft, id: netDraft.id || crypto.randomUUID(), hostId }); await refreshState(); setNetState({ status: 'success', message: '当前机器的 Agent 配置已保存。' }); }),
    onHistoryChange: <K extends keyof NetdataHistoryQuery>(field: K, value: NetdataHistoryQuery[K]) => { setHistoryQuery((current) => ({ ...current, [field]: value })); setHistory(undefined); },
    onQueryHistory: () => void runNet(async () => { if (!historyQuery.instanceId || !historyQuery.chartId) throw new Error('请先选择 Netdata 指标'); setNetState({ status: 'loading', message: '正在读取远端历史…' }); const result = await api('netdataHistory', { id: historyQuery.instanceId, chart: historyQuery.chartId, seconds: historyQuery.seconds }) as Omit<NetdataHistory, 'chartId'>; setHistory({ ...result, chartId: historyQuery.chartId, units: charts.find((item) => item.id === historyQuery.chartId)?.units }); setNetState({ status: 'success', message: '历史数据读取完成。' }); }),
    onInstallChange: <K extends keyof NetdataInstallDraft>(field: K, value: NetdataInstallDraft[K]) => { setInstallDraft((current) => ({ ...current, [field]: value })); setInstallPreview(undefined); },
    onPreviewInstall: () => void runNet(async () => { if (!installDraft.hostId) throw new Error('请选择目标机器'); if (!Number.isInteger(installDraft.port) || installDraft.port < 1024 || installDraft.port > 65535) throw new Error('端口应为 1024–65535 的整数'); const payload = { hostId: installDraft.hostId, port: installDraft.port, bind: installDraft.bind, days: installDraft.retentionDays, disk: installDraft.diskMiB }; const result = await api('netdataInstallPlan', payload) as NetdataInstallPreview; setInstallPreview(result); setNetState({ status: 'success', message: '安装计划已生成，请确认目标与命令。' }); }),
    onConfirmInstall: () => void runNet(async () => { if (!installPreview) return; const draft = latestInstall.current; const result = await api('netdataInstall', { hostId: draft.hostId, port: draft.port, bind: draft.bind, days: draft.retentionDays, disk: draft.diskMiB, ...installPreview, expectedAlias: installPreview.alias }) as InstallResult; setInstallPreview(undefined); const started = Date.now(); setNetState({ status: 'loading', message: '安装任务已提交，正在等待执行结果…' }); for (let index = 0; index < 60; index += 1) { await new Promise((resolve) => window.setTimeout(resolve, 2000)); let job: JobResult | undefined; try { job = await api('job', { id: result.id }) as JobResult; } catch { setNetState({ status: 'loading', message: `安装任务执行中…已等待 ${Math.round((Date.now() - started) / 1000)} 秒` }); continue; } if (!job?.finishedAt) { setNetState({ status: 'loading', message: `安装任务执行中…已等待 ${Math.round((Date.now() - started) / 1000)} 秒` }); continue; } const output = `${job.stdout ?? ''}\n${job.stderr ?? ''}`; const address = /FLOWHUB_NETDATA_AGENT_HOST=(\S*)/.exec(output)?.[1]; const port = /FLOWHUB_NETDATA_AGENT_PORT=(\d+)/.exec(output)?.[1]; if (job.status === 'success' && address && port) { const normalized = address.includes(':') && !address.startsWith('[') ? `[${address}]` : address; const url = `http://${normalized}:${port}`; setNetDraft((current) => ({ ...current, name: current.name || hostName, url })); setSuggestion({ message: `已自动填入探测地址 ${url}，请测试后保存。`, url }); } setNetState({ status: job.status === 'success' ? 'success' : 'error', message: `安装任务：${job.status}${output.trim() ? ` · ${output.trim().split('\n')[0]}` : ''}` }); return; } setNetState({ status: 'success', message: '前端停止等待；任务仍在服务器执行，请到执行记录查看最终状态。' }); }),
    onUseSuggestion: () => { if (suggestion?.url) setNetDraft((current) => ({ ...current, url: suggestion.url ?? current.url })); },
  };

  function changeTraffic<K extends keyof CloudTrafficDraft>(field: K, value: CloudTrafficDraft[K]) {
    if (field === 'provider') {
      const next = emptyCloudDraft();
      next.provider = value as CloudTrafficDraft['provider'];
      if (next.provider === 'localNet' && netdataNodes[0]) next.netdataId = netdataNodes[0].value;
      setTrafficDraft(next);
    } else setTrafficDraft((current) => ({ ...current, [field]: value }));
    setTrafficDirty(true);
    setTrafficResult(undefined);
    setTrafficState({ status: 'idle', configured: false, message: '配置有未保存修改，请先保存。' });
  }

  async function saveTraffic() {
    if (busy) return;
    setBusy(true);
    try {
      const provider = CLOUD_PROVIDERS.find((item) => item.id === trafficDraft.provider)!;
      const missing = provider.required.find((field) => !trafficDraft[field].trim());
      if (missing) throw new Error('请填写所有必填配置');
      const payload: Record<string, unknown> = { hostId, provider: provider.id, clearToken: trafficDraft.clearToken };
      for (const field of provider.fields) payload[field] = trafficDraft[field].trim();
      await api('trafficSave', payload);
      const saved = await api('trafficRead', { hostId }) as Record<string, unknown>;
      loadTrafficDraft(saved);
      setTrafficState({ status: 'success', configured: true, message: '配置已加密保存；重新进入会自动读取。' });
    } catch (error) { setTrafficState({ status: 'error', configured: !trafficDirty, message: errorMessage(error) }); } finally { setBusy(false); }
  }

  async function queryTraffic() {
    if (busy || trafficDirty) return;
    setBusy(true);
    setTrafficState((current) => ({ ...current, status: 'loading', message: '正在查询流量…' }));
    try { const result = await api('trafficQuery', { hostId }) as CloudTrafficResult; setTrafficResult(result); setTrafficState({ status: 'success', configured: true, message: `查询完成 · ${new Date(result.at).toLocaleString()}` }); }
    catch (error) { setTrafficState({ status: 'error', configured: true, message: errorMessage(error) }); }
    finally { setBusy(false); }
  }

  async function runCollector(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setCollectorState({ status: 'loading', message: '正在处理采集来源…' });
    try { await work(); }
    catch (error) { setCollectorState({ status: 'error', message: errorMessage(error) }); }
    finally { setBusy(false); }
  }

  function testCollector() {
    void runCollector(async () => {
      if (collectorDraft.mode !== 'exporter' || !collectorDraft.url.trim()) throw new Error('请填写 Exporter 地址');
      await api('exporterTest', { url: collectorDraft.url.trim(), device: collectorDraft.device.trim() });
      setCollectorState({ status: 'success', message: 'Exporter 连接成功；保存后将用于当前机器的基础指标采集。' });
    });
  }

  function saveCollector() {
    void runCollector(async () => {
      if (collectorDraft.mode === 'exporter' && !collectorDraft.url.trim()) throw new Error('请填写 Exporter 地址');
      const result = await api('exporterConfigSave', { hostId, url: collectorDraft.mode === 'exporter' ? collectorDraft.url.trim() : '', device: collectorDraft.mode === 'exporter' ? collectorDraft.device.trim() : '' }) as MachineState;
      setMachineState(result);
      setCollectorDraft((current) => ({ ...current, url: collectorDraft.mode === 'exporter' ? current.url.trim() : '', device: collectorDraft.mode === 'exporter' ? current.device.trim() : '' }));
      setCollectorState({ status: 'success', message: collectorDraft.mode === 'exporter' ? '已保存当前机器的 Node Exporter 来源。' : '已恢复当前机器通过 SSH 采集。' });
    });
  }

  return <div className="monitor-workspace">
    <div className="monitor-workspace__sources" role="group" aria-label="监控数据来源">
      <button type="button" id="monitor-source-collector" aria-pressed={view === 'collector'} aria-controls="monitor-source-panel" onClick={() => setView('collector')}>基础采集 <span>{machineState.config?.exporters?.[hostId] ? 'Exporter' : 'SSH'}</span></button>
      <button type="button" id="monitor-source-traffic" aria-pressed={view === 'traffic'} aria-controls="monitor-source-panel" onClick={() => setView('traffic')}>云流量 <span>{trafficState.configured ? '已配置' : '未配置'}</span></button>
      <button type="button" id="monitor-source-netdata" aria-pressed={view === 'netdata'} aria-controls="monitor-source-panel" onClick={() => setView('netdata')}>Netdata <span>{hostInstances.length > 1 ? '需整理旧配置' : hostInstances.length ? '已接入' : '未接入'}</span></button>
    </div>
    <div id="monitor-source-panel" role="region" aria-labelledby={`monitor-source-${view}`}>
      {view === 'collector' ? <section className="monitor-workspace__collector">
          <div className="monitor-workspace__collector-head"><h4>当前机器的基础指标来源</h4><HelpPopover label="基础采集说明">SSH 是默认来源；配置 Node Exporter 后，基础指标、历史曲线和桌面组件会使用该机器的 Exporter。连接失败时会报错，不自动回退到 SSH。网卡留空时汇总常见物理网卡。</HelpPopover></div>
          <Field label="采集方式" htmlFor="collector-mode"><Select id="collector-mode" value={collectorDraft.mode} disabled={busy} options={[{ value: 'ssh', label: 'SSH（默认）' }, { value: 'exporter', label: 'Node Exporter' }]} onChange={(value) => { setCollectorDraft((current) => ({ ...current, mode: value as CollectorDraft['mode'] })); setCollectorState(idle()); }} /></Field>
          {collectorDraft.mode === 'exporter' ? <div className="monitor-workspace__collector-fields">
            <Field label="Exporter 地址" htmlFor="collector-url" required><Input id="collector-url" type="url" value={collectorDraft.url} required disabled={busy} placeholder="http://机器地址:9100/metrics" onChange={(event) => { setCollectorDraft((current) => ({ ...current, url: event.currentTarget.value })); setCollectorState(idle()); }} /></Field>
            <Field label="网卡" htmlFor="collector-device"><Input id="collector-device" value={collectorDraft.device} maxLength={100} disabled={busy} placeholder="留空汇总物理网卡" onChange={(event) => { setCollectorDraft((current) => ({ ...current, device: event.currentTarget.value })); setCollectorState(idle()); }} /></Field>
          </div> : null}
          {collectorState.message ? <p className={`monitor-workspace__collector-status monitor-workspace__collector-status--${collectorState.status}`} role={collectorState.status === 'error' ? 'alert' : 'status'}>{collectorState.message}</p> : null}
        </section>
        : view === 'traffic'
        ? <CloudTrafficPanel machineName={hostName} draft={trafficDraft} netdataNodes={netdataNodes} result={trafficResult} state={trafficState} busy={busy} onChange={changeTraffic} />
        : <NetdataPanel instances={hostInstances} unassigned={unassigned} charts={charts} chartLoad={chartLoad} draft={netDraft} historyQuery={historyQuery} history={history} installDraft={installDraft} installHostName={hostName} installPreview={installPreview} suggestion={suggestion} state={netState} busy={busy} actions={netActions} />}
    </div>
    {view === 'netdata' && footerTarget ? createPortal(<>
      <Button variant="secondary" disabled={busy} onClick={netActions.onTest}>测试连接</Button>
      <Button variant="primary" disabled={busy} onClick={netActions.onSave}>{currentAgent ? '保存配置' : '接入 Agent'}</Button>
      {currentAgent && hostInstances.length === 1 ? <Button variant="danger" disabled={busy} onClick={() => netActions.onRemove(currentAgent)}>解除接入</Button> : null}
    </>, footerTarget) : null}
    {view === 'traffic' && footerTarget ? createPortal(<>
      <Button variant="secondary" disabled={busy || !trafficState.configured || trafficDirty} onClick={() => void queryTraffic()}>查询流量</Button>
      <Button variant="primary" disabled={busy} onClick={() => void saveTraffic()}>保存配置</Button>
    </>, footerTarget) : null}
    {view === 'collector' && footerTarget ? createPortal(<>
      {collectorDraft.mode === 'exporter' ? <Button variant="secondary" disabled={busy || !collectorDraft.url.trim()} onClick={testCollector}>测试 Exporter</Button> : null}
      <Button variant="primary" disabled={busy} onClick={saveCollector}>保存采集来源</Button>
    </>, footerTarget) : null}
  </div>;
}
