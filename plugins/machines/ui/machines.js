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
  const reactFleet = window.FlowHubFleet;
  const reactHostEditor = window.FlowHubHostEditor;
  const reactCommand = window.FlowHubCommand;
  let state = { config: { hosts: [], enabled: false, installed: null, interval: 60 }, metrics: {}, active: [], history: [] };
  let selection = new Set();
  let busy = false;
  let lastHosts = "";
  let lastGroups = "";
  let refreshVersion = 0;
  let sshRevision = "";
  let sshLoadedAlias = "";
  let sshBaseline = '';
  let sshEditVersion = 0, sshEditStatus = 'ready';
  let hostEditorTab = 'basic';
  let hostEditorErrors = {};
  let hostEditorTestState = { status: 'idle', message: '尚未测试当前连接' };
  let hostAliasLoadTimer = 0;
  const jobDetails = new Map();
  let collectionHost = null;
  let lastCollections = '';
  let syncHostEditor = () => {};
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
    busy = true; syncHostEditor();
    try { await fn(); await refresh(); } catch (e) { message(String(e), true); }
    finally { busy = false; syncHostEditor(); }
  }
  function filtered() { return M.visibleHosts(state.config.hosts, $("#filter")?.value || "", $("#group")?.value || ""); }
  function chosen() { return M.targets(state.config.hosts, selection); }
  function render() {
    const c = state.config;
    selection = new Set([...selection].filter(id => c.hosts.some(h => h.id === id)));
    $("#version").textContent = c.installed ? `v${c.installed.version}${c.enabled ? "" : " · 已停用"}` : "未安装";
    $("main").hidden = !c.installed || !c.enabled;
    $("#unavailable").hidden = !!c.installed && c.enabled;
    for (const id of ["addHost", "collectSelected", "monitor", "interval"]) { const control=$("#" + id); if(control)control.disabled = readonly || !c.enabled; }
    for (const id of ["sshProbe", "chooseIdentity"]) $("#" + id).disabled = readonly || !c.enabled || !c.installed?.capabilities.includes("ssh:configure") || (id==='chooseIdentity' && $('#sshAuth').value==='password');
    if (!reactFleet) {
      $("#monitor").checked = !!c.monitoring;
      if (![...$("#interval").options].some(o => o.value === String(c.interval || 60))) $("#interval").add(new Option(`每 ${c.interval} 秒`, String(c.interval)));
      $("#interval").value = String(c.interval || 60);
    }
    if (!reactFleet) {
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
    }
    renderHosts(); renderCollections(); syncHostEditor();
    window.FlowHubSelects?.sync();
  }
  function renderHosts() {
    if (reactFleet) {
      reactFleet.update({
        snapshot: { hosts: state.config.hosts, metrics: state.metrics, activeJobs: state.active },
        config: { enabled: !readonly && !!state.config.enabled, monitoring: !!state.config.monitoring, intervalSeconds: state.config.interval || 60 },
        selectedHostIds: [...selection],
        now: Date.now(),
      });
      return;
    }
    const hosts = filtered(); const c = state.config;
    const hostMarkup = hosts.map(h => {
      const metric = state.metrics[h.id]; const status = M.metricStatus(metric, c.interval || 60);
      const values = status === "success" ? metric.values : null;
      const pct = k => values ? `${Number(values[k]).toFixed(1)}<small>%</small>` : "—";
      const disabled = readonly || !c.enabled ? "disabled" : "";
      return `<tr><td><input type="checkbox" data-select="${esc(h.id)}" ${selection.has(h.id) ? "checked" : ""} aria-label="选择 ${esc(h.name)}"></td><td><strong>${esc(h.name)}${h.readOnly ? ' · 仅查询' : ''}</strong><small>${esc(h.alias)}${h.group ? " / " + esc(h.group) : ""}</small></td><td><span class="status ${esc(status)}" title="${esc(metric?.error || "")}">${labels[status] || esc(status)}</span><small>${metric ? new Date(metric.at).toLocaleTimeString() : ""}</small></td><td>${pct("cpu")}</td><td>${pct("memory")}</td><td>${pct("disk")}</td><td>${values ? `${Number(values.load).toFixed(2)}<small>${Math.floor(values.uptime / 86400)} 天 ${Math.floor(values.uptime % 86400 / 3600)} 时</small>` : "—"}</td><td><div class="host-actions"><button data-host-action="collect" data-id="${esc(h.id)}" ${disabled}>采集</button><button data-host-action="edit" data-id="${esc(h.id)}" ${disabled}>编辑</button><button data-host-action="more" data-id="${esc(h.id)}" aria-haspopup="menu" aria-expanded="false">更多</button></div></td></tr>`;
    }).join("");
    if (hostMarkup !== lastHosts) { $("#hostRows").innerHTML = hostMarkup; lastHosts = hostMarkup; }
    $("#empty").hidden = hosts.length > 0;
    $("#empty h3").textContent = c.hosts.length ? "没有匹配的机器" : "从一台机器开始";
    $("#selectAll").checked = hosts.length > 0 && hosts.every(h => selection.has(h.id));
    $("#selectAll").indeterminate = hosts.some(h => selection.has(h.id)) && !$("#selectAll").checked;
  }
  function renderCollections() {
    if (!collectionHost) return;
    const jobs = [...state.active, ...state.history].filter(j => j.kind === 'collect' && j.hostId === collectionHost.id);
    const signature = JSON.stringify(jobs);
    if (signature === lastCollections) return; lastCollections = signature;
    $('#collectionTitle').textContent = `${collectionHost.name} · 采集记录`;
    $('#collectionRows').innerHTML = jobs.map(j => `<div class="collection-job ${j.status === 'failed' ? 'is-failed' : ''}"><details data-job="${esc(j.id)}"><summary><span class="status ${esc(j.status)}">${labels[j.status] || esc(j.status)}</span><span class="collection-time">${new Date(j.startedAt).toLocaleString()}</span><span class="collection-chevron" aria-hidden="true">⌄</span></summary>${j.finishedAt ? '<div class="collection-output" data-job-output><span class="collection-loading">展开以加载采集详情</span></div>' : '<p class="collection-running">正在采集…</p>'}</details></div>`).join('') || '<div class="collection-empty"><span>⌁</span><p>暂无该机器的采集记录。</p></div>';
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
      const unsupported = /仅支持 Linux|基础指标采集当前/i.test(j.stderr || '');
      if (unsupported) {
        output.innerHTML = `<div class="collection-explanation"><div class="explanation-icon">⌁</div><div><strong>这台机器暂不支持基础指标</strong><p>当前采集脚本依赖 Linux 内核指标，而目标机器返回了非 Linux 系统。SSH 连接本身正常，只有 CPU、内存、磁盘和负载采集失败。</p><div class="explanation-actions"><span>建议：在目标机配置 Node Exporter 后，前往监控设置填写 metrics 地址。</span></div></div></div><details class="raw-error"><summary>查看原始错误</summary><pre>${esc(j.stderr)}</pre></details>`;
      } else {
        output.textContent = `${j.command ? "[command]\n" + j.command + "\n\n" : ""}${j.stdout || "（无标准输出）"}${j.stderr ? "\n\n[stderr]\n" + j.stderr : ""}${j.truncated ? "\n\n[输出已截断]" : ""}`;
      }
    } catch (e) { output.textContent = String(e); }
  }
  async function batch(hosts, kind, command) {
    if (!hosts.length) throw new Error("请先选择机器");
    if (hosts.length > 16) throw new Error("每批最多 16 台机器，请缩小选择范围");
    message(`正在提交 ${hosts.length} 台机器的${kind === "collect" ? "采集" : "命令"}任务…`);
    const results = await Promise.allSettled(hosts.map(async h => {
      const id = crypto.randomUUID();
      try {
        return await invoke("machines_run", { hostId: h.id, expectedAlias: h.alias, id, kind, command: command || null });
      } catch (error) { throw error; }
    }));
    const rejected = results.filter(r => r.status === "rejected");
    const unsuccessful = results.filter(r => r.status === "fulfilled" && r.value.status !== "success");
    message(`任务结束：${results.length - rejected.length - unsuccessful.length} 成功，${unsuccessful.length} 未成功，${rejected.length} 未提交。${rejected.length ? " " + rejected.map(r => String(r.reason)).join("；") : ""}`, !!rejected.length || !!unsuccessful.length);
  }
  function submit(hosts, kind, command) {
    batch(hosts, kind, command).catch(e => message(String(e), true)).finally(() => refresh().catch(e => message(String(e), true)));
  }
  if (!reactFleet) {
    $("#filter").oninput = renderHosts; $("#group").onchange = renderHosts;
    $("#selectAll").onchange = e => { for (const h of filtered()) e.target.checked ? selection.add(h.id) : selection.delete(h.id); renderHosts(); };
    $("#hostRows").onchange = e => { if (e.target.dataset.select) { e.target.checked ? selection.add(e.target.dataset.select) : selection.delete(e.target.dataset.select); renderHosts(); } };
  }
  const hostTabs = [...document.querySelectorAll('[data-host-tab]')];
  function showHostTab(name, focus = false) {
    const target = hostTabs.find(tab => tab.dataset.hostTab === name) || hostTabs[0];
    if (!target) return;
    for (const tab of hostTabs) {
      const selected = tab === target;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls'))?.toggleAttribute('hidden', !selected);
    }
    if (focus) target.focus();
  }
  hostTabs.forEach((tab, index) => {
    tab.onclick = () => showHostTab(tab.dataset.hostTab);
    tab.onkeydown = event => {
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? hostTabs.length - 1 : event.key === 'ArrowRight' ? (index + 1) % hostTabs.length : event.key === 'ArrowLeft' ? (index + hostTabs.length - 1) % hostTabs.length : null;
      if (next === null) return;
      event.preventDefault(); showHostTab(hostTabs[next].dataset.hostTab, true);
    };
  });
  async function edit(host) {
    if(reactHostEditor)host.clearTimeout?.(hostAliasLoadTimer);
    hostEditorTab = 'basic'; hostEditorErrors = {}; hostEditorTestState = { status: 'idle', message: '尚未测试当前连接' };
    for(const id of ['hostAlias','sshHostname','sshUser','sshPort']){
      document.getElementById?.(id+'Error')?.remove();
      $('#'+id).removeAttribute?.('aria-invalid');$('#'+id).removeAttribute?.('aria-describedby');
    }
    $('#sshAuth').value='key'; $('#sshPassword').value=''; authForm(); showHostTab('basic');
    sshEditVersion++; sshEditStatus = 'ready';
    $("#saveHost").disabled = false; $("#retrySshLoad").hidden = true;
    sshRevision = ""; sshLoadedAlias = "";
    for (const id of ["sshHostname", "sshUser", "sshJump", "sshIdentity"]) $("#" + id).value = "";
    $("#sshPort").value = "22";
    $("#sshStatus").textContent = '可直接沿用本机 SSH 配置；修改下方连接信息后，点击底部保存一并写入。';
    $("#hostCountry").value = host?.countryCode || ""; const expiry=host?.expiresAt; $("#hostExpires").value=Number.isFinite(expiry)?new Date(expiry-new Date(expiry).getTimezoneOffset()*60000).toISOString().slice(0,16):"";
    if (document.body.classList.contains('widget-settings') || reactHostEditor) $('#hostDialog').setAttribute('open', ''); else if (!$('#hostDialog').open) $('#hostDialog').showModal(); $('#hostDialogTitle').textContent = host ? '编辑机器' : '添加机器'; $("#hostId").value = host?.id || ""; $("#hostName").value = host?.name || ""; $("#hostAlias").value = host?.alias || ""; $("#hostGroup").value = host?.group || ""; if (!reactHostEditor) $("#hostName").focus();
    const savedHostId = host?.id || "";
    $("#hostCloudTraffic").disabled = !savedHostId; $("#hostNetdata").disabled = !savedHostId;
    $("#hostMonitorNote").textContent = savedHostId ? "云流量按机器保存凭证；Netdata 接入后可读远端历史。" : "先保存机器，再配置云流量与 Netdata。";
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
    syncHostEditor();
    if (host && !host.bastion) await loadSshForEdit();
  }
  function connectionForm() {
    const bastion = $('#hostConnectionType').value === 'bastion';
    $('#bastionFields').hidden = !bastion; $('#directSshFields').hidden = bastion;
    $('#bastionFields').disabled = !bastion; $('#directSshFields').disabled = bastion;
    $('#relayScript').required = bastion;
    window.FlowHubSelects?.sync();
    syncHostEditor();
  }
  $('#hostConnectionType').onchange = () => {
    sshEditVersion++; sshEditStatus = 'ready'; $('#saveHost').disabled = false; $('#retrySshLoad').hidden = true;
    connectionForm();
    if ($('#hostConnectionType').value === 'ssh' && $('#hostId').value) loadSshForEdit();
  };
  async function loadSshForEdit() {
    const version = ++sshEditVersion, alias = $('#hostAlias').value.trim();
    sshEditStatus = 'loading'; $('#saveHost').disabled = true; $('#directSshFields').disabled = true;
    $('#retrySshLoad').hidden = true; $('#sshStatus').textContent = '正在加载这台机器的 SSH 配置…'; syncHostEditor();
    try {
      const result = await api('sshRead', { alias });
      if (version !== sshEditVersion || !$('#hostDialog').open) return;
      const p = result.profile;
      $('#sshHostname').value = p.hostname; $('#sshUser').value = p.user; $('#sshPort').value = p.port;
      $('#sshJump').value = p.proxyJump; $('#sshIdentity').value = p.identityFile;
      $('#sshAuth').value=result.passwordAuth?'password':'key'; $('#sshPassword').value=''; authForm();
      sshRevision = result.revision; sshLoadedAlias = alias; sshBaseline = sshSignature();
      sshEditStatus = 'ready'; $('#sshStatus').textContent = '已加载连接配置。未修改的字段继续沿用现有 SSH 配置。'; syncHostEditor();
    } catch (error) {
      if (version !== sshEditVersion || !$('#hostDialog').open) return;
      sshEditStatus = 'error'; $('#sshStatus').textContent = `配置加载失败：${error}。请重试后保存。`;
      $('#retrySshLoad').hidden = false; syncHostEditor();
    } finally {
      if (version === sshEditVersion) {
        $('#saveHost').disabled = sshEditStatus !== 'ready';
        $('#directSshFields').disabled = sshEditStatus !== 'ready';
        syncHostEditor();
      }
    }
  }
  $('#retrySshLoad').onclick = loadSshForEdit;
  $('#hostAlias').oninput = () => {
    if (!$('#hostId').value || $('#hostConnectionType').value !== 'ssh') return;
    sshEditVersion++; sshEditStatus = 'loading'; $('#saveHost').disabled = true; $('#directSshFields').disabled = true;
    $('#sshStatus').textContent = '输入完成后自动加载该别名的配置。'; syncHostEditor();
  };
  $('#hostAlias').onchange = () => {
    if ($('#hostId').value && $('#hostConnectionType').value === 'ssh') loadSshForEdit();
  };
  if (!reactFleet) $("#addHost").onclick = () => edit(null);
  $('#groupChoice').onchange = () => {
    const value = $('#groupChoice').value;
    $('#hostGroup').hidden = value !== '__new';
    $('#hostGroup').value = value === '__new' ? '' : value;
    if (value === '__new' && !reactHostEditor) $('#hostGroup').focus();
    syncHostEditor();
  };
  $("#cancelHost").onclick = () => { if(reactHostEditor)host.clearTimeout?.(hostAliasLoadTimer); sshEditVersion++; $('#sshPassword').value=''; $('#hostDialog').close(); syncHostEditor(); };
  $("#closeHost").onclick = $("#cancelHost").onclick;
  $('#hostDialog').addEventListener('cancel', () => { sshEditVersion++; $('#sshPassword').value=''; syncHostEditor(); });
  $('#hostDialog').addEventListener('close', () => { $('#hostForm').inert = false; syncHostEditor(); });
  $("#hostCloudTraffic").onclick = () => { const id = $("#hostId").value; if (id) window.FlowHubCloudTraffic?.open(id, $("#hostName").value.trim() || id); };
  $("#hostNetdata").onclick = () => { const id = $("#hostId").value; if (id) window.FlowHubNetdata?.open(id, $("#hostName").value.trim() || id); };
  function sshDraft() {
    return { alias: $("#hostAlias").value.trim(), hostname: $("#sshHostname").value.trim(), user: $("#sshUser").value.trim(), port: Number($("#sshPort").value), identityFile: $("#sshIdentity").value.trim(), proxyJump: $("#sshJump").value.trim() };
  }
  $('#sshUser').setAttribute?.('placeholder','必填，例如 root 或 ubuntu');
  for(const id of ['hostAlias','sshHostname','sshUser','sshPort']){
    $('#'+id).addEventListener('input',()=>{
      const editorField={hostAlias:'alias',sshHostname:'sshHostname',sshUser:'sshUser',sshPort:'sshPort'}[id];
      if(editorField){const next={...hostEditorErrors};delete next[editorField];hostEditorErrors=next;}
      $('#'+id).setCustomValidity?.('');$('#'+id).removeAttribute?.('aria-invalid');
      document.getElementById?.(id+'Error')?.remove();
      syncHostEditor();
    });
  }
  function validateProfile(profile){
    const error=M.profileError(profile);if(!error)return;
    const [id,text]=error,input=$('#'+id);
    const editorField={hostAlias:'alias',sshHostname:'sshHostname',sshUser:'sshUser',sshPort:'sshPort'}[id];
    if(editorField)hostEditorErrors={...hostEditorErrors,[editorField]:text};
    document.getElementById?.(id+'Error')?.remove();
    input.insertAdjacentHTML?.('afterend',`<small class="field-error" id="${id}Error" role="alert">${esc(text)}</small>`);
    input.setAttribute?.('aria-invalid','true');input.setAttribute?.('aria-describedby',id+'Error');
    input.focus();$('#sshStatus').textContent=text;syncHostEditor();throw new Error(text);
  }
  function sshSignature(profile = sshDraft()) { return JSON.stringify({ ...profile, alias: '',passwordAuth:$('#sshAuth').value==='password' }); }
  function hostEditorValue(){return{
    id:$('#hostId').value,
    connectionType:$('#hostConnectionType').value,
    name:$('#hostName').value,
    alias:$('#hostAlias').value,
    groupChoice:$('#groupChoice').value,
    group:$('#hostGroup').value,
    countryCode:$('#hostCountry').value,
    expiresLocal:$('#hostExpires').value,
    readOnly:$('#hostReadOnly').checked,
    sshAuth:$('#sshAuth').value,
    sshPassword:$('#sshPassword').value,
    sshHostname:$('#sshHostname').value,
    sshUser:$('#sshUser').value,
    sshPort:$('#sshPort').value,
    sshJump:$('#sshJump').value,
    sshIdentity:$('#sshIdentity').value,
    relayScript:$('#relayScript').value,
    relayCommand:$('#relayCommand').value,
  };}
  syncHostEditor=()=>{
    if(!reactHostEditor)return;
    const value=hostEditorValue();
    const regions=(window.FlowHubMachineRegions||[]).map(region=>({value:region.code,label:region.label}));
    const loadStatus=sshEditStatus==='loading'?'loading':sshEditStatus==='error'?'error':value.id&&value.connectionType==='ssh'?'success':'idle';
    reactHostEditor.update({
      open:$('#hostDialog').open,
      value,
      activeTab:hostEditorTab,
      groups:[...new Set(state.config.hosts.map(item=>item.group).filter(Boolean))],
      countryOptions:[{value:'',label:'不设置'},...regions],
      errors:hostEditorErrors,
      loadState:{status:loadStatus,message:$('#sshStatus').textContent},
      testState:hostEditorTestState,
      saving:busy,
      saved:!!value.id,
      monitoringApi:api,
      title:value.id?'编辑机器':'添加机器',
      description:value.id?`${value.name||value.alias} · ${value.alias}`:'添加身份信息后，再配置连接与监控。',
    });
  };
  function authForm(){const password=$('#sshAuth').value==='password';$('#sshPasswordField').hidden=!password;$('#directSshFields .ssh-key').hidden=password;$('#sshIdentity').disabled=password;$('#chooseIdentity').disabled=password;window.FlowHubSelects?.sync();syncHostEditor();}
  $('#sshAuth').onchange=authForm;
  for (const action of ["sshProbe", "chooseIdentity"]) $("#" + action).onclick = () => operate(async () => {
    try {
      const alias = $("#hostAlias").value.trim();
      if (action === "chooseIdentity") {
        const result = await api(action); if (!result.canceled) $("#sshIdentity").value = result.path; syncHostEditor(); return;
      }
      const profile = sshDraft();
      if(sshSignature(profile)!==sshBaseline)validateProfile(profile);
      if ($('#sshPassword').value || sshSignature(profile)!==sshBaseline && $('#sshAuth').value==='password') throw new Error('请先保存密码和连接配置，再测试连接。');
      {
        hostEditorTestState={status:'loading',message:'正在执行 SSH 握手与认证…'};syncHostEditor();
        $("#sshStatus").textContent = "正在测试当前表单：SSH 握手、认证与执行，最多等待 20 秒…";
        const result = await api(action, sshSignature(profile) === sshBaseline ? { alias } : { alias, profile });
        $("#sshStatus").textContent = `${JSON.stringify(profile) !== JSON.stringify(sshDraft()) ? "表单已修改；以下结果属于修改前的配置，请重新测试。\n" : ""}${result.reason}（${result.durationMs} ms）${result.stderr ? "\n" + result.stderr : ""}`;
        hostEditorTestState={status:'success',message:`${result.reason}（${result.durationMs} ms）`};syncHostEditor();
      }
    } catch (e) { $("#sshStatus").textContent = errorText(e); hostEditorTestState={status:'error',message:errorText(e)};syncHostEditor();throw e; }
  });
  $("#hostForm").onsubmit = e => { e.preventDefault(); operate(async () => {
    const h = { id: $("#hostId").value || crypto.randomUUID(), name: $("#hostName").value.trim(), alias: $("#hostAlias").value.trim(), group: $("#hostGroup").value.trim() };
    h.bastion = $('#hostConnectionType').value === 'bastion' ? { script: $('#relayScript').value.trim(), target: h.alias, command: $('#relayCommand').value } : null;
    h.readOnly = $('#hostReadOnly').checked;
    h.countryCode = $('#hostCountry').value; h.expiresAt = $('#hostExpires').value ? new Date($('#hostExpires').value).getTime() : null;
    if (h.expiresAt !== null && !Number.isFinite(h.expiresAt)) throw Error('到期时间无效');
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
      await api("hosts", { hosts }); $('#sshPassword').value=''; $("#hostDialog").close(); syncHostEditor(); if(window.machineSettingsReady)await edit(h); message(h.bastion ? '堡垒机配置已保存到插件。' : savedSsh ? '机器连接配置已保存到插件。' : '机器已保存。');
    } catch (error) { throw new Error(`${savedSsh ? 'SSH 配置已写入，但机器清单保存失败，请重试。' : ''}${error}`); }
    finally { $('#hostForm').inert = false; syncHostEditor(); }
  }); };
  if(reactHostEditor)window.addEventListener('flowhub:host-editor-action',event=>{
    const detail=event.detail||{};
    if(detail.type==='tab'){hostEditorTab=detail.tab||'basic';syncHostEditor();return;}
    if(detail.type==='close'){$('#cancelHost').click();return;}
    if(detail.type==='retry-ssh'){$('#retrySshLoad').click();return;}
    if(detail.type==='probe-ssh'){$('#sshProbe').click();return;}
    if(detail.type==='choose-identity'){$('#chooseIdentity').click();return;}
    if(detail.type==='open-cloud-traffic'){$('#hostCloudTraffic').click();return;}
    if(detail.type==='open-netdata'){$('#hostNetdata').click();return;}
    if(detail.type==='save'){
      const value=hostEditorValue(),errors={};
      if(!value.name.trim())errors.name='请输入显示名称';
      if(!M.validAlias(value.alias.trim()))errors.alias='SSH 别名只能包含字母、数字、点、下划线、冒号和连字符，不能以连字符开头';
      if(value.connectionType==='bastion'&&!value.relayScript.trim())errors.relayScript='请输入本地 relay 脚本路径';
      if(value.expiresLocal&&!Number.isFinite(new Date(value.expiresLocal).getTime()))errors.expiresLocal='到期时间无效';
      hostEditorErrors=errors;
      if(Object.keys(errors).length){hostEditorTab=errors.relayScript?'connection':'basic';syncHostEditor();return;}
      $('#hostForm').dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:$('#saveHost')}));
      return;
    }
    if(detail.type!=='change')return;
    if(hostEditorErrors[detail.field]){const next={...hostEditorErrors};delete next[detail.field];hostEditorErrors=next;}
    const ids={connectionType:'hostConnectionType',name:'hostName',alias:'hostAlias',groupChoice:'groupChoice',group:'hostGroup',countryCode:'hostCountry',expiresLocal:'hostExpires',readOnly:'hostReadOnly',sshAuth:'sshAuth',sshPassword:'sshPassword',sshHostname:'sshHostname',sshUser:'sshUser',sshPort:'sshPort',sshJump:'sshJump',sshIdentity:'sshIdentity',relayScript:'relayScript',relayCommand:'relayCommand'};
    const control=$('#'+ids[detail.field]);if(!control)return;
    if(detail.field==='readOnly')control.checked=!!detail.value;else control.value=String(detail.value??'');
    control.dispatchEvent(new Event('input',{bubbles:true}));
    if(['connectionType','groupChoice','sshAuth'].includes(detail.field))control.onchange?.();
    if(detail.field==='alias'&&$('#hostId').value&&$('#hostConnectionType').value==='ssh'){
      host.clearTimeout?.(hostAliasLoadTimer);hostAliasLoadTimer=host.setTimeout?.(()=>control.onchange?.(),400)||0;
    }
    syncHostEditor();
  });
  function runHostAction(h, action) {
    if (action === "collections") { collectionHost = h; lastCollections = ""; renderCollections(); $("#collectionDialog").showModal(); return; }
    if (action === "edit") { edit(h); return; }
    if (action === "copy") {
      operate(async () => {
        await edit(h);
        if (!h.bastion && sshEditStatus !== 'ready') throw Error('原配置加载失败，请重试后复制');
        $('#hostId').value = ''; $('#hostName').value = h.name + ' 副本'; $('#hostAlias').value = '';
        sshRevision = ''; sshLoadedAlias = ''; sshBaseline = ''; $('#sshPassword').value = '';
        syncHostEditor(); if(!reactHostEditor)$('#hostAlias').focus();
        message('已复制到新增表单，请填写新的目标机器。已保存密码不会复制。');
      }); return;
    }
    if (action === "command") { selection = new Set([h.id]); renderHosts(); reactCommand?.setTargets([h.id]); window.FlowHubMachineTabs?.show('command', true); return; }
    operate(async () => {
      if (action === "collect") submit([h], "collect");
      if (action === "terminal") await api(h.bastion ? 'bastionTerminal' : "terminal", { hostId: h.id });
      if (action === "delete" && await confirmAction('移除机器', `确定从清单移除“${h.name}”？不会删除远端数据。`, '确认移除')) await api("hosts", { hosts: state.config.hosts.filter(x => x.id !== h.id) });
    });
  }
  const hostMenu = $("#hostMenu");
  function closeHostMenu() {
    if (hostMenu.hidden) return;
    hostMenu.hidden = true; hostMenu.replaceChildren(); delete hostMenu.dataset.id;
    document.querySelectorAll('[data-host-action="more"]').forEach(b => b.setAttribute("aria-expanded", "false"));
  }
  function openHostMenu(button, h) {
    const canOperate = !readonly && state.config.enabled;
    const items = [
      { action: "collections", label: "采集记录" },
      { action: "command", label: "命令", disabled: !canOperate },
      { action: "terminal", label: "系统终端", disabled: !canOperate || h.readOnly },
      { action: "copy", label: "复制", disabled: !canOperate },
      { action: "delete", label: "移除机器", disabled: !canOperate },
    ];
    hostMenu.replaceChildren(...items.map(item => {
      const el = document.createElement("button");
      el.type = "button"; el.setAttribute("role", "menuitem");
      el.dataset.hostAction = item.action; el.dataset.id = h.id;
      el.textContent = item.label; el.disabled = !!item.disabled;
      return el;
    }));
    hostMenu.dataset.id = h.id; hostMenu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    const rect = button.getBoundingClientRect(); const box = hostMenu.getBoundingClientRect();
    const flip = rect.bottom + box.height + 8 > innerHeight;
    hostMenu.style.left = Math.max(8, Math.min(innerWidth - box.width - 8, rect.right - box.width)) + "px";
    hostMenu.style.top = Math.max(8, Math.min(innerHeight - box.height - 8, flip ? rect.top - box.height - 6 : rect.bottom + 6)) + "px";
    hostMenu.querySelector("button:not(:disabled)")?.focus();
  }
  function handleHostAction(action, id, anchor) {
    const h = state.config.hosts.find(x => x.id === id); if (!h) return;
    if (action === "more") {
      const button = anchor || [...document.querySelectorAll('[data-host-action="more"]')].find(el => el.dataset.id === id && el.getClientRects().length);
      if (button) hostMenu.hidden ? openHostMenu(button, h) : closeHostMenu();
      return;
    }
    runHostAction(h, action);
  }
  if (!reactFleet) $("#hostRows").onclick = e => {
    const button = e.target.closest("[data-host-action]"); if (!button) return;
    handleHostAction(button.dataset.hostAction, button.dataset.id, button);
  };
  else window.addEventListener("flowhub:fleet-action", e => {
    const detail = e.detail || {};
    if (detail.type === "selection") {
      selection = new Set((detail.hostIds || []).filter(id => state.config.hosts.some(h => h.id === id)));
      reactCommand?.setTargets([...selection]);
      renderHosts();
    } else if (detail.type === "add") edit(null);
    else if (detail.type === "collect-selected") {
      const ids = new Set(detail.hostIds || []);
      submit(state.config.hosts.filter(h => ids.has(h.id)), "collect");
    } else if (detail.type === "collect-host") {
      const h = state.config.hosts.find(x => x.id === detail.hostId); if (h) submit([h], "collect");
    } else if (detail.type === "host-action") handleHostAction(detail.action, detail.hostId);
    else if (detail.type === "monitor") operate(() => api("monitor", { enabled: !!detail.enabled, interval: Number(detail.intervalSeconds) || 60 }));
  });
  if (reactCommand) window.addEventListener('flowhub:command-selection', event => {
    selection = new Set((event.detail?.hostIds || []).filter(id => state.config.hosts.some(h => h.id === id)));
    renderHosts();
  });
  hostMenu.onclick = e => {
    const item = e.target.closest("[data-host-action]"); if (!item) return;
    const h = state.config.hosts.find(x => x.id === hostMenu.dataset.id); closeHostMenu();
    if (h) runHostAction(h, item.dataset.hostAction);
  };
  document.addEventListener?.("click", e => { if (!hostMenu.hidden && !e.target.closest("#hostMenu") && !e.target.closest('[data-host-action="more"]')) closeHostMenu(); });
  document.addEventListener?.("keydown", e => { if (e.key === "Escape") closeHostMenu(); });
  window.addEventListener?.("resize", closeHostMenu);
  window.addEventListener?.("scroll", closeHostMenu, true);
  if (!reactFleet) $("#collectSelected").onclick = () => submit(chosen(), "collect");
  if (!reactFleet) for (const selector of ["#monitor", "#interval"]) $(selector).onchange = () => operate(() => api("monitor", { enabled: $("#monitor").checked, interval: Number($("#interval").value) }));
  async function init() {
    try {
      if(window.machineSettingsReady)await window.machineSettingsReady;
      await refresh();
      if(window.machineSettingsReady){const id=window.machineSettingsContext?.config?.row||new URLSearchParams(location.search).get('row');const selected=state.config.hosts.find(h=>h.id===id)||(window.parent===window?state.config.hosts[0]:null);if(!selected)throw Error('目标机器已移除');await edit(selected);}
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
