import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, DataTable, EmptyState, Pagination, Combobox, Select, Toolbar } from '@flowhub/plugin-common/react';
import type { DataTableColumn } from '@flowhub/plugin-common/react';
import type { HistoryHost, HistoryJob, HistoryJobDetail, HistoryResponse, HistoryStatus, HistoryWorkspaceProps } from './types';
import './styles.css';

const STATUS_LABELS: Record<HistoryStatus, string> = {
  queued: '排队', running: '执行中', success: '成功', failed: '失败', timeout: '超时', cancelled: '已取消', interrupted: '结果未知',
};

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
];

const PAGE_SIZE = 10;

function errorText(error: unknown) {
  return String(error instanceof Error ? error.message : error).replace(/^(?:Error:\s*)+/, '');
}

function JobOutput({ detail }: { detail?: HistoryJobDetail }) {
  if (!detail) return <p className="history-react__loading">正在读取输出…</p>;
  return <div className="history-react__output">
    {detail.command ? <pre><b>[command]</b>{`\n`}{detail.command}</pre> : null}
    <pre>{detail.stdout || '（无标准输出）'}{detail.stderr ? `\n\n[stderr]\n${detail.stderr}` : ''}{detail.truncated ? '\n\n[输出已截断]' : ''}</pre>
  </div>;
}

function JobCard({ job, expanded, detail, busy, onToggle, onCancel }: { job: HistoryJob; expanded: boolean; detail?: HistoryJobDetail; busy: boolean; onToggle: () => void; onCancel: () => void }) {
  return <article className="history-react__card">
    <button type="button" className="history-react__card-main" aria-expanded={expanded} onClick={onToggle}>
      <span className={`history-react__status history-react__status--${job.status}`}>{STATUS_LABELS[job.status] ?? job.status}</span>
      <span className="history-react__target"><strong>{job.alias}</strong><small>{job.kind === 'collect' ? '指标采集' : '远程命令'}</small></span>
      <time>{new Date(job.startedAt).toLocaleString()}</time>
      <span className="history-react__chevron" aria-hidden="true">{expanded ? '−' : '+'}</span>
    </button>
    {!job.finishedAt ? <Button size="sm" variant="danger" disabled={busy} onClick={onCancel}>取消任务</Button> : null}
    {expanded ? <JobOutput detail={detail} /> : null}
  </article>;
}

