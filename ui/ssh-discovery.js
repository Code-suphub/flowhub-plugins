(() => {
  const $ = s => document.querySelector(s), esc = window.FlowHubMachines.escape;
  let config = {}, api, refresh, eligible = false, scanning = false, scanned = false, discovered = [], selected = new Set(), activeAlias = '', revision = 0, lastMarkup = '';
  const status = text => { $('#discoveryStatus').textContent = text; };
  function render() {
    const managed = new Set((config.hosts || []).map(h => h.alias));
    selected = new Set([...selected].filter(a => !managed.has(a) && discovered.some(h => h.alias === a)));
    const query = $('#discoverySearch').value.trim().toLowerCase();
    const files = [...new Set(discovered.flatMap(h => h.sources.map(s => s.replace(/:\d+$/, ''))))].sort();
    const source = $('#discoverySource').value;
    const options = '<option value="">全部来源</option>' + files.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
    if ($('#discoverySource').innerHTML !== options) { $('#discoverySource').innerHTML = options; $('#discoverySource').value = files.includes(source) ? source : ''; }
    const visible = window.FlowHubMachines.visibleDiscovered(discovered, managed, query, 'unmanaged', $('#discoverySource').value);
    const managedCount = discovered.filter(h => managed.has(h.alias)).length;
    $('#discoveryCount').hidden = !scanned;
    $('#adoptSsh').hidden = !scanned;
    $('#discoverySearch').disabled = !scanned;
    $('#discoverySource').disabled = !scanned;
    $('#rescanSsh').textContent = scanning ? '正在扫描…' : scanned ? '重新扫描' : '扫描 SSH 配置';
    $('#discoveryCount').textContent = `显示 ${visible.length} 个 · 未纳管 ${discovered.length - managedCount} 个 · 已纳管 ${managedCount} 个${selected.size ? ` · 已选 ${selected.size} 个（保留其他筛选下的选择）` : ''}`;
    const emptyText = !scanned ? '按需扫描 SSH 配置，勾选需要管理的服务器。Git 等其他用途的条目可忽略。' : !discovered.length ? '尚未发现主机。仅发现明确的 Host 别名，通配规则不会转换为机器。' : managedCount === discovered.length ? '发现的主机已全部纳管，请在“机器”中查看和管理。' : '没有符合当前筛选条件的未纳管主机。';
    const markup = visible.map(h => `<div class="ssh-candidate"><input type="checkbox" data-alias="${esc(h.alias)}" aria-label="纳管 ${esc(h.alias)}" ${selected.has(h.alias) ? 'checked' : ''} ${managed.has(h.alias) || !eligible ? 'disabled' : ''}><div><button type="button" data-view="${esc(h.alias)}" aria-label="查看 ${esc(h.alias)} 配置">${esc(h.alias)}</button><small>${esc(h.sources.join('\n'))}</small></div><span>${managed.has(h.alias) ? '已纳管' : '未纳管'}</span></div>`).join('') || '<p class="caption">暂无匹配主机。仅发现明确的 Host 别名，通配规则不会转换为机器。</p>';
    const rows = visible.length ? markup : `<p class="caption">${emptyText}</p>`;
    if (rows !== lastMarkup) { $('#discoveryRows').innerHTML = rows; lastMarkup = rows; }
    if (activeAlias && !visible.some(h => h.alias === activeAlias)) { revision++; activeAlias = ''; $('#discoveryDetail').hidden = true; }
    $('#adoptSsh').disabled = !eligible || !selected.size;
    $('#adoptSsh').textContent = selected.size ? `加入管理（${selected.size}）` : '加入管理';
    $('#rescanSsh').disabled = !eligible || scanning;
  }
  async function scan() {
    if (!eligible || scanning) return;
    scanning = true; revision++; activeAlias = ''; $('#discoveryDetail').hidden = true; render(); status('正在读取本机 SSH 配置与 Include 文件…');
    try {
      const result = await api('discoverSsh'); discovered = result.hosts; scanned = true;
      status(`发现 ${discovered.length} 个 SSH 配置别名`);
      $('#discoveryMeta').hidden = false;
      $('#discoveryScanInfo').textContent = `已扫描 ${result.files} 个文件 · 更新于 ${new Date().toLocaleTimeString()}`;
      $('#discoveryRoot').textContent = result.root;
      $('#discoveryWarnings').textContent = result.warnings.join('\n');
    } catch (e) { status(`发现失败：${e}`); }
    finally { scanning = false; render(); }
  }
  $('#rescanSsh').onclick = scan;
  const help = $('#discoveryHelp'), helpButton = $('#discoveryHelpButton'), helpText = $('#discoveryHelpText');
  const showHelp = visible => { helpText.hidden = !visible; helpButton.setAttribute?.('aria-expanded', String(visible)); };
  help.onmouseenter = () => showHelp(true);
  help.onmouseleave = () => { if (document.activeElement !== helpButton) showHelp(false); };
  helpButton.onfocus = () => showHelp(true);
  helpButton.onblur = () => showHelp(false);
  helpButton.onclick = () => showHelp(true);
  document.addEventListener?.('pointerdown', e => { if (!help.contains(e.target)) showHelp(false); });
  helpButton.onkeydown = e => { if (e.key === 'Escape') { showHelp(false); e.preventDefault(); } };
  $('#discoverySearch').oninput = render;
  $('#discoverySource').onchange = render;
  $('#discoveryRows').onchange = e => { const alias = e.target.dataset.alias; if (alias) { e.target.checked ? selected.add(alias) : selected.delete(alias); render(); } };
  $('#discoveryRows').onclick = async e => {
    const button = e.target.closest('[data-view]'); if (!button || !eligible) return;
    activeAlias = button.dataset.view; const alias = activeAlias, request = ++revision;
    $('#discoveryDetail').hidden = false; $('#discoveryTarget').textContent = alias; $('#discoveryConfig').textContent = '正在读取实际生效配置…';
    $('#probeDiscovered').disabled = true; $('#discoveryProbeStatus').textContent = '';
    try {
      const result = await api('sshRead', { alias }); if (request !== revision) return;
      const p = result.effective;
      $('#discoveryConfig').textContent = `地址：${p.hostname}\n用户：${p.user}\n端口：${p.port}\n跳板机：${p.proxyJump || '无'}\n候选私钥：${result.inheritedKeys.join('、') || '无'}`;
      $('#probeDiscovered').disabled = false;
    } catch (e) { if (request === revision) $('#discoveryConfig').textContent = `读取失败：${e}`; }
  };
  $('#probeDiscovered').onclick = async () => {
    const alias = activeAlias, request = revision; if (!alias || !eligible) return;
    $('#probeDiscovered').disabled = true; $('#discoveryProbeStatus').textContent = '正在测试 SSH 连接和认证，最多 20 秒…';
    try { const result = await api('sshProbe', { alias }); if (revision === request) $('#discoveryProbeStatus').textContent = `${result.reason}（${result.durationMs} ms）${result.stderr ? '\n' + result.stderr : ''}`; }
    catch (e) { if (revision === request) $('#discoveryProbeStatus').textContent = String(e); }
    finally { if (revision === request) $('#probeDiscovered').disabled = false; }
  };
  $('#adoptSsh').onclick = async () => {
    if (!eligible || !selected.size) return;
    $('#adoptSsh').disabled = true;
    try {
      const latest = await api('state'); const hosts = [...latest.config.hosts]; let added = 0;
      for (const alias of selected) if (!hosts.some(h => h.alias === alias)) { hosts.push({ id: crypto.randomUUID(), alias, name: alias, group: 'SSH 配置' }); added++; }
      await api('hosts', { hosts }); selected.clear(); await refresh(); status(`已加入 ${added} 台机器。尚未连接或开启监控。`);
    } catch (e) { status(String(e)); } finally { render(); }
  };
  window.FlowHubSshDiscovery = { scan, update(next, call, reload) {
    config = next; api = call; refresh = reload;
    eligible = !!next.enabled && !!next.installed?.capabilities.includes('ssh:configure');
    render();
    if (!eligible) status('启用支持 SSH 配置的机器插件后可手动扫描。');
  } };
})();
