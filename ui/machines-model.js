(function (root) {
  "use strict";
  const validAlias = (s) => typeof s === "string" && s.length > 0 && s.length <= 128 && !s.startsWith("-") && /^[a-zA-Z0-9._:-]+$/.test(s);
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
  const api = { validAlias, escape, visibleHosts, metricStatus, targets, visibleJobs, visibleDiscovered };
  if (typeof module !== "undefined") module.exports = api;
  else root.FlowHubMachines = api;
})(globalThis);
