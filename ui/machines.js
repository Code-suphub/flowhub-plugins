(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  function confirmAction(title, description, action) {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.style.width = 'min(400px, calc(100vw - 32px))';
      dialog.innerHTML = '<h2 id="actionConfirmTitle"></h2><p id="actionConfirmDescription"></p><div class="actions"><button type="button" data-cancel autofocus>取消</button><button type="button" class="danger" data-confirm></button></div>';
      dialog.setAttribute('aria-labelledby', 'actionConfirmTitle');
      dialog.setAttribute('aria-describedby', 'actionConfirmDescription');
      dialog.querySelector('h2').textContent = title;
      dialog.querySelector('p').textContent = description;
      dialog.querySelector('[data-confirm]').textContent = action;
      const previous = document.activeElement;
      dialog.querySelector('[data-cancel]').onclick = () => dialog.close('cancel');
      dialog.querySelector('[data-confirm]').onclick = () => dialog.close('confirm');
      dialog.addEventListener('close', () => {
        const accepted = dialog.returnValue === 'confirm';
        dialog.remove();
        if (previous?.isConnected) previous.focus();
        resolve(accepted);
      }, { once: true });
      document.body.append(dialog);
      dialog.showModal();
    });
  }
  const M = window.FlowHubMachines;
  const esc = M.escape;
  const embedded = window.parent && window.parent !== window && new URLSearchParams(window.location.search).has("embedded");
  const host = window;
  const invoke = window.FlowHubPlugin?.invoke || host.__TAURI__?.core?.invoke;
  const readonly = !invoke;
  $('#openStatus').onclick=async()=>{
    if(!window.FlowHubPlugin){message('桌面组件与菜单栏需在 FlowHub 中使用，浏览器预览不创建系统窗口。');return;}
    try{await window.FlowHubPlugin.invoke('flowhub_status',{});}catch(e){message(String(e),true);}
  };
  let state = { config: { hosts: [], enabled: false, installed: null, interval: 60 }, metrics: {}, active: [], history: [] };
  let selection = new Set();
  let busy = false;
  let commandRunning = false;
  let lastJobs = "";
  let lastHosts = "";
  let lastGroups = "";
  let lastTemplates = "";
  let lastTargets = "";
  let refreshVersion = 0;
  let sshRevision = "";
  let sshLoadedAlias = "";
  let sshBaseline = '';
  let sshEditVersion = 0, sshEditStatus = 'ready';
  let bastionHostId = '', bastionBusy = false, bastionPolling = false, bastionConnected = false;
  const jobDetails = new Map();
  const consoleJobs = new Map();
  let consoleMarkup = '';
  let collectionHost = null;
  let lastCollections = '';
  const labels = { interrupted: "结果未知", success: "成功", failed: "失败", timeout: "超时", cancelled: "已取消", running: "执行中", queued: "排队", stale: "已过期", unknown: "未采集" };
  const errorText = error => String(error?.message || error).replace(/^(?:Error:\s*)+/, '');
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
    try { await fn(); await refresh(); } catch (e) { message(String(e), true); }
    finally { busy = false; }
  }
  function filtered() { return M.visibleHosts(state.config.hosts, $("#filter").value, $("#group").value); }
  function chosen() { return M.targets(state.config.hosts, selection); }
  function bastionHost() { const hosts = chosen(); return hosts.length === 1 && hosts[0].bastion ? hosts[0] : null; }
  function templates() { return state.config.templates ?? state.config.installed?.templates ?? []; }
  function render() {
    const c = state.config;
    window.FlowHubSshDiscovery?.update(c, api, refresh);
    selection = new Set([...selection].filter(id => c.hosts.some(h => h.id === id)));
    $("#version").textContent = c.installed ? `v${c.installed.version}${c.enabled ? "" : " · 已停用"}` : "未安装";
    $("main").hidden = !c.installed || !c.enabled;
    $("#unavailable").hidden = !!c.installed && c.enabled;
    for (const id of ["addHost", "collectSelected", "runCommand", "monitor", "interval"]) $("#" + id).disabled = readonly || !c.enabled;
    $("#runCommand").disabled ||= commandRunning;
    $("#runCommand").textContent = commandRunning ? "执行中…" : "执行 ↵";
    for (const id of ["sshProbe", "chooseIdentity"]) $("#" + id).disabled = readonly || !c.enabled || !c.installed?.capabilities.includes("ssh:configure") || (id==='chooseIdentity' && $('#sshAuth').value==='password');
    $("#monitor").checked = !!c.monitoring;
    if (![...$("#interval").options].some(o => o.value === String(c.interval || 60))) $("#interval").add(new Option(`每 ${c.interval} 秒`, String(c.interval)));
    $("#interval").value = String(c.interval || 60);
    $('#connectionMode').value = c.reuseConnections ? 'reuse' : 'independent';
    $('#connectionSummary').textContent = c.reuseConnections ? '复用已认证连接' : '每次独立连接';
    $('#connectionIdle').value = String(c.connectionIdleSeconds >= 3600 ? c.connectionIdleSeconds : 28800);
    $('#connectionMode').disabled = readonly || !c.enabled;
    $('#connectionIdle').disabled = readonly || !c.enabled || !c.reuseConnections;
    $('#connectionIdleField').hidden = !c.reuseConnections;
    const group = $("#group").value;
    const groups = [...new Set(c.hosts.map(h => h.group).filter(Boolean))].sort();
    const groupOptions = '<option value="">全部分组</option>' + groups.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join("");
    if (groupOptions !== lastGroups) { $("#group").innerHTML = groupOptions; lastGroups = groupOptions; }
    $("#group").value = groups.includes(group) ? group : "";
    const statuses = c.hosts.map(h => M.metricStatus(state.metrics[h.id], c.interval || 60));
    $("#totalCount").textContent = c.hosts.length;
    $("#healthyCount").textContent = statuses.filter(s => s === "success").length;
    $("#failedCount").textContent = statuses.filter(s => s !== "success" && s !== "unknown").length;
    $("#activeCount").textContent = state.active.length;
    const templateValue = $("#template").value;
    $("#templatePicker").hidden = !templates().length;
    $("#manageTemplates").disabled = readonly || !c.enabled;
    const templateOptions = '<option value="">选择命令模板</option>' + templates().map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join("");
    if (templateOptions !== lastTemplates) { $("#template").innerHTML = templateOptions; lastTemplates = templateOptions; }
    $("#template").value = templateValue;
    renderHosts(); renderJobs(); renderConsole(); renderCollections();
    window.FlowHubSelects?.sync();
  }
  function renderHosts() {
    const hosts = filtered(); const c = state.config;
    const hostMarkup = hosts.map(h => {
      const metric = state.metrics[h.id]; const status = M.metricStatus(metric, c.interval || 60);
      const values = status === "success" ? metric.values : null;
      const pct = k => values ? `${Number(values[k]).toFixed(1)}<small>%</small>` : "—";
      const disabled = readonly || !c.enabled ? "disabled" : "";
      return `<tr><td><input type="checkbox" data-select="${esc(h.id)}" ${selection.has(h.id) ? "checked" : ""} aria-label="选择 ${esc(h.name)}"></td><td><strong>${esc(h.name)}${h.readOnly ? ' · 仅查询' : ''}</strong><small>${esc(h.alias)}${h.group ? " / " + esc(h.group) : ""}</small></td><td><span class="status ${esc(status)}" title="${esc(metric?.error || "")}">${labels[status] || esc(status)}</span><small>${metric ? new Date(metric.at).toLocaleTimeString() : ""}</small></td><td>${pct("cpu")}</td><td>${pct("memory")}</td><td>${pct("disk")}</td><td>${values ? `${Number(values.load).toFixed(2)}<small>${Math.floor(values.uptime / 86400)} 天 ${Math.floor(values.uptime % 86400 / 3600)} 时</small>` : "—"}</td><td><button data-host-action="collect" data-id="${esc(h.id)}" ${disabled}>采集</button> <button data-host-action="collections" data-id="${esc(h.id)}">采集记录</button> <button data-host-action="command" data-id="${esc(h.id)}" ${disabled}>命令</button> <button data-host-action="terminal" data-id="${esc(h.id)}" ${h.readOnly ? 'disabled title="仅查询机器不允许系统终端"' : disabled}>系统终端</button> <button data-host-action="copy" data-id="${esc(h.id)}" ${disabled}>复制</button> <button data-host-action="edit" data-id="${esc(h.id)}" ${disabled}>编辑</button> <button data-host-action="delete" data-id="${esc(h.id)}" ${disabled} aria-label="删除 ${esc(h.name)}">×</button></td></tr>`;
    }).join("");
    if (hostMarkup !== lastHosts) { $("#hostRows").innerHTML = hostMarkup; lastHosts = hostMarkup; }
    $("#empty").hidden = hosts.length > 0;
    $("#empty h3").textContent = c.hosts.length ? "没有匹配的机器" : "从一台机器开始";
    $("#selectAll").checked = hosts.length > 0 && hosts.every(h => selection.has(h.id));
    $("#selectAll").indeterminate = hosts.some(h => selection.has(h.id)) && !$("#selectAll").checked;
    $("#selectionInfo").textContent = selection.size ? `已选择 ${selection.size} 台：${chosen().map(h => h.name + ' (' + h.alias + ')').join('、')}` : "请在上方下拉框选择目标机器";
    renderTargets();
  }
  function renderTargets() {
    const hasBastion = chosen().some(h => h.bastion);
    $('#directCommandPanel').hidden = hasBastion;
    $('#ordinaryConnectionSettings').hidden = hasBastion;
    $('#bastionWorkbench').hidden = !hasBastion;
    const current = bastionHost();
    $('#bastionWorkbench h2').textContent = current ? `堡垒机会话 · ${current.name} (${current.alias})` : '堡垒机会话';
    if ((current?.id || '') !== bastionHostId) { bastionHostId = current?.id || ''; bastionConnected = false; $('#bastionOutput').textContent = '尚未连接此机器的会话。'; $('#bastionInput').value = ''; }
    $('#bastionState').textContent = !current ? '请选择一台堡垒机机器' : bastionConnected ? '会话已连接' : '未连接';
    for (const id of ['bastionConnect', 'bastionAttach', 'bastionDisconnect', 'bastionInterrupt', 'bastionSend', 'bastionEnter']) $('#' + id).disabled = readonly || !current || bastionBusy || (id !== 'bastionConnect' && !bastionConnected);
    if (current?.readOnly) for (const id of ['bastionAttach','bastionInterrupt','bastionSend','bastionEnter']) $('#'+id).disabled = true;
    $('#bastionInput').disabled = !!current?.readOnly;
    $('#bastionQueryRun').disabled = readonly || !current || !bastionConnected || bastionBusy;
    $('#targetSummary').textContent = selection.size ? `已选 ${selection.size} 台机器 ▾` : '选择目标机器 ▾';
    const hosts = M.visibleHosts(state.config.hosts, $('#targetSearch').value, '');
    const markup = hosts.map(h => `<label class="target-option"><input type="checkbox" data-target="${esc(h.id)}" ${selection.has(h.id) ? 'checked' : ''} ${readonly || !state.config.enabled ? 'disabled' : ''}><span>${esc(h.name)}<small>${esc(h.alias)}${h.group ? ' · ' + esc(h.group) : ''}</small></span></label>`).join('') || '<p class="caption">没有匹配的机器</p>';
    if (markup !== lastTargets) { $('#targetOptions').innerHTML = markup; lastTargets = markup; }
  }
  $('#targetSearch').oninput = renderTargets;
  $('#targetOptions').onchange = e => { const id = e.target.dataset.target; if (!id || !state.config.hosts.some(h => h.id === id)) return; e.target.checked ? selection.add(id) : selection.delete(id); renderHosts(); };
  $('#clearTargets').onclick = () => { selection.clear(); renderHosts(); };
  $('#confirmTargets').onclick = () => { $('#targetPicker').open = false; $('#targetSummary').focus(); };
  document.addEventListener?.('pointerdown', e => { if (!$('#targetPicker').contains(e.target)) $('#targetPicker').open = false; });
  $('#targetPicker').addEventListener('keydown', e => { if (e.key === 'Escape') { $('#targetPicker').open = false; $('#targetSummary').focus(); e.preventDefault(); } });
  let historyPage = 1, historyVersion = 0;
  async function renderJobs(force = false) {
    if (readonly || (!force && $('#historyPanel').hidden !== false)) { paintJobs(); return; }
    const version = ++historyVersion;
    try {
      const result = await api('history', { page: historyPage, pageSize: Number($('#historyPageSize').value) || 20, hostId: $('#jobInstance').value, status: $('#jobStatus').value });
      if (version !== historyVersion) return;
      historyPage = result.page; paintJobs(result); window.FlowHubSelects?.sync();
    } catch (error) { if (version === historyVersion) $('#jobCount').textContent = `读取执行记录失败：${error}`; }
  }
  function paintJobs(result) {
    const allJobs = result?.items || [...state.active, ...state.history].filter(j => j.kind === 'command');
    const instances = new Map(state.config.hosts.map(h => [h.id, `${h.name} (${h.alias})`]));
    for (const j of result?.instances || allJobs) if (!instances.has(j.hostId || j.alias)) instances.set(j.hostId || j.alias, `${j.alias}（历史实例）`);
    const current = $('#jobInstance').value;
    const options = '<option value="">全部实例</option>' + [...instances].map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
    if ($('#jobInstance').innerHTML !== options) { $('#jobInstance').innerHTML = options; $('#jobInstance').value = instances.has(current) ? current : ''; }
    const jobs = result ? allJobs : M.visibleJobs(allJobs, $('#jobInstance').value, $('#jobStatus').value, 'command');
    $('#jobCount').textContent = `共 ${result?.total ?? jobs.length} 条记录 · 本页 ${jobs.length} 条`;
    $('#historyPageInfo').textContent = `${result?.page || 1} / ${result?.pages || 1} 页`;
    $('#historyPrev').disabled = !result || result.page <= 1;
    $('#historyNext').disabled = !result || result.page >= result.pages;
    const signature = JSON.stringify(jobs);
    for (const id of jobDetails.keys()) if (!allJobs.some(j => j.id === id)) jobDetails.delete(id);
    if (signature === lastJobs) return; lastJobs = signature;
    const open = new Set([...document.querySelectorAll(".job details[open]")].map(el => el.dataset.job));
    $("#jobs").innerHTML = jobs.map(j => `<div class="job"><details data-job="${esc(j.id)}" ${open.has(j.id) ? "open" : ""}><summary><span class="status ${esc(j.status)}">${labels[j.status] || esc(j.status)}</span><strong>${esc(j.alias)}</strong><span>${j.kind === "collect" ? "指标采集" : "远程命令"}</span><span class="time">${new Date(j.startedAt).toLocaleString()}${j.exitCode != null ? ` · exit ${j.exitCode}` : ""}</span></summary>${j.finishedAt ? '<pre data-job-output>展开以加载输出</pre>' : '<p class="caption">任务完成后显示输出。</p>'}</details>${!j.finishedAt ? `<button data-cancel="${esc(j.id)}" type="button">取消</button>` : ""}</div>`).join("") || '<p class="caption">暂无执行记录</p>';
    for (const el of document.querySelectorAll(".job details[open]")) loadJob(el);
  }
  for (const id of ['jobInstance', 'jobStatus', 'historyPageSize']) $('#' + id).onchange = () => { historyPage = 1; renderJobs(true); };
  $('#historyPrev').onclick = () => { historyPage = Math.max(1, historyPage - 1); renderJobs(true); };
  $('#historyNext').onclick = () => { historyPage++; renderJobs(true); };
  $('#historyTab').addEventListener('click', () => renderJobs(true));
  function renderCollections() {
    if (!collectionHost) return;
    const jobs = [...state.active, ...state.history].filter(j => j.kind === 'collect' && j.hostId === collectionHost.id);
    const signature = JSON.stringify(jobs);
    if (signature === lastCollections) return; lastCollections = signature;
    $('#collectionTitle').textContent = `${collectionHost.name} · 采集记录`;
    $('#collectionRows').innerHTML = jobs.map(j => `<div class="job"><details data-job="${esc(j.id)}"><summary><span class="status ${esc(j.status)}">${labels[j.status] || esc(j.status)}</span><span>${new Date(j.startedAt).toLocaleString()}</span></summary>${j.finishedAt ? '<pre data-job-output>展开以加载采集详情</pre>' : '<p>正在采集…</p>'}</details></div>`).join('') || '<p class="caption">暂无该机器的采集记录。</p>';
  }
  $('#collectionRows').addEventListener('toggle', e => { if (e.target.matches('details')) loadJob(e.target); }, true);
  $('#closeCollections').onclick = () => $('#collectionDialog').close();
  $('#collectionDialog').onclose = () => { collectionHost = null; lastCollections = ''; };
  async function loadJob(details) {
    const output = details.querySelector("[data-job-output]");
    if (!details.open || !output) return;
    try {
      const j = jobDetails.get(details.dataset.job) || await api("job", { id: details.dataset.job });
      jobDetails.set(j.id, j);
      output.textContent = `${j.command ? "[command]\n" + j.command + "\n\n" : ""}${j.stdout || "（无标准输出）"}${j.stderr ? "\n\n[stderr]\n" + j.stderr : ""}${j.truncated ? "\n\n[输出已截断]" : ""}`;
    } catch (e) { output.textContent = String(e); }
  }
  $("#jobs").addEventListener("toggle", e => { if (e.target.matches("details")) loadJob(e.target); }, true);
  function renderConsole(forceFollow = false) {
    for (const j of state.active) if (consoleJobs.has(j.id) && !consoleJobs.get(j.id).finishedAt) Object.assign(consoleJobs.get(j.id), { status: j.status });
    const rows = [...consoleJobs.values()];
    const markup = rows.map(j => `<article class="console-job"><header><strong>${esc(j.name || j.alias)} <small>${esc(j.alias)}</small></strong><span class="status ${esc(j.status)}">${labels[j.status] || esc(j.status)}${j.exitCode != null ? ` · exit ${j.exitCode}` : ''}</span>${!j.finishedAt ? `<button type="button" data-console-cancel="${esc(j.id)}">取消</button>` : ''}</header><pre class="console-command">$ ${esc(j.command || '')}</pre>${j.finishedAt ? `<pre class="console-output">${esc(j.stdout || '（无标准输出）')}</pre>${j.stderr ? `<pre class="console-error">${esc(j.stderr)}</pre>` : ''}${j.truncated ? '<p class="caption">输出已截断</p>' : ''}` : '<p class="caption">命令执行中，结束后在此显示输出…</p>'}</article>`).join('') || '<p class="console-empty">选择目标机器，在下方输入命令。<br>执行结果将直接显示在这里。</p>';
    if (markup !== consoleMarkup) {
      const output=$('#consoleOutput'),follow=forceFollow || output.scrollHeight-output.scrollTop-output.clientHeight<48;
      output.innerHTML = markup; consoleMarkup = markup;
      if(follow)output.scrollTop=output.scrollHeight;
    }
    const targets=chosen();$('#terminalPrompt').textContent=targets.length===1?`${targets[0].alias} $`:targets.length?`${targets.length} 台 $`:'$';
    $('#consoleCount').textContent = `${rows.length} 条 · ${rows.filter(j => !j.finishedAt).length} 条执行中`;
  }
  $('#clearConsole').onclick = () => { for (const [id, j] of consoleJobs) if (j.finishedAt) consoleJobs.delete(id); renderConsole(); };
  $('#consoleOutput').onclick = async e => {
    const id = e.target.closest('[data-console-cancel]')?.dataset.consoleCancel;
    if (!id) return;
    try { await api('cancel', { id }); message('已请求取消。'); } catch (err) { message(String(err), true); }
  };
  const inputHistory=[];let historyIndex=0,historyDraft='';
  function sizeCommand(){const input=$('#command');if(input.style){input.style.height='auto';input.style.height=Math.min(150,Math.max(30,input.scrollHeight))+'px';}}
  $('#command').addEventListener('input',sizeCommand);
  $('#command').addEventListener('keydown', e => {
    if(e.isComposing||e.keyCode===229)return;
    const input=$('#command');
    if(e.key==='Enter' && !e.shiftKey){e.preventDefault();$('#runCommand').onclick();return;}
    if((e.key==='ArrowUp'||e.key==='ArrowDown')&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.shiftKey&&!input.value.includes('\n')&&inputHistory.length){
      e.preventDefault();if(historyIndex===inputHistory.length)historyDraft=input.value;
      historyIndex=Math.max(0,Math.min(inputHistory.length,historyIndex+(e.key==='ArrowUp'?-1:1)));
      input.value=historyIndex===inputHistory.length?historyDraft:inputHistory[historyIndex];sizeCommand();
    }
  });
  async function batch(hosts, kind, command) {
    if (!hosts.length) throw new Error("请先选择机器");
    if (hosts.length > 16) throw new Error("每批最多 16 台机器，请缩小选择范围");
    message(`正在提交 ${hosts.length} 台机器的${kind === "collect" ? "采集" : "命令"}任务…`);
    const results = await Promise.allSettled(hosts.map(async h => {
      const id = crypto.randomUUID();
      if (kind === 'command') {
        consoleJobs.set(id, { id, name: h.name, alias: h.alias, command, status: 'queued', finishedAt: null });
        while (consoleJobs.size > 100) { const old = [...consoleJobs].find(([, j]) => j.finishedAt); if (!old) break; consoleJobs.delete(old[0]); }
        renderConsole(true);
      }
      try {
        const result = await invoke("machines_run", { hostId: h.id, expectedAlias: h.alias, id, kind, command: command || null });
        if (kind === 'command') { Object.assign(consoleJobs.get(id), result, { finishedAt: result.finishedAt || Date.now() }); renderConsole(); }
        return result;
      } catch (error) {
        if (kind === 'command') { Object.assign(consoleJobs.get(id), { status: 'failed', stderr: String(error), finishedAt: Date.now() }); renderConsole(); }
        throw error;
      }
    }));
    const rejected = results.filter(r => r.status === "rejected");
    const unsuccessful = results.filter(r => r.status === "fulfilled" && r.value.status !== "success");
    message(`任务结束：${results.length - rejected.length - unsuccessful.length} 成功，${unsuccessful.length} 未成功，${rejected.length} 未提交。${rejected.length ? " " + rejected.map(r => String(r.reason)).join("；") : ""}`, !!rejected.length || !!unsuccessful.length);
  }
  function submit(hosts, kind, command) {
    batch(hosts, kind, command).catch(e => message(String(e), true)).finally(() => refresh().catch(e => message(String(e), true)));
  }
  $("#filter").oninput = renderHosts; $("#group").onchange = renderHosts;
  $("#selectAll").onchange = e => { for (const h of filtered()) e.target.checked ? selection.add(h.id) : selection.delete(h.id); renderHosts(); };
  $("#hostRows").onchange = e => { if (e.target.dataset.select) { e.target.checked ? selection.add(e.target.dataset.select) : selection.delete(e.target.dataset.select); renderHosts(); } };
  async function edit(host) {
    for(const id of ['hostAlias','sshHostname','sshUser','sshPort']){
      document.getElementById?.(id+'Error')?.remove();
      $('#'+id).removeAttribute?.('aria-invalid');$('#'+id).removeAttribute?.('aria-describedby');
    }
    $('#sshAuth').value='key'; $('#sshPassword').value=''; authForm();
    sshEditVersion++; sshEditStatus = 'ready';
    $("#saveHost").disabled = false; $("#retrySshLoad").hidden = true;
    sshRevision = ""; sshLoadedAlias = "";
    for (const id of ["sshHostname", "sshUser", "sshJump", "sshIdentity"]) $("#" + id).value = "";
    $("#sshPort").value = "22";
    $("#sshStatus").textContent = '可直接沿用本机 SSH 配置；修改下方连接信息后，点击底部保存一并写入。';
    $("#hostForm").hidden = false; $("#hostId").value = host?.id || ""; $("#hostName").value = host?.name || ""; $("#hostAlias").value = host?.alias || ""; $("#hostGroup").value = host?.group || ""; $("#hostName").focus();
    sshBaseline = sshSignature();
    const groups = [...new Set(state.config.hosts.map(h => h.group).filter(Boolean))];
    $('#groupChoice').innerHTML = '<option value="">未分组</option>' + groups.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('') + '<option value="__new">＋ 新建分组</option>';
    $('#groupChoice').value = host?.group || ''; $('#hostGroup').hidden = true;
    window.FlowHubSelects?.sync();
    $('#hostConnectionType').value = host?.bastion ? 'bastion' : 'ssh';
    $('#relayScript').value = host?.bastion?.script || '';
    $('#relayCommand').value = host?.bastion?.command || 'n';
    $('#hostReadOnly').checked = !!host?.readOnly;
    connectionForm();
    if (host && !host.bastion) await loadSshForEdit();
  }
  function connectionForm() {
    const bastion = $('#hostConnectionType').value === 'bastion';
    $('#bastionFields').hidden = !bastion; $('#directSshFields').hidden = bastion;
    $('#bastionFields').disabled = !bastion; $('#directSshFields').disabled = bastion;
    $('#relayScript').required = bastion;
    window.FlowHubSelects?.sync();
  }
  $('#hostConnectionType').onchange = () => {
    sshEditVersion++; sshEditStatus = 'ready'; $('#saveHost').disabled = false; $('#retrySshLoad').hidden = true;
    connectionForm();
    if ($('#hostConnectionType').value === 'ssh' && $('#hostId').value) loadSshForEdit();
  };
  async function loadSshForEdit() {
    const version = ++sshEditVersion, alias = $('#hostAlias').value.trim();
    sshEditStatus = 'loading'; $('#saveHost').disabled = true; $('#directSshFields').disabled = true;
    $('#retrySshLoad').hidden = true; $('#sshStatus').textContent = '正在加载这台机器的 SSH 配置…';
    try {
      const result = await api('sshRead', { alias });
      if (version !== sshEditVersion || $('#hostForm').hidden) return;
      const p = result.profile;
      $('#sshHostname').value = p.hostname; $('#sshUser').value = p.user; $('#sshPort').value = p.port;
      $('#sshJump').value = p.proxyJump; $('#sshIdentity').value = p.identityFile;
      $('#sshAuth').value=result.passwordAuth?'password':'key'; $('#sshPassword').value=''; authForm();
      sshRevision = result.revision; sshLoadedAlias = alias; sshBaseline = sshSignature();
      sshEditStatus = 'ready'; $('#sshStatus').textContent = '已加载连接配置。未修改的字段继续沿用现有 SSH 配置。';
    } catch (error) {
      if (version !== sshEditVersion || $('#hostForm').hidden) return;
      sshEditStatus = 'error'; $('#sshStatus').textContent = `配置加载失败：${error}。请重试后保存。`;
      $('#retrySshLoad').hidden = false;
    } finally {
      if (version === sshEditVersion) {
        $('#saveHost').disabled = sshEditStatus !== 'ready';
        $('#directSshFields').disabled = sshEditStatus !== 'ready';
      }
    }
  }
  $('#retrySshLoad').onclick = loadSshForEdit;
  $('#hostAlias').oninput = () => {
    if (!$('#hostId').value || $('#hostConnectionType').value !== 'ssh') return;
    sshEditVersion++; sshEditStatus = 'loading'; $('#saveHost').disabled = true; $('#directSshFields').disabled = true;
    $('#sshStatus').textContent = '输入完成后自动加载该别名的配置。';
  };
  $('#hostAlias').onchange = () => {
    if ($('#hostId').value && $('#hostConnectionType').value === 'ssh') loadSshForEdit();
  };
  $("#addHost").onclick = () => edit(null);
  $('#groupChoice').onchange = () => {
    const value = $('#groupChoice').value;
    $('#hostGroup').hidden = value !== '__new';
    $('#hostGroup').value = value === '__new' ? '' : value;
    if (value === '__new') $('#hostGroup').focus();
  };
  $("#cancelHost").onclick = () => { sshEditVersion++; $('#sshPassword').value=''; $("#hostForm").hidden = true; };
  function sshDraft() {
    return { alias: $("#hostAlias").value.trim(), hostname: $("#sshHostname").value.trim(), user: $("#sshUser").value.trim(), port: Number($("#sshPort").value), identityFile: $("#sshIdentity").value.trim(), proxyJump: $("#sshJump").value.trim() };
  }
  $('#sshUser').setAttribute?.('placeholder','必填，例如 root 或 ubuntu');
  for(const id of ['hostAlias','sshHostname','sshUser','sshPort']){
    $('#'+id).addEventListener('input',()=>{
      $('#'+id).setCustomValidity?.('');$('#'+id).removeAttribute?.('aria-invalid');
      document.getElementById?.(id+'Error')?.remove();
    });
  }
  function validateProfile(profile){
    const error=M.profileError(profile);if(!error)return;
    const [id,text]=error,input=$('#'+id);
    document.getElementById?.(id+'Error')?.remove();
    input.insertAdjacentHTML?.('afterend',`<small class="field-error" id="${id}Error" role="alert">${esc(text)}</small>`);
    input.setAttribute?.('aria-invalid','true');input.setAttribute?.('aria-describedby',id+'Error');
    input.focus();$('#sshStatus').textContent=text;throw new Error(text);
  }
  function sshSignature(profile = sshDraft()) { return JSON.stringify({ ...profile, alias: '',passwordAuth:$('#sshAuth').value==='password' }); }
  function authForm(){const password=$('#sshAuth').value==='password';$('#sshPasswordField').hidden=!password;$('#sshIdentity').disabled=password;$('#chooseIdentity').disabled=password;window.FlowHubSelects?.sync();}
  $('#sshAuth').onchange=authForm;
  for (const action of ["sshProbe", "chooseIdentity"]) $("#" + action).onclick = () => operate(async () => {
    try {
      const alias = $("#hostAlias").value.trim();
      if (action === "chooseIdentity") {
        const result = await api(action); if (!result.canceled) $("#sshIdentity").value = result.path; return;
      }
      const profile = sshDraft();
      if(sshSignature(profile)!==sshBaseline)validateProfile(profile);
      if ($('#sshPassword').value || sshSignature(profile)!==sshBaseline && $('#sshAuth').value==='password') throw new Error('请先保存密码和连接配置，再测试连接。');
      {
        $("#sshStatus").textContent = "正在测试当前表单：SSH 握手、认证与执行，最多等待 20 秒…";
        const result = await api(action, sshSignature(profile) === sshBaseline ? { alias } : { alias, profile });
        $("#sshStatus").textContent = `${JSON.stringify(profile) !== JSON.stringify(sshDraft()) ? "表单已修改；以下结果属于修改前的配置，请重新测试。\n" : ""}${result.reason}（${result.durationMs} ms）${result.stderr ? "\n" + result.stderr : ""}`;
      }
    } catch (e) { $("#sshStatus").textContent = errorText(e); throw e; }
  });
  $("#hostForm").onsubmit = e => { e.preventDefault(); operate(async () => {
    const h = { id: $("#hostId").value || crypto.randomUUID(), name: $("#hostName").value.trim(), alias: $("#hostAlias").value.trim(), group: $("#hostGroup").value.trim() };
    h.bastion = $('#hostConnectionType').value === 'bastion' ? { script: $('#relayScript').value.trim(), target: h.alias, command: $('#relayCommand').value } : null;
    h.readOnly = $('#hostReadOnly').checked;
    if (!h.bastion && sshEditStatus !== 'ready') throw new Error('请等待 SSH 配置加载成功后再保存。');
    if (!M.validAlias(h.alias)) throw new Error("SSH 别名只能包含字母、数字、点、下划线、冒号和连字符，不能以连字符开头");
    const hosts = state.config.hosts.filter(existing => existing.id !== h.id); hosts.push(h);
    const profile = sshDraft();
    if(!h.bastion && (sshSignature(profile)!==sshBaseline || $('#sshPassword').value))validateProfile(profile);
    let savedSsh = false;
    $('#hostForm').inert = true;
    try {
      if (!h.bastion && (sshSignature(profile) !== sshBaseline || $('#sshPassword').value)) {
        if (!sshRevision || sshLoadedAlias !== h.alias) {
          const current = await api('sshRead', { alias: h.alias }); sshRevision = current.revision; sshLoadedAlias = h.alias;
        }
        const result = await api('sshSave', { profile, revision: sshRevision,passwordAuth:$('#sshAuth').value==='password',password:$('#sshPassword').value || null }); sshRevision = result.revision; $('#sshPassword').value='';
        sshBaseline = sshSignature(profile); savedSsh = true;
      }
      await api("hosts", { hosts }); $('#sshPassword').value=''; $("#hostForm").hidden = true; message(h.bastion ? '堡垒机配置已保存到插件。' : savedSsh ? '机器连接配置已保存到插件。' : '机器已保存。');
    } catch (error) { throw new Error(`${savedSsh ? 'SSH 配置已写入，但机器清单保存失败，请重试。' : ''}${error}`); }
    finally { $('#hostForm').inert = false; }
  }); };
  $("#hostRows").onclick = e => {
    const button = e.target.closest("[data-host-action]"); if (!button) return;
    const h = state.config.hosts.find(h => h.id === button.dataset.id); if (!h) return;
    if (button.dataset.hostAction === 'collections') { collectionHost = h; lastCollections = ''; renderCollections(); $('#collectionDialog').showModal(); return; }
    if (button.dataset.hostAction === "edit") { edit(h); return; }
    if (button.dataset.hostAction === 'copy') {
      operate(async () => {
        await edit(h);
        if (!h.bastion && sshEditStatus !== 'ready') throw Error('原配置加载失败，请重试后复制');
        $('#hostId').value = ''; $('#hostName').value = h.name + ' 副本'; $('#hostAlias').value = '';
        sshRevision = ''; sshLoadedAlias = ''; sshBaseline = ''; $('#sshPassword').value = '';
        $('#hostAlias').focus();
        message('已复制到新增表单，请填写新的目标机器。已保存密码不会复制。');
      }); return;
    }
    if (button.dataset.hostAction === 'command') { selection = new Set([h.id]); renderHosts(); window.FlowHubMachineTabs?.show('command', true); return; }
    operate(async () => {
      if (button.dataset.hostAction === "collect") submit([h], "collect");
      if (button.dataset.hostAction === "terminal") await api(h.bastion ? 'bastionTerminal' : "terminal", { hostId: h.id });
      if (button.dataset.hostAction === "delete" && await confirmAction('移除机器', `确定从清单移除“${h.name}”？不会删除远端数据。`, '确认移除')) await api("hosts", { hosts: state.config.hosts.filter(x => x.id !== h.id) });
    });
  };
  $("#collectSelected").onclick = () => submit(chosen(), "collect");
  function updateBastionOutput(text, forceFollow = false) {
    const output = $('#bastionOutput');
    const follow = forceFollow || output.scrollHeight - output.scrollTop - output.clientHeight < 48;
    output.textContent = text;
    if (follow) output.scrollTop = output.scrollHeight;
  }
  async function sessionAction(action, extra = {}) {
    const h = bastionHost(); if (!h || readonly || bastionBusy) return;
    bastionBusy = true; renderTargets();
    if (action === 'bastionSend') $('#bastionOutput').scrollTop = $('#bastionOutput').scrollHeight;
    try {
      const result = await api(action, { hostId: h.id, ...extra });
      if (bastionHostId === h.id) { bastionConnected = result.connected; updateBastionOutput(result.output, action === 'bastionSend'); }
    } catch (e) { message(String(e), true); }
    finally { bastionBusy = false; renderTargets(); }
  }
  $('#bastionConnect').onclick = () => sessionAction('bastionStart');
  $('#bastionQueryRun').onclick = () => { const h=bastionHost(); if(h && bastionConnected) submit([h], 'command', $('#bastionQuery').value); };
  $('#bastionAttach').onclick = () => sessionAction('bastionTerminal');
  $('#bastionDisconnect').onclick = async () => { if (await confirmAction('断开会话', '断开将终止共享会话及其中运行的程序，系统终端也会断开。', '确认断开')) sessionAction('bastionStop'); };
  $('#bastionInterrupt').onclick = () => sessionAction('bastionSend', { key: 'C-c' });
  $('#bastionEnter').onclick = () => sessionAction('bastionSend', { key: 'Enter' });
  $('#bastionSecret').onchange = () => { $('#bastionInput').type = $('#bastionSecret').checked ? 'password' : 'text'; };
  $('#bastionSend').onclick = () => { if (!bastionConnected || bastionBusy) return; const text = $('#bastionInput').value; $('#bastionInput').value = ''; sessionAction('bastionSend', { text }); };
  $('#bastionInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('#bastionSend').onclick(); } });
  if (!readonly) setInterval(async () => {
    const h = bastionHost(); if (!h || document.hidden || $('#commandPanel').hidden || (embedded && !true) || bastionBusy || bastionPolling) return;
    bastionPolling = true;
    try { const result = await api('bastionState', { hostId: h.id }); if (bastionHostId === h.id) { bastionConnected = result.connected; updateBastionOutput(result.output); renderTargets(); } }
    catch (e) { if (bastionHostId === h.id) $('#bastionState').textContent = String(e); }
    finally { bastionPolling = false; }
  }, 1500);
  document.addEventListener?.('pointerdown', e => {
    const settings = $('#ordinaryConnectionSettings');
    if (settings.open && !settings.contains(e.target)) settings.open = false;
  });
  $('#ordinaryConnectionSettings').onkeydown = e => {
    if (e.key === 'Escape') { e.preventDefault(); $('#ordinaryConnectionSettings').open = false; $('#ordinaryConnectionSettings').querySelector('summary').focus(); }
  };
  for (const id of ['connectionMode', 'connectionIdle']) $('#' + id).onchange = () => operate(async () => {
    await api('connectionSettings', { reuse: $('#connectionMode').value === 'reuse', idleSeconds: Number($('#connectionIdle').value) });
    message('连接配置已保存，对后续命令、采集和系统终端生效；已建立连接按原空闲时间退出。');
  });
  for (const selector of ["#monitor", "#interval"]) $(selector).onchange = () => operate(() => api("monitor", { enabled: $("#monitor").checked, interval: Number($("#interval").value) }));
  $("#template").onchange = e => { if (e.target.value !== "") {$("#command").value = templates()[Number(e.target.value)]?.command || '';sizeCommand();$('#command').focus?.();} };
  let templateDraft = [];
  function renderTemplateEditor() {
    $('#templateRows').innerHTML = templateDraft.map((t, i) => `<div class="template-row"><label>模板名称<input data-template-name="${i}" value="${esc(t.name)}" maxlength="100"></label><label>命令内容<textarea data-template-command="${i}" rows="2">${esc(t.command)}</textarea></label><button type="button" data-template-delete="${i}">删除</button></div>`).join('') || '<p>暂无模板，点击“新建模板”添加。</p>';
  }
  $('#manageTemplates').onclick = () => { templateDraft = structuredClone(templates()); renderTemplateEditor(); $('#templateError').textContent = ''; $('#templateEditor').showModal(); };
  $('#templateRows').oninput = e => {
    if (e.target.dataset.templateName !== undefined) templateDraft[Number(e.target.dataset.templateName)].name = e.target.value;
    if (e.target.dataset.templateCommand !== undefined) templateDraft[Number(e.target.dataset.templateCommand)].command = e.target.value;
  };
  $('#templateRows').onclick = e => { const i = e.target.dataset.templateDelete; if (i !== undefined) { templateDraft.splice(Number(i), 1); renderTemplateEditor(); } };
  $('#newTemplate').onclick = () => { if (templateDraft.length < 50) { templateDraft.push({ name: '', command: '' }); renderTemplateEditor(); } };
  $('#closeTemplates').onclick = () => $('#templateEditor').close();
  $('#saveTemplates').onclick = async () => {
    const draft = structuredClone(templateDraft);
    if (draft.some(t => !t.name.trim() || new TextEncoder().encode(t.name).length > 100 || !t.command.trim() || new TextEncoder().encode(t.command).length > 8192)) { $('#templateError').textContent = '请填写模板名称（最多 100 字节）和命令（最多 8192 字节）。'; return; }
    $('#saveTemplates').disabled = true;
    try { await api('templates', { templates: draft }); await refresh(); $('#templateEditor').close(); message('命令模板已保存。'); }
    catch (e) { $('#templateError').textContent = String(e); }
    finally { $('#saveTemplates').disabled = false; }
  };
  $("#runCommand").onclick = async () => {
    if (readonly || busy || commandRunning || !state.config.enabled || !state.config.installed) return;
    const hosts = chosen(); const command = $("#command").value;
    if (!hosts.length || hosts.length > 16 || !command.trim() || new TextEncoder().encode(command).length > 8192) { message("选择 1–16 台机器，并输入不超过 8192 字节的命令。", true); return; }
    commandRunning = true;
    if(inputHistory[inputHistory.length-1]!==command)inputHistory.push(command);
    if(inputHistory.length>100)inputHistory.shift();historyIndex=inputHistory.length;historyDraft='';
    $('#command').value='';sizeCommand();$('#command').focus?.();
    render();
    try { await batch(structuredClone(hosts), "command", command); }
    catch (e) { message(String(e), true); }
    finally {
      commandRunning = false;
      render();
      await refresh().catch(e => message(String(e), true));
    }
  };
  $("#jobs").onclick = async e => {
    const id = e.target.closest("[data-cancel]")?.dataset.cancel; if (!id) return;
    try { await api("cancel", { id }); message("已请求关闭本地 SSH；远端进程可能继续运行。"); } catch (err) { message(String(err), true); }
  };
  async function init() {
    try {
      await refresh();
      if (embedded) {
        document.body.classList.add("embedded");
      }
      if (readonly) {
        message("只读浏览器预览 · 安装、机器配置和 SSH 执行请使用 FlowHub 桌面版。此页面没有连接任何机器。");
      }
    } catch (e) { message(String(e), true); }
    // Poll only lightweight in-memory state. Never trigger SSH from a repaint.
    if (!readonly) setInterval(() => { if (!document.hidden && (!embedded || true)) refresh().catch(e => message(String(e), true)); }, 2000);
  }
  init();
})();
