(function () {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const embedded = window.parent && window.parent !== window && new URLSearchParams(window.location.search).has("embedded");
  const invoke = window.FlowHubPlugin?.invoke || window.__TAURI__?.core?.invoke;
  const readonly = !invoke;
  const reactFleet = window.FlowHubFleet;
  const reactHostEditor = window.FlowHubHostEditor;
  const reactCommand = window.FlowHubCommand;
  let state = { config: { hosts: [], enabled: false, installed: null, interval: 60 }, metrics: {}, active: [], history: [] };
  let selection = new Set();
  let busy = false;
  let refreshVersion = 0;
  const errorText = error => String(error?.message || error).replace(/^(?:Error:\s*)+/, "");
  const message = (text, error = false) => { $("#notice").textContent = error ? errorText(text) : text; $("#notice").classList.toggle("error", error); };

  async function api(action, payload = {}) {
    if (readonly) throw new Error("浏览器为只读预览；请在 FlowHub 桌面版操作。");
    return invoke("machines_api", { action, payload });
  }
  async function refresh() {
    const version = ++refreshVersion;
    if (!readonly) {
      const next = await api("state");
      if (version !== refreshVersion) return;
      state = next;
    }
    render();
  }
  async function operate(fn) {
    if (busy) return;
    busy = true;
    try { await fn(); await refresh(); } catch (error) { message(String(error), true); }
    finally { busy = false; }
  }
  function render() {
    const config = state.config;
    selection = new Set([...selection].filter(id => config.hosts.some(host => host.id === id)));
    $("#version").textContent = config.installed ? `v${config.installed.version}${config.enabled ? "" : " · 已停用"}` : "未安装";
    $("main").hidden = !config.installed || !config.enabled;
    $("#unavailable").hidden = !!config.installed && config.enabled;
    renderHosts(); window.FlowHubCollections?.update([...state.active, ...state.history]); window.FlowHubSelects?.sync();
  }

  function renderHosts() {
    reactFleet?.update({ snapshot: { hosts: state.config.hosts, metrics: state.metrics, activeJobs: state.active }, config: { enabled: !readonly && !!state.config.enabled, monitoring: !!state.config.monitoring, intervalSeconds: state.config.interval || 60 }, selectedHostIds: [...selection], now: Date.now() });
  }

  async function batch(hosts, kind, command) {
    if (!hosts.length) throw new Error("请先选择机器"); if (hosts.length > 16) throw new Error("每批最多 16 台机器，请缩小选择范围");
    message(`正在提交 ${hosts.length} 台机器的${kind === "collect" ? "采集" : "命令"}任务…`);
    const results = await Promise.allSettled(hosts.map(host => invoke("machines_run", { hostId: host.id, expectedAlias: host.alias, id: crypto.randomUUID(), kind, command: command || null })));
    const rejected = results.filter(result => result.status === "rejected"); const unsuccessful = results.filter(result => result.status === "fulfilled" && result.value.status !== "success");
    message(`任务结束：${results.length - rejected.length - unsuccessful.length} 成功，${unsuccessful.length} 未成功，${rejected.length} 未提交。${rejected.length ? " " + rejected.map(result => String(result.reason)).join("；") : ""}`, !!rejected.length || !!unsuccessful.length);
  }
  function submit(hosts, kind, command) { batch(hosts, kind, command).catch(error => message(String(error), true)).finally(() => refresh().catch(error => message(String(error), true))); }

  function runHostAction(host, action) {
    if (action === "collections") { window.FlowHubCollections?.open(host); return; }
    if (readonly || !state.config.enabled) return;
    if (action === "terminal" && host.readOnly) return;
    if (action === "edit") { void reactHostEditor?.open(host.id); return; }
    if (action === "copy") { void reactHostEditor?.open(host.id, { copy: true }); return; }
    if (action === "command") { selection = new Set([host.id]); renderHosts(); reactCommand?.setTargets([host.id]); window.FlowHubMachineTabs?.show("command", true); return; }
    operate(async () => {
      if (action === "terminal") await api(host.bastion ? "bastionTerminal" : "terminal", { hostId: host.id });
      if (action === "delete") await api("hosts", { hosts: state.config.hosts.filter(item => item.id !== host.id) });
    });
  }

  window.addEventListener?.("flowhub:hosts-changed", () => refresh().catch(error => message(String(error), true)));

  window.addEventListener?.("flowhub:fleet-action", event => {
    const detail = event.detail || {};
    if (detail.type === "selection") { selection = new Set((detail.hostIds || []).filter(id => state.config.hosts.some(host => host.id === id))); reactCommand?.setTargets([...selection]); renderHosts(); }
    else if (detail.type === "add") void reactHostEditor?.open();
    else if (detail.type === "collect-selected") { const ids = new Set(detail.hostIds || []); submit(state.config.hosts.filter(host => ids.has(host.id)), "collect"); }
    else if (detail.type === "collect-host") { const host = state.config.hosts.find(item => item.id === detail.hostId); if (host) submit([host], "collect"); }
    else if (detail.type === "host-action") { const host = state.config.hosts.find(item => item.id === detail.hostId); if (host) runHostAction(host, detail.action); }
    else if (detail.type === "monitor") operate(() => api("monitor", { enabled: !!detail.enabled, interval: Number(detail.intervalSeconds) || 60 }));
  });
  if (reactCommand) window.addEventListener("flowhub:command-selection", event => { selection = new Set((event.detail?.hostIds || []).filter(id => state.config.hosts.some(host => host.id === id))); renderHosts(); });

  async function init() {
    try {
      if (window.machineSettingsReady) await window.machineSettingsReady; await refresh();
      if (window.machineSettingsReady) { const id = window.machineSettingsContext?.config?.row || new URLSearchParams(location.search).get("row") || (window.parent === window ? state.config.hosts[0]?.id : ""); if (!id || !state.config.hosts.some(host => host.id === id)) throw new Error("目标机器已移除"); await reactHostEditor?.open(id); }
      if (embedded) document.body.classList.add("embedded"); if (readonly) message("只读浏览器预览 · 安装、机器配置和 SSH 执行请使用 FlowHub 桌面版。此页面没有连接任何机器。");
    } catch (error) { message(String(error), true); }
    if (!readonly) setInterval(() => { if (!document.hidden) refresh().catch(error => message(String(error), true)); }, 2000);
  }
  init();
})();
