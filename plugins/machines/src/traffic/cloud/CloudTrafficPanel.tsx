import { useMemo } from 'react';
import { Checkbox, EmptyState, Field, HelpPopover, Input, Combobox, Select } from '@flowhub/plugin-common/react';
import { CLOUD_PROVIDERS, FIELD_LABELS, SECRET_FIELDS } from './providers';
import type { CloudTrafficPackage, CloudTrafficPanelProps } from './types';
import './styles.css';
import './layout.css';

const WIDE_FIELDS = new Set(['secretId', 'secretKey', 'token', 'apiKey']);

function amount(value: number | undefined, divisor: number) {
  return Number.isFinite(value) ? ((value as number) / divisor).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—';
}

function periodLabel(pack: CloudTrafficPackage, local: boolean) {
  const show = (value?: string) => value?.slice(0, 19).replace('T', ' ');
  const start = local ? show(pack.StartTime) : pack.StartTime?.slice(0, 10);
  const end = local ? show(pack.EndTime) : pack.EndTime?.slice(0, 10);
  if (!start || !end) return local ? '未获取到统计周期' : '服务商未返回周期';
  return local ? `统计周期 ${start}—${end}（下次重置）` : `服务商周期 ${start}—${end}`;
}

function ResultCard({ pack, title, local, divisor, unit }: { pack: CloudTrafficPackage; title: string; local: boolean; divisor: number; unit: string }) {
  const used = pack.TrafficUsed;
  const total = pack.TrafficPackageTotal;
  const hasLimit = Number.isFinite(total) && Number(total) > 0;
  const percent = local ? pack.PercentUsed : Number.isFinite(used) && hasLimit ? Number(used) / Number(total) * 100 : undefined;
  const outbound = local && pack.TrafficDirection === 'tx';
  const rows = local
    ? [['入站 RX', pack.RxBytes], ['出站 TX', pack.TxBytes], [pack.PartialHistory ? '已覆盖用量' : outbound ? '出站统计用量' : '双向合计', used], ['当前日均', pack.DailyAverage]] as const
    : [['已用', used], ['套餐总量', hasLimit ? total : undefined], ['剩余', hasLimit ? pack.TrafficPackageRemaining : undefined], ['超额', hasLimit ? pack.TrafficOverflow : undefined]] as const;
  return <article className="ct-result">
    <header><h4>{title}</h4><span>{local ? `本地估算 · ${outbound ? '仅出站' : '双向'}` : '服务商数据'}</span></header>
    <p>{periodLabel(pack, local)}</p>
    {local && pack.CycleType === 'calendarMonth' ? <p>未设置购买日，暂按北京时间自然月统计。</p> : null}
    {local && pack.BootBaseline ? <p>本期起点与机器开机时间吻合，使用开机后网卡累计计数估算；不等同服务商计费。</p> : null}
    {local && pack.PartialHistory ? <p>历史未覆盖完整周期{pack.CoverageStartTime ? `（首条采样 ${pack.CoverageStartTime.slice(0, 10)}）` : ''}，暂不计算套餐剩余和可用天数。</p> : null}
    <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{amount(value, divisor)} {Number.isFinite(value) ? unit : ''}</dd></div>)}</dl>
    {Number.isFinite(percent) && Number(percent) > 0 ? <div className={`ct-meter ${Number(percent) >= 100 ? 'over' : Number(percent) >= 80 ? 'warn' : ''}`}><i style={{ width: `${Math.min(100, Number(percent))}%` }} /></div> : null}
    {local && Number.isFinite(pack.DaysRemaining) ? <p>按当前日均预计可用 {Number(pack.DaysRemaining).toFixed(1)} 天 · 已累计 {Number(pack.PeriodDays ?? 0).toFixed(1)} 天</p> : null}
  </article>;
}

