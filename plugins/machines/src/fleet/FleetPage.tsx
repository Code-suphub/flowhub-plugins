import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { Button, Checkbox, DataTable, Select, cx } from '@flowhub/plugin-common/react';

import {
  fleetMetricStatus,
  type FleetHost,
  type FleetHostAction,
  type FleetMetricStatus,
  type FleetPageProps,
} from './types';

const INTERVAL_OPTIONS = [
  { value: '30', label: '每 30 秒' },
  { value: '60', label: '每 60 秒' },
  { value: '300', label: '每 5 分钟' },
  { value: '900', label: '每 15 分钟' },
] as const;

const STATUS_LABELS: Record<FleetMetricStatus, string> = {
  success: '正常',
  failed: '失败',
  timeout: '超时',
  stale: '已过期',
  unknown: '未采集',
};

const STATUS_HINTS: Record<FleetMetricStatus, string> = {
  success: '最近采集成功',
  failed: '最近一次采集失败',
  timeout: '最近一次采集超时',
  stale: '超过两个采集周期未更新',
  unknown: '尚未有采集记录',
};

interface FleetCheckboxProps {
  checked: boolean;
  mixed?: boolean;
  label: ReactNode;
  ariaLabel: string;
  id?: string;
  dataSelect?: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
}

function FleetCheckbox({
  checked,
  mixed = false,
  label,
  ariaLabel,
  id,
  dataSelect,
  disabled,
  onChange,
  className,
}: FleetCheckboxProps) {
  return (
    <Checkbox
      id={id}
      aria-label={ariaLabel}
      aria-checked={mixed ? 'mixed' : checked}
      data-select={dataSelect}
      checked={checked}
      disabled={disabled}
      label={label}
      onChange={onChange}
      className={cx('fleet__checkbox', mixed && 'fleet__checkbox--mixed', className)}
      containerClassName="fleet__checkbox-wrap"
    />
  );
}

interface MetricValueProps {
  value: number | undefined;
  unit: string;
  muted?: boolean;
}

function MetricValue({ value, unit, muted = false }: MetricValueProps) {
  const valid = value !== undefined && Number.isFinite(value);
  return (
    <span className={cx('fleet__metric-value', muted && 'fleet__metric-value--muted')}>
      {valid ? Number(value).toFixed(1) : '—'}
      {valid ? <small>{unit}</small> : null}
    </span>
  );
}

function formatUptime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '—';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  return days > 0 ? `${days} 天 ${hours} 时` : `${hours} 时`;
}

function formatTime(timestamp: number | undefined): string {
  if (!timestamp) return '等待采集';
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function HostIdentity({ host }: { host: FleetHost }) {
  return (
    <span className="fleet__identity">
      <strong>
        {host.name}
        {host.readOnly ? <em>仅查询</em> : null}
      </strong>
      <small>
        {host.alias}
        {host.group ? <span> / {host.group}</span> : null}
      </small>
    </span>
  );
}

interface StatusBadgeProps {
  status: FleetMetricStatus;
  error?: string;
}

function StatusBadge({ status, error }: StatusBadgeProps) {
  return (
    <span
      className={cx('fleet__status', `fleet__status--${status}`)}
      title={error || STATUS_HINTS[status]}
    >
      <span className="fleet__status-dot" aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  );
}

interface HostActionsProps {
  host: FleetHost;
  disabled: boolean;
  onCollect: (hostId: string) => void;
  onAction: (action: FleetHostAction, host: FleetHost) => void;
}

function HostActions({ host, disabled, onCollect, onAction }: HostActionsProps) {
  return (
    <div className="fleet__row-actions">
      <Button
        data-host-action="collect"
        data-id={host.id}
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => onCollect(host.id)}
      >
        采集
      </Button>
      <Button
        data-host-action="edit"
        data-id={host.id}
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => onAction('edit', host)}
      >
        编辑
      </Button>
      <Button
        data-host-action="more"
        data-id={host.id}
        size="sm"
        variant="ghost"
        aria-haspopup="menu"
        aria-label={`打开 ${host.name} 的更多操作`}
        onClick={() => onAction('more', host)}
      >
        更多
      </Button>
    </div>
  );
}

interface FleetEmptyStateProps {
  hasHosts: boolean;
  hidden?: boolean;
  onAddHost: () => void;
  onReset: () => void;
}

