(function (root) {
  "use strict";
  const validAlias = (s) => typeof s === "string" && s.length > 0 && s.length <= 128 && !s.startsWith("-") && /^[a-zA-Z0-9._:-]+$/.test(s);
  function profileError(p) {
    const token=s=>typeof s==='string' && s.length>0 && s.length<=253 && !s.startsWith('-') && /^[a-zA-Z0-9._:-]+$/.test(s);
    if(!validAlias(p.alias)||p.alias.includes(':'))return ['hostAlias','SSH 别名只能包含字母、数字、点、下划线和连字符，不能以连字符开头'];
    if(!token(p.hostname))return ['sshHostname',p.hostname?'请填写有效的 IP 或主机名，不要包含协议、空格或路径':'请填写主机地址'];
    if(!token(p.user))return ['sshUser',p.user?'登录用户名不能包含空格或特殊符号':'请填写登录用户名，例如 root 或 ubuntu（灰色文字只是示例）'];
    if(!Number.isInteger(p.port)||p.port<1||p.port>65535)return ['sshPort','SSH 端口必须是 1–65535 之间的整数'];
    return null;
  }
  const escape = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function visibleHosts(hosts, filter, group) {
    const q = filter.trim().toLowerCase();
    return hosts.filter(h => (!group || h.group === group) && `${h.name} ${h.alias} ${h.group}`.toLowerCase().includes(q));
  }
  function metricStatus(metric, interval, now = Date.now()) {
    if (!metric) return "unknown";
    if (now - metric.at > Math.max(120000, interval * 2000)) return "stale";
    return metric.status;
  }
  function targets(hosts, selection) { return hosts.filter(h => selection.has(h.id)); }
  function visibleJobs(jobs, instance, status, kind) { return jobs.filter(j => (!instance || (j.hostId || j.alias) === instance) && (!status || j.status === status) && (!kind || j.kind === kind)); }
  function visibleDiscovered(hosts, managed, query, status, source) {
    return hosts.filter(h => `${h.alias} ${h.sources.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()) && (!status || (status === 'managed' ? managed.has(h.alias) : !managed.has(h.alias))) && (!source || h.sources.some(s => s.replace(/:\d+$/, '') === source)));
  }
  const api = { validAlias, profileError, escape, visibleHosts, metricStatus, targets, visibleJobs, visibleDiscovered };
  if (typeof module !== "undefined") module.exports = api;
  else root.FlowHubMachines = api;
})(globalThis);
