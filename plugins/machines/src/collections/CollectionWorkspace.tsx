import { useEffect, useId, useState } from 'react';
import { Button, DialogShell, EmptyState, HelpPopover } from '@flowhub/plugin-common/react';
import type { MachinesApi } from '../api/machines';
import type { HistoryHost, HistoryJob, HistoryJobDetail } from '../history/types';
import './styles.css';

const labels: Record<string, string> = { success: '成功', failed: '失败', timeout: '超时', cancelled: '已取消', interrupted: '结果未知', running: '执行中', queued: '排队' };

function CollectionRow({ job, api }: { job: HistoryJob; api: MachinesApi | null }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<HistoryJobDetail | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const outputId = useId();
  useEffect(() => {
    if (!expanded || !job.finishedAt || detail || !api) return;
    let disposed = false;
    setError('');
    void api('job', { id: job.id }).then((result) => {
      if (!disposed) setDetail(result as HistoryJobDetail);
    }).catch((reason: unknown) => {
      if (!disposed) setError(String(reason instanceof Error ? reason.message : reason).replace(/^(?:Error:\s*)+/, ''));
    });
    return () => { disposed = true; };
  }, [api, expanded, job.id, job.finishedAt, detail, attempt]);

  const unsupported = /仅支持 Linux|基础指标采集当前/i.test(detail?.stderr ?? '');
  return <li className="collections__row">
    <button type="button" className="collections__toggle" aria-expanded={expanded} aria-controls={outputId} onClick={() => setExpanded(value => !value)}>
      <span className="collections__status" data-status={job.status}>{labels[job.status] ?? job.status}</span>
      <time dateTime={new Date(job.startedAt).toISOString()}>{new Date(job.startedAt).toLocaleString()}</time>
      <span aria-hidden="true">{expanded ? '−' : '+'}</span>
    </button>
    <div id={outputId} hidden={!expanded} className="collections__output">
      {!job.finishedAt ? <p role="status">{job.status === 'queued' ? '等待采集…' : '正在采集…'}</p>
        : !api ? <p>当前环境无法读取采集详情。</p>
          : error ? <div role="alert"><p>读取失败：{error}</p><Button size="sm" variant="ghost" onClick={() => setAttempt(value => value + 1)}>重试</Button></div>
            : !detail ? <p role="status">正在读取采集详情…</p>
              : <>
                {unsupported ? <div className="collections__hint">这台机器暂不支持当前基础指标脚本。
                  <HelpPopover label="采集失败说明">可在目标机器配置 Node Exporter，并在监控设置填写 metrics 地址。以下为原始输出，供排查原因。</HelpPopover>
                </div> : null}
                <pre>{detail.command ? `[command]\n${detail.command}\n\n` : ''}{detail.stdout || '（无标准输出）'}{detail.stderr ? `\n\n[stderr]\n${detail.stderr}` : ''}{detail.truncated ? '\n\n[输出已截断]' : ''}</pre>
              </>}
    </div>
  </li>;
}

export function CollectionWorkspace({ host, jobs, api, onClose }: {
  host: HistoryHost | null; jobs: readonly HistoryJob[]; api: MachinesApi | null; onClose: () => void;
}) {
  const visible = host ? jobs.filter(job => job.kind === 'collect' && job.hostId === host.id) : [];
  return <DialogShell open={host !== null} onOpenChange={open => { if (!open) onClose(); }}
    title={host ? `${host.name} · 采集记录` : '采集记录'} className="collections" contentClassName="collections__shell">
    {host ? <div key={host.id}>
      <div className="collections__meta"><span>共 {visible.length} 条</span><HelpPopover label="采集记录说明">
        显示当前运行任务及最近 100 条内存记录中属于此机器的采集任务。打开期间自动更新，展开后读取完整输出；历史查询请前往执行记录。
      </HelpPopover></div>
      {visible.length ? <ul className="collections__list">{visible.map(job => <CollectionRow key={job.id} job={job} api={api} />)}</ul>
        : <EmptyState size="compact" title="暂无采集记录" />}
    </div> : null}
  </DialogShell>;
}