function FleetEmptyState({ hasHosts, hidden = false, onAddHost, onReset }: FleetEmptyStateProps) {
  return (
    <div id="empty" className="fleet__empty" hidden={hidden} role="status">
      <span className="fleet__empty-mark" aria-hidden="true">
        ∿
      </span>
      <p className="fleet__empty-kicker">NO HOSTS IN VIEW</p>
      <h3>{hasHosts ? '没有匹配的机器' : '从一台机器开始'}</h3>
      <p>
        {hasHosts
          ? '尝试清除搜索词或切换分组筛选。'
          : '手动添加一台机器并填写 SSH 连接信息。添加机器不会自动执行远程命令。'}
      </p>
      <Button variant={hasHosts ? 'secondary' : 'primary'} onClick={hasHosts ? onReset : onAddHost}>
        {hasHosts ? '清除筛选' : '添加第一台机器'}
      </Button>
    </div>
  );
}

function metricValue(
  snapshot: FleetPageProps['snapshot'],
  config: FleetPageProps['config'],
  now: number,
  host: FleetHost,
): { status: FleetMetricStatus; values: NonNullable<FleetPageProps['snapshot']['metrics'][string]>['values'] } {
  const metric = snapshot.metrics[host.id];
  const status = fleetMetricStatus(metric, config.intervalSeconds, now);
  return {
    status,
    values: status === 'success' ? metric?.values : undefined,
  };
}