export function HistoryWorkspace({ api, active = true }: HistoryWorkspaceProps) {
  const [hosts, setHosts] = useState<readonly HistoryHost[]>([]);
  const [jobs, setJobs] = useState<readonly HistoryJob[]>([]);
  const [hostId, setHostId] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [details, setDetails] = useState<Readonly<Record<string, HistoryJobDetail>>>({});
  const requestVersion = useRef(0);

  const load = useCallback(async () => {
    if (!api || !active) return;
    const version = ++requestVersion.current;
    setLoading(true);
    setError('');
    try {
      const [history, state] = await Promise.all([
        api('history', { page, pageSize: PAGE_SIZE, hostId, status }) as Promise<HistoryResponse>,
        api('state') as Promise<{ config?: { hosts?: readonly HistoryHost[] } }>,
      ]);
      if (version !== requestVersion.current) return;
      setJobs(history.items ?? []);
      setPage(history.page || 1);
      setPages(history.pages || 1);
      setTotal(history.total || 0);
      const current = state.config?.hosts ?? [];
      const merged = new Map(current.map((host) => [host.id, host]));
      for (const item of history.instances ?? []) if (!merged.has(item.hostId)) merged.set(item.hostId, { id: item.hostId, alias: item.alias, name: `${item.alias}（历史实例）` });
      setHosts([...merged.values()]);
    } catch (reason) {
      if (version === requestVersion.current) setError(errorText(reason));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [active, api, hostId, page, status]);

  useEffect(() => {
    void load();
    return () => { requestVersion.current++; };
  }, [load]);

  async function toggle(job: HistoryJob) {
    const opening = !expanded.has(job.id);
    setExpanded((current) => { const next = new Set(current); opening ? next.add(job.id) : next.delete(job.id); return next; });
    if (!opening || !job.finishedAt || details[job.id] || !api) return;
    try {
      const detail = await api('job', { id: job.id }) as HistoryJobDetail;
      setDetails((current) => ({ ...current, [job.id]: detail }));
    } catch (reason) {
      setDetails((current) => ({ ...current, [job.id]: { ...job, stderr: errorText(reason) } }));
    }
  }

  async function cancel(job: HistoryJob) {
    if (!api || loading) return;
    setLoading(true);
    try { await api('cancel', { id: job.id }); await load(); }
    catch (reason) { setError(errorText(reason)); setLoading(false); }
  }

  const columns = useMemo<DataTableColumn<HistoryJob>[]>(() => [
    { key: 'status', header: '状态', render: (job) => <span className={`history-react__status history-react__status--${job.status}`}>{STATUS_LABELS[job.status] ?? job.status}</span> },
    { key: 'target', header: '目标', render: (job) => <span className="history-react__target"><strong>{job.alias}</strong><small>{job.kind === 'collect' ? '指标采集' : '远程命令'}</small></span> },
    { key: 'started', header: '开始时间', render: (job) => <time>{new Date(job.startedAt).toLocaleString()}</time> },
    { key: 'result', header: '结果', render: (job) => job.finishedAt ? (job.exitCode == null ? '已结束' : `exit ${job.exitCode}`) : '等待完成' },
    { key: 'action', header: '', className: 'history-react__table-actions', render: (job) => <div><Button size="sm" variant="ghost" onClick={() => void toggle(job)}>{expanded.has(job.id) ? '收起' : '详情'}</Button>{!job.finishedAt ? <Button size="sm" variant="danger" disabled={loading} onClick={() => void cancel(job)}>取消</Button> : null}</div> },
  ], [expanded, loading]);

  const hostOptions = [{ value: '', label: '全部实例' }, ...hosts.map((host) => ({ value: host.id, label: `${host.name} (${host.alias})` }))];

  if (!api) return <section className="history-react"><EmptyState title="执行记录仅在 FlowHub 中可用" description="当前浏览器环境没有插件调用桥。" /></section>;
  return <section className="history-react" aria-label="执行记录">
    <Toolbar label="执行记录筛选" className="history-react__toolbar"><div className="history-react__filters"><Combobox placeholder="搜索机器" className="history-react__host-filter" aria-label="实例" value={hostId} options={hostOptions} onChange={(value) => { setHostId(value); setPage(1); }} /><Select className="history-react__status-filter" aria-label="执行状态" value={status} options={STATUS_OPTIONS} onChange={(value) => { setStatus(value); setPage(1); }} /></div><Button size="sm" variant="ghost" disabled={loading} onClick={() => void load()}>{loading ? '刷新中…' : '刷新'}</Button></Toolbar>
    {error ? <p className="history-react__error" role="alert">读取执行记录失败：{error}</p> : null}
    <div className="history-react__desktop"><DataTable columns={columns} rows={[...jobs]} getRowKey={(job) => job.id} caption="执行记录列表" emptyState={loading ? '正在读取执行记录…' : '暂无执行记录'} />{jobs.map((job) => expanded.has(job.id) ? <div className="history-react__desktop-output" key={`${job.id}-output`}><div><strong>{job.alias}</strong><Button size="sm" variant="ghost" onClick={() => void toggle(job)}>收起</Button></div><JobOutput detail={details[job.id]} /></div> : null)}</div>
    <div className="history-react__mobile">{jobs.length ? jobs.map((job) => <JobCard key={job.id} job={job} expanded={expanded.has(job.id)} detail={details[job.id]} busy={loading} onToggle={() => void toggle(job)} onCancel={() => void cancel(job)} />) : <EmptyState size="compact" title={loading ? '正在读取执行记录…' : '暂无执行记录'} />}</div>
    <footer className="history-react__footer"><span>共 {total} 条记录</span><Pagination page={page} pages={pages} onChange={setPage} ariaLabel="执行记录分页" /></footer>
  </section>;
}