export function CloudTrafficPanel({ machineName, draft, providers = CLOUD_PROVIDERS, netdataNodes, result, state, busy = false, onChange }: CloudTrafficPanelProps) {
  const provider = providers.find((item) => item.id === draft.provider) ?? providers[0];
  const providerOptions = useMemo(() => providers.map((item) => ({ value: item.id, label: item.name })), [providers]);
  const divisor = result?.summary?.divisor || 1073741824;
  const unit = divisor === 1e9 ? 'GB' : 'GiB';
  const cards = result?.rows.flatMap((row, rowIndex) => (row.TrafficPackageSet ?? []).map((pack, index) => <ResultCard key={`${rowIndex}-${index}`} pack={pack} title={result.instanceName || (result.provider === 'localSsh' ? machineName : row.InstanceId || machineName)} local={result.provider === 'localNet' || result.provider === 'localSsh'} divisor={divisor} unit={unit} />));

  return <section className="ct-panel">
    <section className="ct-form">
      <h4 className="ct-section-title">流量来源</h4>
      <div className="ct-provider"><Field label="服务商" htmlFor="ct-provider"><Combobox placeholder="搜索服务商" id="ct-provider" value={draft.provider} disabled={busy} options={providerOptions} onChange={(value) => onChange('provider', value as typeof draft.provider)} /></Field><HelpPopover label="服务商说明">{provider.help}</HelpPopover></div>
      <div className={`ct-grid${provider.id === 'localNet' || provider.id === 'localSsh' ? ' ct-grid--local' : ''}`}>{provider.fields.map((field) => <Field key={field} label={FIELD_LABELS[field]} htmlFor={`ct-${field}`} className={WIDE_FIELDS.has(field) ? 'ct-wide-field' : 'ct-inline-field'} required={provider.required.includes(field)}>{field === 'netdataId' ? <Combobox id={`ct-${field}`} value={draft[field]} required={provider.required.includes(field)} disabled={busy} options={[...netdataNodes]} placeholder="选择 Netdata 节点" onChange={(value) => onChange(field, value)} /> : field === 'direction' ? <Select id="ct-direction" value={draft.direction} disabled={busy} options={[{ value: 'both', label: '双向（入站＋出站）' }, { value: 'tx', label: '仅出站（TX）' }]} onChange={(value) => onChange('direction', value)} /> : field === 'site' ? <Select id="ct-site" value={draft.site} required={provider.required.includes(field)} disabled={busy} options={[{ value: 'cn', label: '中国站' }, { value: 'intl', label: '国际站' }]} onChange={(value) => onChange('site', value)} /> : <Input id={`ct-${field}`} type={field === 'cycleStart' ? 'datetime-local' : SECRET_FIELDS.includes(field) ? 'password' : 'text'} step={field === 'cycleStart' ? 1 : undefined} autoComplete="off" value={field === 'cycleStart' && /^\d{4}-\d{2}-\d{2}$/.test(draft[field]) ? `${draft[field]}T00:00:00` : draft[field]} disabled={busy} required={provider.required.includes(field)} placeholder={SECRET_FIELDS.includes(field) ? '已保存时留空保留' : field === 'region' ? '例如 ap-shanghai' : ''} onChange={(event) => onChange(field, event.currentTarget.value)} />}</Field>)}</div>
      {provider.fields.includes('token') ? <Checkbox label="清除已保存的临时 Token" checked={draft.clearToken} disabled={busy} onChange={(checked) => onChange('clearToken', checked)} /> : null}
      <p className={`ct-status ct-status--${state.status}`} role={state.status === 'error' ? 'alert' : 'status'}>{state.message ?? (state.configured ? '已自动载入保存配置；密钥留空会沿用。' : '尚未配置，请填写后保存。')}</p>
    </section>
    <section className="ct-results-section">
      <h4 className="ct-section-title">查询结果</h4>
      <div className="ct-results">{result ? cards?.length ? cards : <EmptyState size="compact" title="没有可用流量数据" /> : <EmptyState size="compact" title="尚未查询" description="保存配置后即可查询；页面会自动读取已保存配置。" />}</div>
    </section>
  </section>;
}