export function FleetPage({
  snapshot,
  config,
  actions,
  initialSelectedHostIds,
  selectedHostIds: controlledSelectedHostIds,
  className,
  now = Date.now(),
}: FleetPageProps) {
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('');
  const [internalSelectedIds, setInternalSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(initialSelectedHostIds),
  );
  const isSelectionControlled = controlledSelectedHostIds !== undefined;
  const selectedIds = useMemo(
    () => new Set(isSelectionControlled ? controlledSelectedHostIds : internalSelectedIds),
    [controlledSelectedHostIds, internalSelectedIds, isSelectionControlled],
  );

  const orderedHostIds = (ids: ReadonlySet<string>): string[] =>
    snapshot.hosts.filter((host) => ids.has(host.id)).map((host) => host.id);

  const commitSelection = (next: Set<string>) => {
    if (!isSelectionControlled) setInternalSelectedIds(next);
    actions.onSelectionChange(orderedHostIds(next));
  };

  useEffect(() => {
    const hostIds = new Set(snapshot.hosts.map((host) => host.id));
    const current = selectedIds;
    const next = new Set([...current].filter((id) => hostIds.has(id)));
    if (next.size === current.size) return;
    if (!isSelectionControlled) setInternalSelectedIds(next);
    actions.onSelectionChange(orderedHostIds(next));
  }, [actions, isSelectionControlled, selectedIds, snapshot.hosts]);

  /* Keep the callback payload stable and host-ordered for the legacy command workbench. */
  const replaceSelection = (update: (current: Set<string>) => void) => {
    const next = new Set(selectedIds);
    update(next);
    commitSelection(next);
  };

  const toggleHost = (hostId: string, checked: boolean) => {
    replaceSelection((next) => {
      if (checked) next.add(hostId);
      else next.delete(hostId);
    });
  };

  const groups = useMemo(
    () =>
      [...new Set(snapshot.hosts.map((host) => host.group).filter((value): value is string => Boolean(value)))]
        .sort((left, right) => left.localeCompare(right, 'zh-CN')),
    [snapshot.hosts],
  );

  const visibleHosts = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return snapshot.hosts.filter((host) => {
      const searchable = `${host.name} ${host.alias} ${host.group || ''}`.toLocaleLowerCase();
      return (!group || host.group === group) && (!normalizedQuery || searchable.includes(normalizedQuery));
    });
  }, [group, query, snapshot.hosts]);

  const toggleVisible = (checked: boolean) => {
    replaceSelection((next) => {
      visibleHosts.forEach((host) => (checked ? next.add(host.id) : next.delete(host.id)));
    });
  };

  const statusByHost = useMemo(
    () =>
      new Map(snapshot.hosts.map((host) => [
        host.id,
        fleetMetricStatus(snapshot.metrics[host.id], config.intervalSeconds, now),
      ])),
    [config.intervalSeconds, now, snapshot.hosts, snapshot.metrics],
  );

  const selectedVisibleCount = visibleHosts.filter((host) => selectedIds.has(host.id)).length;
  const allVisibleSelected = visibleHosts.length > 0 && selectedVisibleCount === visibleHosts.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  const interactive = config.enabled;
  const selectedHostIds = orderedHostIds(selectedIds);

  const resetFilters = () => {
    setQuery('');
    setGroup('');
  };

  const intervalValue = String(config.intervalSeconds);
  const intervalOptions = INTERVAL_OPTIONS.some((option) => option.value === intervalValue)
    ? [...INTERVAL_OPTIONS]
    : [{ value: intervalValue, label: `每 ${config.intervalSeconds} 秒` }, ...INTERVAL_OPTIONS];

  const columns = useMemo(
    () => [
      {
        key: 'select',
        header: (
          <FleetCheckbox
            id="selectAll"
            ariaLabel="选择当前筛选机器"
            checked={allVisibleSelected}
            mixed={someVisibleSelected}
            disabled={!interactive || visibleHosts.length === 0}
            label=""
            onChange={toggleVisible}
          />
        ),
        className: 'fleet__select-cell',
        headerClassName: 'fleet__select-cell',
        render: (host: FleetHost) => (
          <FleetCheckbox
            dataSelect={host.id}
            ariaLabel={`选择 ${host.name}`}
            checked={selectedIds.has(host.id)}
            disabled={!interactive}
            label=""
            onChange={(checked) => toggleHost(host.id, checked)}
          />
        ),
      },
      {
        key: 'host',
        header: '机器 / SSH 别名',
        className: 'fleet__host-cell',
        render: (host: FleetHost) => <HostIdentity host={host} />,
      },
      {
        key: 'status',
        header: '状态',
        render: (host: FleetHost) => {
          const metric = snapshot.metrics[host.id];
          const status = statusByHost.get(host.id) || 'unknown';
          return (
            <span className="fleet__status-cell">
              <StatusBadge status={status} error={metric?.error} />
              <small>{formatTime(metric?.at)}</small>
            </span>
          );
        },
      },
      {
        key: 'cpu',
        header: 'CPU',
        render: (host: FleetHost) => <MetricValue value={metricValue(snapshot, config, now, host).values?.cpu} unit="%" muted={statusByHost.get(host.id) !== 'success'} />,
      },
      {
        key: 'memory',
        header: '内存',
        render: (host: FleetHost) => <MetricValue value={metricValue(snapshot, config, now, host).values?.memory} unit="%" muted={statusByHost.get(host.id) !== 'success'} />,
      },
      {
        key: 'disk',
        header: '根磁盘',
        render: (host: FleetHost) => <MetricValue value={metricValue(snapshot, config, now, host).values?.disk} unit="%" muted={statusByHost.get(host.id) !== 'success'} />,
      },
      {
        key: 'load',
        header: '负载 / 运行',
        render: (host: FleetHost) => {
          const values = metricValue(snapshot, config, now, host).values;
          return (
            <span className="fleet__load-cell">
              <MetricValue value={values?.load} unit="" muted={!values} />
              <small>{formatUptime(values?.uptime)}</small>
            </span>
          );
        },
      },
      {
        key: 'actions',
        header: '操作',
        className: 'fleet__actions-cell',
        render: (host: FleetHost) => (
          <HostActions
            host={host}
            disabled={!interactive}
            onCollect={actions.onCollectHost}
            onAction={actions.onHostAction}
          />
        ),
      },
    ],
    [
      actions,
      allVisibleSelected,
      config,
      interactive,
      now,
      selectedIds,
      snapshot,
      someVisibleSelected,
      statusByHost,
      visibleHosts,
    ],
  );

  const total = snapshot.hosts.length;
  const healthy = snapshot.hosts.filter((host) => statusByHost.get(host.id) === 'success').length;
  const problem = snapshot.hosts.filter((host) => {
    const status = statusByHost.get(host.id);
    return status !== 'success' && status !== 'unknown';
  }).length;

  return (
    <main className={cx('fleet', className)}>
      <section className="fleet__overview" aria-label="机器概况">
        <div className="fleet__overview-intro">
          <span className="fleet__eyebrow">01 / FLEET SIGNAL</span>
          <h1>机器概况</h1>
          <p>基础指标 · SSH 采集 · 本机后台监控</p>
        </div>
        <div className="fleet__stat">
          <span>机器总数</span>
          <strong>{total}</strong>
          <small>REGISTERED</small>
        </div>
        <div className="fleet__stat fleet__stat--healthy">
          <span>最近采集成功</span>
          <strong>{healthy}</strong>
          <small>RESPONDING</small>
        </div>
        <div className="fleet__stat fleet__stat--problem">
          <span>异常 / 过期</span>
          <strong>{problem}</strong>
          <small>NEEDS ATTENTION</small>
        </div>
        <div className="fleet__stat fleet__stat--active">
          <span>执行中 / 排队</span>
          <strong>{snapshot.activeJobs.length}</strong>
          <small>IN FLIGHT</small>
        </div>
      </section>

      <section className="fleet__panel" aria-labelledby="fleet-list-title">
        <header className="fleet__section-head">
          <div>
            <span className="fleet__eyebrow">02 / MANAGED NODES</span>
            <h2 id="fleet-list-title">已纳管机器</h2>
          </div>
          <Button id="addHost" variant="primary" disabled={!interactive} onClick={actions.onAddHost}>
            <span aria-hidden="true">＋</span> 添加机器
          </Button>
        </header>

        <div className="fleet__toolbar" aria-label="机器筛选与监控设置">
          <label className="fleet__search">
            <span className="fleet__sr-only">搜索机器</span>
            <span className="fleet__search-icon" aria-hidden="true">⌕</span>
            <input
              id="filter"
              type="search"
              value={query}
              placeholder="搜索名称、别名或分组…"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <div className="fleet__filter">
            <span className="fleet__filter-label">分组</span>
            <Select
              id="group"
              ariaLabel="筛选分组"
              value={group}
              options={[{ value: '', label: '全部分组' }, ...groups.map((value) => ({ value, label: value }))]}
              onChange={setGroup}
              triggerClassName="fleet__select-trigger"
            />
          </div>
          <Button
            id="collectSelected"
            variant="secondary"
            disabled={!interactive || selectedHostIds.length === 0}
            onClick={() => actions.onCollectSelected(selectedHostIds)}
          >
            采集所选 <span className="fleet__selected-count">{selectedHostIds.length || ''}</span>
          </Button>
          <span className="fleet__toolbar-rule" aria-hidden="true" />
          <Checkbox
            id="monitor"
            label="后台监控"
            checked={config.monitoring}
            disabled={!interactive}
            onChange={(enabled) => actions.onMonitoringChange({ enabled, intervalSeconds: config.intervalSeconds })}
            containerClassName="fleet__monitor"
          />
          <div className="fleet__filter fleet__filter--interval">
            <span className="fleet__filter-label">采集间隔</span>
            <Select
              id="interval"
              ariaLabel="采集间隔"
              value={intervalValue}
              options={intervalOptions}
              disabled={!interactive}
              onChange={(value) => actions.onMonitoringChange({ enabled: config.monitoring, intervalSeconds: Number(value) })}
              triggerClassName="fleet__select-trigger"
            />
          </div>
        </div>
        <p className="fleet__caption">
          <span className="fleet__caption-signal" aria-hidden="true" />
          Linux / macOS 基础指标 · 后台监控在 FlowHub 运行且电脑唤醒时工作 · 失败后逐步延长重试间隔
        </p>

        <div id="hostRows" className="fleet__table-wrap">
          {visibleHosts.length > 0 ? (
            <DataTable
              columns={columns}
              rows={visibleHosts}
              getRowKey={(host) => host.id}
              caption="已纳管机器列表"
              emptyState={null}
            />
          ) : null}
        </div>
        {visibleHosts.length > 0 ? (
          <div className="fleet__cards" aria-label="已纳管机器列表">
            {visibleHosts.map((host) => {
              const metric = snapshot.metrics[host.id];
              const status = statusByHost.get(host.id) || 'unknown';
              const values = metricValue(snapshot, config, now, host).values;
              return (
                <article className="fleet__card" key={host.id}>
                  <header className="fleet__card-head">
                    <FleetCheckbox
                      dataSelect={host.id}
                      ariaLabel={`选择 ${host.name}`}
                      checked={selectedIds.has(host.id)}
                      disabled={!interactive}
                      label=""
                      onChange={(checked) => toggleHost(host.id, checked)}
                    />
                    <HostIdentity host={host} />
                    <StatusBadge status={status} error={metric?.error} />
                  </header>
                  <div className="fleet__card-metrics">
                    <div><span>CPU</span><MetricValue value={values?.cpu} unit="%" muted={!values} /></div>
                    <div><span>内存</span><MetricValue value={values?.memory} unit="%" muted={!values} /></div>
                    <div><span>磁盘</span><MetricValue value={values?.disk} unit="%" muted={!values} /></div>
                    <div><span>负载</span><MetricValue value={values?.load} unit="" muted={!values} /></div>
                  </div>
                  <footer className="fleet__card-foot">
                    <span>{formatTime(metric?.at)} · 运行 {formatUptime(values?.uptime)}</span>
                    <HostActions
                      host={host}
                      disabled={!interactive}
                      onCollect={actions.onCollectHost}
                      onAction={actions.onHostAction}
                    />
                  </footer>
                </article>
              );
            })}
          </div>
        ) : null}
        <FleetEmptyState
          hasHosts={total > 0}
          hidden={visibleHosts.length > 0}
          onAddHost={actions.onAddHost}
          onReset={resetFilters}
        />
      </section>
    </main>
  );
}
