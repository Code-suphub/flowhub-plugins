import { Button, Checkbox, EmptyState, Field, HelpPopover, Input, Select } from '@flowhub/plugin-common/react';
import { CLOUD_PROVIDERS, FIELD_LABELS, SECRET_FIELDS } from './providers';
import type { CloudTrafficPackage, CloudTrafficPanelProps } from './types';
import './styles.css';

function amount(value: number | undefined, divisor: number) {
  return Number.isFinite(value) ? ((value as number) / divisor).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—';
}

function ResultCard({ pack, title, local, divisor, unit }: { pack: CloudTrafficPackage; title: string; local: boolean; divisor: number; unit: string }) {
  const used = pack.TrafficUsed;
  const total = pack.TrafficPackageTotal;
  const percent = local ? pack.PercentUsed : Number.isFinite(used) && Number.isFinite(total) && Number(total) > 0 ? Number(used) / Number(total) * 100 : undefined;
  const rows = local
    ? [['入站 RX', amount(pack.RxBytes, divisor)], ['出站 TX', amount(pack.TxBytes, divisor)], ['双向合计', amount(used, divisor)], ['当前日均', amount(pack.DailyAverage, divisor)]]
    : [['已用', amount(used, divisor)], ['套餐总量', amount(total, divisor)], ['剩余', amount(pack.TrafficPackageRemaining, divisor)], ['超额', amount(pack.TrafficOverflow, divisor)]];
  return <article className="ct-result"><header><h4>{title}</h4><span>{local ? '自然月 · 双向' : '套餐流量'}</span></header><dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value} {unit}</dd></div>)}</dl>{Number.isFinite(percent) && Number(percent) > 0 ? <div className={`ct-meter ${Number(percent) >= 100 ? 'over' : Number(percent) >= 80 ? 'warn' : ''}`}><i style={{ width: `${Math.min(100, Number(percent))}%` }} /></div> : null}{local && Number.isFinite(pack.DaysRemaining) ? <p>按当前日均预计可用 {Number(pack.DaysRemaining).toFixed(1)} 天 · 已累计 {Number(pack.PeriodDays ?? 0).toFixed(1)} 天</p> : null}</article>;
}

export function CloudTrafficPanel({ machineName, draft, providers = CLOUD_PROVIDERS, netdataNodes, result, state, busy = false, onChange, onSave, onQuery }: CloudTrafficPanelProps) {
  const provider = providers.find((item) => item.id === draft.provider) ?? providers[0];
  const divisor = result?.summary?.divisor || 1073741824;
  const unit = divisor === 1e9 ? 'GB' : 'GiB';
  const cards = result?.rows.flatMap((row, rowIndex) => (row.TrafficPackageSet ?? []).map((pack, index) => <ResultCard key={`${rowIndex}-${index}`} pack={pack} title={result.instanceName || row.InstanceId || machineName} local={result.provider === 'localNet'} divisor={divisor} unit={unit} />));

  return <section className="ct-panel">
    <header className="ct-head"><div><span>TRAFFIC / BILLING CYCLE</span><h3>云流量</h3></div><div className="ct-target"><small>当前机器</small><strong>{machineName}</strong></div></header>
    <section className="ct-form">
      <div className="ct-provider"><Field label="服务商" htmlFor="ct-provider"><Select id="ct-provider" value={draft.provider} disabled={busy} options={providers.map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => onChange('provider', value as typeof draft.provider)} /></Field><HelpPopover label="服务商说明">{provider.help}</HelpPopover></div>
      <div className="ct-grid">{provider.fields.map((field) => <Field key={field} label={FIELD_LABELS[field]} htmlFor={`ct-${field}`}>{field === 'netdataId' ? <Select id={`ct-${field}`} value={draft[field]} disabled={busy} options={[...netdataNodes]} placeholder="选择 Netdata 节点" onChange={(value) => onChange(field, value)} /> : field === 'site' ? <Select id="ct-site" value={draft.site} disabled={busy} options={[{ value: 'cn', label: '中国站' }, { value: 'intl', label: '国际站' }]} onChange={(value) => onChange('site', value)} /> : <Input id={`ct-${field}`} type={SECRET_FIELDS.includes(field) ? 'password' : 'text'} autoComplete={SECRET_FIELDS.includes(field) ? 'new-password' : 'off'} value={draft[field]} disabled={busy} required={provider.required.includes(field)} placeholder={SECRET_FIELDS.includes(field) ? '已保存时留空保留' : field === 'region' ? '例如 ap-shanghai' : ''} onChange={(event) => onChange(field, event.currentTarget.value)} />}</Field>)}</div>
      {provider.fields.includes('token') ? <Checkbox label="清除已保存的临时 Token" checked={draft.clearToken} disabled={busy} onChange={(checked) => onChange('clearToken', checked)} /> : null}
      <div className="ct-actions"><Button variant="secondary" disabled={busy || !state.configured} onClick={onQuery}>查询流量</Button><Button variant="primary" disabled={busy} onClick={onSave}>保存配置</Button></div>
    </section>
    <p className={`ct-status ct-status--${state.status}`} role={state.status === 'error' ? 'alert' : 'status'}>{state.message ?? (state.configured ? '已自动载入保存配置；密钥留空会沿用。' : '尚未配置，请填写后保存。')}</p>
    <section className="ct-results">{result ? cards?.length ? cards : <EmptyState size="compact" title="没有可用流量数据" /> : <EmptyState size="compact" title="尚未查询" description="保存配置后即可查询；页面会自动读取已保存配置。" />}</section>
  </section>;
}
