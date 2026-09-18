import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, HelpPopover } from '@flowhub/plugin-common/react';
import { NetdataPanel } from './netdata';
import type { AsyncState, NetdataChart, NetdataDraft, NetdataHistory, NetdataHistoryQuery, NetdataInstallDraft, NetdataInstallPreview, NetdataInstance, NetdataSuggestion } from './netdata';
import { CloudTrafficPanel, CLOUD_PROVIDERS, SECRET_FIELDS, emptyCloudDraft } from '../traffic/cloud';
import type { CloudField, CloudTrafficDraft, CloudTrafficResult, CloudTrafficState } from '../traffic/cloud';
import type { HostEditorMachineApi } from '../host-editor/types';

type View = 'overview' | 'traffic' | 'netdata';
type MachineState = { config?: { hosts?: readonly { id: string; name: string; alias: string; bastion?: unknown; readOnly?: boolean }[]; netdata?: readonly NetdataInstance[] } };
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

export function MonitoringWorkspace({ hostId, hostName, api }: { hostId: string; hostName: string; api: HostEditorMachineApi }) {
  const [view, setView] = useState<View>('overview');
  const [machineState, setMachineState] = useState<MachineState>({});
  const [busy, setBusy] = useState(false);
  const [netState, setNetState] = useState<AsyncState>(idle());
  const [instances, setInstances] = useState<readonly NetdataInstance[]>([]);
  const [charts, setCharts] = useState<readonly NetdataChart[]>([]);
  const [netDraft, setNetDraft] = useState<NetdataDraft>({ name: hostName, url: '', networkChart: 'system.net' });
  const [historyQuery, setHistoryQuery] = useState<NetdataHistoryQuery>({ instanceId: '', chartId: 'system.cpu', seconds: 86400 });
  const [history, setHistory] = useState<NetdataHistory>();
  const [installDraft, setInstallDraft] = useState<NetdataInstallDraft>({ hostId, port: 19999, bind: '0.0.0.0', retentionDays: 30, diskMiB: 1024 });
  const [installPreview, setInstallPreview] = useState<NetdataInstallPreview>();
  const [suggestion, setSuggestion] = useState<NetdataSuggestion>();
  const [trafficDraft, setTrafficDraft] = useState<CloudTrafficDraft>(emptyCloudDraft());
  const [trafficState, setTrafficState] = useState<CloudTrafficState>({ status: 'loading', message: '正在自动读取已保存配置…', configured: false });
  const [trafficResult, setTrafficResult] = useState<CloudTrafficResult>();
  const [trafficDirty, setTrafficDirty] = useState(false);
  const latestInstall = useLatest(installDraft);

  async function refreshState() {
    const next = await api('state') as MachineState;
    setMachineState(next);
    setInstances(next.config?.netdata ?? []);
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

  useEffect(() => {
    let active = true;
    setView('overview');
    setNetDraft({ name: hostName, url: '', networkChart: 'system.net' });
    setInstallDraft((current) => ({ ...current, hostId }));
    setTrafficState({ status: 'loading', configured: false, message: '正在自动读取已保存配置…' });
    Promise.all([api('state'), api('trafficRead', { hostId })]).then(([next, saved]) => {
      if (!active) return;
      const state = next as MachineState;
      setMachineState(state);
      setInstances(state.config?.netdata ?? []);
      loadTrafficDraft(saved as Record<string, unknown>);
    }).catch((error) => active && setTrafficState({ status: 'error', configured: false, message: errorMessage(error) }));
    return () => { active = false; };
  }, [api, hostId, hostName]);

  const installHosts = useMemo(() => (machineState.config?.hosts ?? []).filter((host) => !host.bastion && !host.readOnly).map((host) => ({ value: host.id, label: `${host.name} · ${host.alias}` })), [machineState]);
  const netdataNodes = useMemo(() => instances.map((item) => ({ value: item.id, label: `${item.name} · ${item.url}` })), [instances]);

  async function runNet(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try { await work(); } catch (error) { setNetState({ status: 'error', message: errorMessage(error) }); } finally { setBusy(false); }
  }

  const netActions = {
    onDraftChange: <K extends keyof NetdataDraft>(field: K, value: NetdataDraft[K]) => setNetDraft((current) => ({ ...current, [field]: value })),
    onEdit: (instance: NetdataInstance) => { setNetDraft({ ...instance }); setCharts([]); setNetState(idle()); },
    onRemove: (instance: NetdataInstance) => void runNet(async () => { await api('netdataRemove', { id: instance.id }); await refreshState(); if (historyQuery.instanceId === instance.id) { setHistoryQuery((current) => ({ ...current, instanceId: '' })); setHistory(undefined); } setNetState({ status: 'success', message: '已移除接入，远端 Agent 未更改。' }); }),
    onTest: () => void runNet(async () => { if (!netDraft.name.trim() || !netDraft.url.trim()) throw new Error('请填写节点名称和 Agent 地址'); setNetState({ status: 'loading', message: '正在连接 Agent…' }); const result = await api('netdataTest', { ...netDraft, id: netDraft.id || crypto.randomUUID() }) as TestResult; setCharts(result.charts ?? []); setNetState({ status: 'success', message: `连接成功，发现 ${result.charts?.length ?? 0} 项指标。` }); }),
    onSave: () => void runNet(async () => { if (!netDraft.name.trim() || !netDraft.url.trim()) throw new Error('请填写节点名称和 Agent 地址'); await api('netdataSave', { ...netDraft, id: netDraft.id || crypto.randomUUID() }); await refreshState(); setNetDraft({ name: hostName, url: '', networkChart: 'system.net' }); setCharts([]); setNetState({ status: 'success', message: '节点已保存，重新进入时会自动读取。' }); }),
    onReset: () => { setNetDraft({ name: hostName, url: '', networkChart: 'system.net' }); setCharts([]); setSuggestion(undefined); setNetState(idle()); },
    onHistoryChange: <K extends keyof NetdataHistoryQuery>(field: K, value: NetdataHistoryQuery[K]) => { setHistoryQuery((current) => ({ ...current, [field]: value })); setHistory(undefined); if (field === 'instanceId') { const instance = instances.find((item) => item.id === value); if (instance) void runNet(async () => { setNetState({ status: 'loading', message: '正在读取节点指标…' }); const result = await api('netdataTest', instance) as TestResult; const nextCharts = result.charts ?? []; setCharts(nextCharts); setHistoryQuery((current) => ({ ...current, chartId: nextCharts.some((item) => item.id === 'system.cpu') ? 'system.cpu' : nextCharts[0]?.id ?? 'system.cpu' })); setNetState(idle()); }); } },
    onQueryHistory: () => void runNet(async () => { if (!historyQuery.instanceId) throw new Error('请先选择 Netdata 节点'); setNetState({ status: 'loading', message: '正在读取远端历史…' }); const result = await api('netdataHistory', { id: historyQuery.instanceId, chart: historyQuery.chartId, seconds: historyQuery.seconds }) as Omit<NetdataHistory, 'chartId'>; setHistory({ ...result, chartId: historyQuery.chartId, units: charts.find((item) => item.id === historyQuery.chartId)?.units }); setNetState({ status: 'success', message: '历史数据读取完成。' }); }),
    onInstallChange: <K extends keyof NetdataInstallDraft>(field: K, value: NetdataInstallDraft[K]) => { setInstallDraft((current) => ({ ...current, [field]: value })); setInstallPreview(undefined); },
    onPreviewInstall: () => void runNet(async () => { if (!installDraft.hostId) throw new Error('请选择目标机器'); const payload = { hostId: installDraft.hostId, port: installDraft.port, bind: installDraft.bind, days: installDraft.retentionDays, disk: installDraft.diskMiB }; const result = await api('netdataInstallPlan', payload) as NetdataInstallPreview; setInstallPreview(result); setNetState({ status: 'success', message: '安装计划已生成，请确认目标与命令。' }); }),
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

  if (view === 'traffic') return <div className="monitor-workspace"><div className="monitor-workspace__bar"><Button size="sm" variant="ghost" onClick={() => setView('overview')}>← 返回监控概览</Button></div><CloudTrafficPanel machineName={hostName} draft={trafficDraft} netdataNodes={netdataNodes} result={trafficResult} state={trafficState} busy={busy} onChange={changeTraffic} onSave={() => void saveTraffic()} onQuery={() => void queryTraffic()} /></div>;
  if (view === 'netdata') return <div className="monitor-workspace"><div className="monitor-workspace__bar"><Button size="sm" variant="ghost" onClick={() => setView('overview')}>← 返回监控概览</Button></div><NetdataPanel instances={instances} charts={charts} draft={netDraft} historyQuery={historyQuery} history={history} installDraft={installDraft} installHosts={installHosts} installPreview={installPreview} suggestion={suggestion} state={netState} busy={busy} actions={netActions} /></div>;

  return <div className="monitor-workspace"><div className="monitor-workspace__intro"><div><span>OBSERVABILITY / SOURCES</span><h3>{hostName}</h3></div><HelpPopover label="监控与流量说明">配置直接保存在这台机器下。云流量每 5 分钟刷新；Netdata 历史保留在远端 Agent。</HelpPopover></div><div className="host-editor__monitor-grid"><article className="host-editor__monitor-card"><div className="host-editor__monitor-card-head"><strong>云流量</strong><span className="host-editor__monitor-chip">TRAFFIC</span></div><p>{trafficState.configured ? `已配置 ${CLOUD_PROVIDERS.find((item) => item.id === trafficDraft.provider)?.name ?? ''}` : '尚未配置云服务商或自然月网卡计数。'}</p><Button size="sm" variant="ghost" onClick={() => setView('traffic')}>打开配置</Button></article><article className="host-editor__monitor-card"><div className="host-editor__monitor-card-head"><strong>Netdata</strong><span className="host-editor__monitor-chip">{instances.length} NODE</span></div><p>{instances.length ? `已接入 ${instances.length} 个 Agent，可读取远端历史。` : '尚未接入 Agent，可安装或连接现有节点。'}</p><Button size="sm" variant="ghost" onClick={() => setView('netdata')}>打开配置</Button></article></div></div>;
}
