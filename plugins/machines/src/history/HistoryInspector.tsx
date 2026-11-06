import { useEffect, useState } from 'react';
import { Button, Tabs } from '@flowhub/plugin-common/react';
import type { MachinesApi } from '../api/machines';
import type { HistoryJob, HistoryJobDetail } from './types';

interface DetailState { key: string; data?: HistoryJobDetail; error?: string; loading: boolean }
export function historyIdentity(job: HistoryJob): string { return JSON.stringify([job.id, job.hostId, job.alias]); }

/** Only explicit record selection reads output. No history action runs a command. */
export function useJobDetail(api: MachinesApi | null, job: HistoryJob, active: boolean, attempt: number) {
  const key = historyIdentity(job);
  const [state, setState] = useState<DetailState>();
  useEffect(() => {
    if (!api || !active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      setState(current => ({ key, data: current?.key === key ? current.data : undefined, loading: true }));
      try {
        const data = await api!('job', { id: job.id }) as HistoryJobDetail;
        if (disposed) return;
        if (historyIdentity(data) !== key) throw new Error('执行记录目标不匹配，请刷新后重试。');
        setState({ key, data, loading: false });
        if (!data.finishedAt) timer = setTimeout(poll, 1500);
      } catch (reason) {
        if (!disposed) setState(current => ({ key, data: current?.key === key ? current.data : undefined, loading: false, error: String(reason instanceof Error ? reason.message : reason) }));
      }
    }
    function poll() { if (disposed) return; if (document.hidden) timer = setTimeout(poll, 1500); else void load(); }
    void load();
    return () => { disposed = true; clearTimeout(timer); };
  }, [api, key, active, attempt]);
  return state?.key === key ? state : undefined;
}

export function HistoryInspector({ api, job, active, onClose, onOpenMachine, onRefillCommand }: {
  api: MachinesApi; job: HistoryJob; active: boolean; onClose: () => void;
  onOpenMachine?: (hostId: string) => void; onRefillCommand?: (job: HistoryJobDetail) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [channel, setChannel] = useState('stdout');
  const [copyNotice, setCopyNotice] = useState('');
  const state = useJobDetail(api, job, active, attempt);
  const detail = state?.data;
  async function copy() {
    if (!detail) return;
    try { await navigator.clipboard.writeText(channel === 'stderr' ? detail.stderr || '' : detail.stdout || ''); setCopyNotice('已复制当前输出'); }
    catch { setCopyNotice('复制失败，请重试或选择文本复制。'); }
  }
  return <aside className="history-inspector" aria-label="执行输出详情">
    <header><h3>执行输出</h3><Button size="sm" variant="ghost" aria-label="返回执行记录" onClick={onClose}>返回列表</Button></header>
    <dl><div><dt>目标</dt><dd>{job.alias}</dd></div><div><dt>开始时间</dt><dd>{new Date(job.startedAt).toLocaleString()}</dd></div><div><dt>退出码</dt><dd>{detail?.exitCode ?? job.exitCode ?? (detail?.finishedAt ? '未提供' : '等待结束')}</dd></div></dl>
    {state?.error ? <div className="history-react__error" role="alert"><p>读取输出失败：{state.error}</p><Button size="sm" variant="ghost" onClick={() => setAttempt(value => value + 1)}>重试</Button></div> : null}
    {!detail ? <p role="status">{state?.error ? '未取得执行输出' : '正在读取执行输出…'}</p> : <>
      <pre className="history-inspector__command">{detail.command || (job.kind === 'collect' ? '指标采集' : '命令未提供')}</pre>
      {detail.truncated ? <p className="history-inspector__muted">输出已截断</p> : null}
      {state?.loading || !detail.finishedAt ? <p role="status">{detail.finishedAt ? '正在刷新输出…' : '任务执行中，正在等待结果…'}</p> : null}
      <Tabs value={channel} onValueChange={setChannel}><Tabs.List aria-label="输出通道"><Tabs.Trigger value="stdout">标准输出</Tabs.Trigger><Tabs.Trigger value="stderr">标准错误{detail.stderr ? ' · 有内容' : ''}</Tabs.Trigger></Tabs.List><Tabs.Panel value="stdout"><pre className="history-inspector__output">{detail.stdout || '（无标准输出）'}</pre></Tabs.Panel><Tabs.Panel value="stderr"><pre className="history-inspector__output">{detail.stderr || '（无标准错误）'}</pre></Tabs.Panel></Tabs>
    </>}
    <div className="history-inspector__actions"><Button size="sm" disabled={!detail} onClick={() => void copy()}>复制输出</Button>{onOpenMachine ? <Button size="sm" onClick={() => onOpenMachine(job.hostId)}>打开机器</Button> : null}{onRefillCommand ? <Button size="sm" variant="primary" disabled={!detail?.command} onClick={() => { if (detail?.command) onRefillCommand(detail); }}>重新填入命令</Button> : null}</div>
    {copyNotice ? <p role="status">{copyNotice}</p> : null}
    {detail?.command?.includes('[已隐藏]') ? <p className="history-inspector__muted">命令含隐藏字段，回填后请补全并确认目标再执行。</p> : null}
  </aside>;
}
