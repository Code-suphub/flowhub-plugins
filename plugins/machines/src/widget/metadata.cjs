const flag = (code) => /^[A-Z]{2}$/.test(code || '')
  ? [...code].map((c) => String.fromCodePoint(127397 + c.charCodeAt(0))).join('')
  : '';

function expiry(at, now = Date.now()) {
  if (!Number.isFinite(at)) return null;
  const remaining = at - now;
  const minutes = Math.ceil(Math.abs(remaining) / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const duration = days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${minutes % 60} 分钟` : `${Math.max(1, minutes)} 分钟`;
  return { text: remaining > 0 ? `剩余 ${duration}` : remaining === 0 ? '已到期' : `已过期 ${duration}`, urgent: remaining <= 7 * 86400000, expired: remaining <= 0 };
}

function traffic(value, now = Date.now()) {
  const stale = !value?.at || !Number.isFinite(Date.parse(value.at)) || now - Date.parse(value.at) > 900000;
  const divisor = Number.isFinite(value?.divisor) && value.divisor > 0 ? value.divisor : 1073741824;
  const format = (n) => (n / divisor).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  if (value && !value.error && !stale && value.mode === 'usage' && Number.isFinite(value.used) && value.used >= 0) {
    const used = value.used / divisor;
    const amount = used >= 1 ? `${used.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${divisor === 1e9 ? 'GB' : 'GiB'}`
      : `${(used * 1024).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${divisor === 1e9 ? 'MB' : 'MiB'}`;
    const hasLimit = Number.isFinite(value.total) && value.total > 0;
    const unit = divisor === 1e9 ? 'GB' : 'GiB';
    const label = hasLimit ? used >= 1
      ? `${used.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}/${format(value.total)} ${unit}`
      : `${amount}/${format(value.total)} ${unit}` : amount;
    return { kind: 'usage', label, title: `${value.bootBaseline
      ? '本期估算已用：月周期起点与开机时间吻合，使用网卡计数器估算；不等同服务商计费或准确套餐余额'
      : value.partial
        ? '本期已采集：仅本期首次采样以来的网卡用量；周期历史不完整，不能推算套餐余额'
        : '本期估算已用：本周期监控用量，不代表账单或套餐余额'}${hasLimit ? '；斜杠后为配置额度，不代表可用余额' : ''}` };
  }
  if (!value || value.error || stale || !Number.isFinite(value.remaining) || !Number.isFinite(value.total) || value.total <= 0) {
    return { kind: 'empty', label: '剩余流量 —', hint: !value ? '请先配置并查询云流量' : value.error ? '查询失败 / 暂无有效套餐' : stale ? '流量数据已过期' : '暂无数据' };
  }
  const shared = value.scope === 'account' || value.scope?.startsWith('region:');
  return { kind: 'quota', label: `${shared ? '共享 ' : ''}${format(value.remaining)}/${format(value.total)} GB`, title: shared ? '共享流量池：剩余 / 总量' : '剩余流量 / 套餐总量' };
}

module.exports = { flag, expiry, traffic };
