import { useState } from 'react';
import { Button, EmptyState, Field, HelpPopover, Input, Combobox, Select, cx } from '@flowhub/plugin-common/react';
import type { NetdataHistory, NetdataPanelProps } from './types';
import { TimeSeriesChart } from '../TimeSeriesChart';
import './styles.css';
import './layout.css';

const CHART_COLORS = ['#a9e8bc', '#7baed7', '#efa85d', '#d995af'];

function HistoryGraph({ history }: { history: NetdataHistory }) {
  const series = history.labels.slice(1);
  return <div className="nd-chart"><TimeSeriesChart rows={history.data} series={series} unit={history.units} colors={CHART_COLORS} label="Netdata 历史曲线" /><div className="nd-legend">{series.map((label, index) => <span key={label}><i style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} />{label}</span>)}</div></div>;
}

export function NetdataPanel({ instances, unassigned, charts, chartLoad, draft, historyQuery, history, installDraft, installHostName, installPreview, suggestion, state, busy = false, actions }: NetdataPanelProps) {
  const [historyExpanded, setHistoryExpanded] = useState(true);
  const current = instances.find((item) => item.id === draft.id);
  const historyInstance = instances.find((item) => item.id === historyQuery.instanceId);
  const statusClass = `nd-status nd-status--${state.status}`;
  function toggleHistory(): void {
    if (history) setHistoryExpanded((open) => !open);
    else {
      setHistoryExpanded(true);
      actions.onQueryHistory();
    }
  }
  return <section className="nd-panel">
    <div className="nd-layout"><div className="nd-main">
      {instances.length > 1 ? <section className="nd-section nd-legacy"><div className="nd-title"><h4>旧版多接入配置</h4></div><p className="nd-note">这台机器原有 {instances.length} 个 Agent。现已限制为单个；请选择要保留的配置，手动移除其余项，不会自动删除历史数据。</p><div className="nd-list">{instances.map((item) => <article key={item.id}><div><strong>{item.name}</strong><span>{item.url}</span></div><div><Button size="sm" variant={draft.id === item.id ? 'secondary' : 'ghost'} disabled={busy} onClick={() => actions.onEdit(item)}>{draft.id === item.id ? '正在编辑' : '编辑此项'}</Button><Button size="sm" variant="danger" disabled={busy} onClick={() => actions.onRemove(item)}>移除</Button></div></article>)}</div></section> : null}
      <section className="nd-section">
        <div className="nd-title"><h4>Agent 配置</h4><small>{current ? '已接入' : '未接入'}</small></div>
        <p className="nd-note">每台机器只需连接一个 Netdata Agent。可直接修改地址以更换当前接入。</p>
        {suggestion ? <div className="nd-suggestion" role="status"><span>{suggestion.message}</span>{suggestion.url ? <Button size="sm" variant="ghost" onClick={actions.onUseSuggestion}>使用此地址</Button> : null}</div> : null}
        <div className="nd-grid nd-config-grid">
          <Field label="Agent 名称" htmlFor="nd-name" required>
            <Input id="nd-name" value={draft.name} maxLength={40} required disabled={busy} onChange={(event) => actions.onDraftChange('name', event.currentTarget.value)} />
          </Field>
          <Field label="Agent 地址" htmlFor="nd-url" required>
            <Input id="nd-url" type="url" value={draft.url} required disabled={busy} placeholder="http://机器IP:19999" onChange={(event) => actions.onDraftChange('url', event.currentTarget.value)} />
          </Field>
        </div>
        <Field className="nd-network-field" label="网速指标" htmlFor="nd-network"><Combobox placeholder="搜索网卡指标" id="nd-network" value={draft.networkChart} disabled={busy} options={[{ value: 'system.net', label: '所有物理网卡 · system.net' }, ...charts.filter((item) => item.id.startsWith('net.')).map((item) => ({ value: item.id, label: item.id }))]} onChange={(value) => actions.onDraftChange('networkChart', value)} /></Field>
      </section>
      {unassigned.length ? <section className="nd-section nd-legacy"><div className="nd-title"><h4>未归属的旧节点 <small>{unassigned.length}</small></h4></div><p className="nd-note">确认地址属于这台机器后可关联。已有 Agent 时请先解除当前接入；关联不会更改远端服务。</p><div className="nd-list">{unassigned.map((item) => <article key={item.id}><div><strong>{item.name}</strong><span>{item.url}</span></div><Button size="sm" variant="secondary" disabled={busy || instances.length > 0} onClick={() => actions.onClaim(item)}>关联到当前机器</Button></article>)}</div></section> : null}
      <section className="nd-section">
        <div className="nd-title nd-history-title">
          <h4>历史趋势</h4>
          {historyInstance ? <Button className="nd-history-toggle" variant="ghost" size="sm" disabled={busy || (!history && (chartLoad !== 'idle' || !charts.some((chart) => chart.id === historyQuery.chartId)))} aria-expanded={history ? historyExpanded : false} aria-controls="nd-history-chart" onClick={toggleHistory}>{history ? (historyExpanded ? '收起曲线' : '展开曲线') : '查看曲线'}</Button> : null}
        </div>
        {historyInstance ? <>
          <div className="nd-grid">
            <Field label="指标" htmlFor="nd-chart"><Combobox placeholder={chartLoad === 'loading' ? '正在读取指标…' : chartLoad === 'error' ? '指标读取失败' : charts.length ? '搜索指标' : 'Agent 未提供指标'} id="nd-chart" value={historyQuery.chartId} disabled={busy || chartLoad === 'loading' || !charts.length} options={charts.map((item) => ({ value: item.id, label: `${item.id}${item.units ? ` · ${item.units}` : ''}` }))} onChange={(value) => actions.onHistoryChange('chartId', value)} /></Field>
            <Field label="时间范围" htmlFor="nd-range"><Select id="nd-range" value={String(historyQuery.seconds)} disabled={busy} options={[['3600','最近 1 小时'],['86400','最近 1 天'],['604800','最近 7 天'],['2592000','最近 30 天']].map(([value,label]) => ({ value, label }))} onChange={(value) => actions.onHistoryChange('seconds', Number(value))} /></Field>
          </div>
          <div id="nd-history-chart" hidden={!history || !historyExpanded}>{history ? <HistoryGraph history={history} /> : null}</div>
        </> : <EmptyState size="compact" title="接入 Agent 后查看历史" />}
      </section>
    </div><div className="nd-install-wrap"><details className="nd-section nd-install">
      <summary>安装 Netdata Agent <small>展开配置</small></summary>
      <div className="nd-install__body">
        <div className="nd-grid nd-install-grid">
          <Field label="端口" htmlFor="nd-port" required>
            <Input id="nd-port" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={5} value={installDraft.port || ''} required disabled={busy} onChange={(event) => { const value = event.currentTarget.value; if (/^\d{0,5}$/.test(value)) actions.onInstallChange('port', value ? Number(value) : 0); }} />
          </Field>
          <Field label="监听" htmlFor="nd-bind"><Select id="nd-bind" value={installDraft.bind} disabled={busy} options={[{value:'0.0.0.0',label:'所有网卡'},{value:'127.0.0.1',label:'仅本机'}]} onChange={(value) => actions.onInstallChange('bind', value)} /></Field>
          <Field label="历史保留" htmlFor="nd-days"><Select id="nd-days" value={String(installDraft.retentionDays)} disabled={busy} options={[7,30,90].map((value)=>({value:String(value),label:`${value} 天`}))} onChange={(value) => actions.onInstallChange('retentionDays', Number(value))} /></Field>
          <Field label="容量" htmlFor="nd-disk"><Select id="nd-disk" value={String(installDraft.diskMiB)} disabled={busy} options={[512,1024,2048,4096].map((value)=>({value:String(value),label:value<1024?`${value} MiB`:`${value/1024} GiB`}))} onChange={(value) => actions.onInstallChange('diskMiB', Number(value))} /></Field>
        </div>
        <div className="nd-actions nd-install-actions"><Button variant="secondary" disabled={busy} onClick={actions.onPreviewInstall}>预览安装</Button>{installPreview ? <Button variant="primary" disabled={busy} onClick={actions.onConfirmInstall}>确认安装</Button> : null}</div>
        {installPreview ? <pre className="nd-plan">目标：{installPreview.name} ({installPreview.alias}){`\n\n`}{installPreview.command}</pre> : null}
      </div>
    </details><HelpPopover className="nd-install__help" label="安装说明">目标机器：{installHostName}。已有安装会先检测并跳过，不会重复改写配置。</HelpPopover></div></div>
    {state.status !== 'idle' ? <p className={cx(statusClass)} role={state.status === 'error' ? 'alert' : 'status'}>{state.message}</p> : null}
  </section>;
}
