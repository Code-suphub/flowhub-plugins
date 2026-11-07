import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, DataTable, EmptyState, Input, Pagination, Combobox, Select, Toolbar } from '@flowhub/plugin-common/react';
import type { DataTableColumn } from '@flowhub/plugin-common/react';
import type { HistoryHost, HistoryJob, HistoryResponse, HistoryStatus, HistoryWorkspaceProps } from './types';
import { HistoryInspector, historyIdentity } from './HistoryInspector';
import './styles.css';

const STATUS_LABELS: Record<HistoryStatus, string> = {
  queued: '排队', running: '执行中', success: '成功', failed: '失败', timeout: '超时', cancelled: '已取消', interrupted: '结果未知',
};
const STATUS_OPTIONS = [{ value: '', label: '全部状态' }, ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))];
const PAGE_SIZE = 10;
function errorText(error: unknown) { return String(error instanceof Error ? error.message : error).replace(/^(?:Error:\s*)+/, ''); }

export function HistoryWorkspace({ api, active = true, onOpenMachine, onRefillCommand }: HistoryWorkspaceProps) {
  const [hosts, setHosts] = useState<readonly HistoryHost[]>([]);
  const [jobs, setJobs] = useState<readonly HistoryJob[]>([]);
  const [hostId, setHostId] = useState('');
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const returnTarget = useRef<HTMLButtonElement | null>(null);
  const listScroll = useRef(0);
  const root = useRef<HTMLElement>(null);
  const visibleJobs = useMemo(() => jobs.filter(job => `${job.commandPreview ?? ''} ${job.alias}`.toLowerCase().includes(query.toLowerCase())), [jobs, query]);
  const inspected = visibleJobs.find(job => job.id === selectedId);

  const load = useCallback(async () => {
    if (!api || !active) return;
    const version = ++requestVersion.current;
    setLoading(true); setError('');
    try {
      const [history, state] = await Promise.all([
        api('history', { page, pageSize: PAGE_SIZE, hostId, status }) as Promise<HistoryResponse>,
        api('state') as Promise<{ config?: { hosts?: readonly HistoryHost[] } }>,
      ]);
      if (version !== requestVersion.current) return;
      setJobs(history.items ?? []); setPage(history.page || 1); setPages(history.pages || 1); setTotal(history.total || 0);
      const merged = new Map((state.config?.hosts ?? []).map(host => [host.id, host]));
      for (const item of history.instances ?? []) if (!merged.has(item.hostId)) merged.set(item.hostId, { id: item.hostId, alias: item.alias, name: `${item.alias}（历史实例）` });
      setHosts([...merged.values()]);
    } catch (reason) { if (version === requestVersion.current) setError(errorText(reason)); }
    finally { if (version === requestVersion.current) setLoading(false); }
  }, [active, api, hostId, page, status]);
  useEffect(() => { void load(); return () => { requestVersion.current++; }; }, [load]);
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 1100px)');
    const focus = () => { if (active && inspected && media?.matches) root.current?.querySelector<HTMLButtonElement>('[aria-label="返回执行记录"]')?.focus(); };
    focus(); media?.addEventListener('change', focus);
    return () => media?.removeEventListener('change', focus);
  }, [active, inspected?.id]);
  function inspect(job: HistoryJob, button: HTMLButtonElement) { returnTarget.current = button; listScroll.current = window.scrollY; setSelectedId(job.id); }
  function close() {
    setSelectedId(null);
    requestAnimationFrame(() => { if (returnTarget.current?.isConnected) returnTarget.current.focus({ preventScroll: true }); else root.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true }); window.scrollTo({ top: listScroll.current }); });
  }
  async function cancel(job: HistoryJob) {
    if (!api || loading) return;
    setLoading(true);
    try { await api('cancel', { id: job.id }); await load(); }
    catch (reason) { setError(errorText(reason)); setLoading(false); }
  }
  const columns = useMemo<DataTableColumn<HistoryJob>[]>(() => [
    { key: 'command', header: '命令', className: 'history-react__command-cell', render: job => <button type="button" className="history-react__inspect" data-history-job={job.id} aria-pressed={job.id === selectedId} onClick={event => inspect(job, event.currentTarget)}>{job.commandPreview || (job.kind === 'collect' ? '指标采集' : '远程命令')}<small>查看输出</small></button> },
    { key: 'target', header: '目标', render: job => <span className="history-react__target"><strong>{hosts.find(host => host.id === job.hostId)?.name ?? job.alias}</strong><small>{job.alias}</small></span> },
    { key: 'status', header: '结果', render: job => <span className={`history-react__status history-react__status--${job.status}`}>{STATUS_LABELS[job.status] ?? job.status}</span> },
    { key: 'started', header: '开始时间', render: job => <time>{new Date(job.startedAt).toLocaleString()}</time> },
    { key: 'duration', header: '耗时', render: job => job.finishedAt ? `${Math.max(0, (job.finishedAt - job.startedAt) / 1000).toFixed(1)} 秒` : '等待结束' },
    { key: 'action', header: '', className: 'history-react__table-actions', render: job => !job.finishedAt ? <Button size="sm" variant="danger" disabled={loading} onClick={() => void cancel(job)}>取消</Button> : null },
  ], [selectedId, loading, hosts]);
  const hostOptions = [{ value: '', label: '全部实例' }, ...hosts.map(host => ({ value: host.id, label: `${host.name} (${host.alias})` }))];
  if (!api) return <section className="history-react"><EmptyState title="执行记录仅在 FlowHub 中可用" description="当前浏览器环境没有插件调用桥。" /></section>;
  return <section ref={root} className="history-react" aria-label="执行记录">
    <div className="history-react__layout" data-detail-open={!!inspected}>
      <div className="history-react__list">
        <Toolbar label="执行记录筛选" className="history-react__toolbar"><div className="history-react__filters"><Combobox placeholder="搜索机器" className="history-react__host-filter" aria-label="实例" value={hostId} options={hostOptions} onChange={value => { setHostId(value); setPage(1); setSelectedId(null); }} /><Select className="history-react__status-filter" aria-label="执行状态" value={status} options={STATUS_OPTIONS} onChange={value => { setStatus(value); setPage(1); setSelectedId(null); }} /><Input aria-label="筛选本页命令或别名" placeholder="筛选本页命令…" value={query} onChange={event => setQuery(event.currentTarget.value)} /></div><Button size="sm" variant="ghost" disabled={loading} onClick={() => void load()}>{loading ? '刷新中…' : '刷新'}</Button></Toolbar>
        {error ? <p className="history-react__error" role="alert">读取执行记录失败：{error}</p> : null}
        <DataTable columns={columns} rows={[...visibleJobs]} getRowKey={job => job.id} caption="执行记录列表" emptyState={loading ? '正在读取执行记录…' : query ? '当前页没有匹配的命令' : '暂无执行记录'} />
        <footer className="history-react__footer"><span>共 {total} 条 · 本页 {visibleJobs.length} 条</span><Pagination page={page} pages={pages} onChange={value => { setPage(value); setQuery(''); setSelectedId(null); }} ariaLabel="执行记录分页" /></footer>
      </div>
      {inspected ? <HistoryInspector key={historyIdentity(inspected)} api={api} job={inspected} active={active} onClose={close} onOpenMachine={onOpenMachine} onRefillCommand={onRefillCommand} /> : null}
    </div>
  </section>;
}
