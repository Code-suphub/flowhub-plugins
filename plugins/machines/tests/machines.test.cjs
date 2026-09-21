const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('monitor settings are owned by React and the legacy script is removed', () => {
  const html = fs.readFileSync(path.join(__dirname, '../ui/machines.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '../src/monitoring/MonitorSettings.tsx'), 'utf8');
  assert.match(html, /id="monitorSettingsReactRoot"/);
  assert(!html.includes('monitoring/monitoring.js'));
  assert(!fs.existsSync(path.join(__dirname, '../ui/monitoring/monitoring.js')));
  for (const action of ['state', 'monitorSettings', 'exporterTest', 'metricHistory']) assert(source.includes(`api('${action}'`));
  assert.match(source, /Number.isInteger\(retention\)/);
  assert.match(source, /alive.current = false/);
  assert.match(source, /pen = false; return null/);
  assert.match(source, /DialogShell/);
});

test('collection records use React/common without the old dialog or output renderer', () => {
  const html = fs.readFileSync(path.join(__dirname, '../ui/machines.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../ui/machines.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../ui/machine-controls.css'), 'utf8');
  const workspace = fs.readFileSync(path.join(__dirname, '../src/collections/CollectionWorkspace.tsx'), 'utf8');
  assert.match(html, /id="collectionsReactRoot"/);
  for (const id of ['collectionDialog', 'collectionRows', 'closeCollections']) {
    assert(!html.includes(`id="${id}"`));
    assert(!script.includes(`#${id}`));
  }
  assert(!script.includes('renderCollections'));
  assert(!css.includes('.collection-job'));
  assert.match(script, /FlowHubCollections\?\.update/);
  assert.match(script, /FlowHubCollections\?\.open\(host\)/);
  assert.match(workspace, /DialogShell/);
  assert.match(workspace, /if \(!expanded \|\| !job.finishedAt \|\| detail \|\| !api\) return/);
  assert.match(workspace, /disposed = true/);
  assert.match(workspace, /job.kind === 'collect' && job.hostId === host.id/);
  assert(!workspace.includes('dangerouslySetInnerHTML'));
});

test('fleet has one React renderer and no hidden legacy import or table', () => {
  const html = fs.readFileSync(path.join(__dirname, '../ui/machines.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../ui/machines.js'), 'utf8');
  const entry = fs.readFileSync(path.join(__dirname, '../src/fleet/main.tsx'), 'utf8');
  assert.match(html, /id="fleetReactRoot"/);
  for (const id of ['discoveryPanel', 'sshDiscovery', 'hostRows', 'totalCount', 'healthyCount', 'failedCount', 'activeCount']) {
    assert(!html.includes(`id="${id}"`), `${id} must not remain hidden in HTML`);
    assert(!script.includes(`#${id}`), `${id} must have no legacy renderer`);
  }
  assert(!script.includes('if (!reactFleet)'));
  assert(!entry.includes('legacy.remove()'));
  for (const file of ['machines-model.js', 'ssh/ssh-discovery.js']) {
    assert(!fs.existsSync(path.join(__dirname, '../ui', file)), `${file} must be deleted`);
    assert(!html.includes(file));
  }
});

test('React host editor owns machine and SSH persistence without a legacy form bridge', () => {
  const html = fs.readFileSync(path.join(__dirname, '../ui/machines.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../ui/machines.js'), 'utf8');
  const controller = fs.readFileSync(path.join(__dirname, '../src/host-editor/HostEditorController.tsx'), 'utf8');

  assert.match(html, /id="hostEditorReactRoot"/);
  for (const legacyId of ['hostDialog', 'hostForm', 'hostName', 'hostAlias', 'sshHostname', 'sshPassword', 'retrySshLoad']) {
    assert(!html.includes(`id="${legacyId}"`), `${legacyId} should be physically removed`);
    assert(!script.includes(`#${legacyId}`), `${legacyId} should have no legacy listener`);
  }
  assert.match(controller, /api\('sshRead', \{ alias \}\)/);
  assert.match(controller, /api\('sshSave', \{ profile:/);
  assert.match(controller, /await api\('hosts', \{ hosts:/);
  assert.match(controller, /Boolean\(value\.id && loadedAlias\.current !== value\.alias\.trim\(\)\)/);
  assert.match(controller, /loadVersion\.current/);
  assert.match(controller, /loadState\.status === 'error'/);
  assert.match(controller, /savedSsh \? 'SSH 配置已保存，但机器清单保存失败：'/);
});

test('standalone development adapter simulates execution and never calls a native bridge', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../dev/machines-preview.js'), 'utf8');
  const outcome = { value: 'success' };
  let tick;
  const window = { location: { reload() {} } }; window.parent = window;
  const context = { window, structuredClone, setTimeout(fn) { tick = fn; return 1; }, clearTimeout() {}, document: {
    createElement: () => ({ setAttribute() {}, querySelector: () => ({ append() {} }) }), body: { prepend() {} },
    querySelector: id => id === '#previewOutcome' ? outcome : {},
  } };
  vm.runInNewContext(source, context);
  const invoke = window.__TAURI__.core.invoke;
  const api = (action, payload) => invoke('machines_api', { action, payload });
  const state = await api('state'); state.config.hosts.length = 0;
  assert.equal((await api('state')).config.hosts.length, 2);
  for (const status of ['success', 'failed', 'timeout', 'cancelled']) {
    outcome.value = status;
    const run = invoke('machines_run', { id: status, hostId: 'demo-app', expectedAlias: 'demo-app', kind: 'command', command: 'arbitrary text' });
    assert.equal((await api('state')).active.length, 1);
    if (status === 'cancelled') await api('cancel', { id: status }); else tick();
    assert.equal((await run).status, status);
    assert.equal((await api('state')).active.length, 0);
  }
  assert.match((await api('job', { id: 'success' })).stdout, /模拟输出/);
  const page = await api('history', { page: 2, pageSize: 2 });
  assert.equal(page.total, 4); assert.equal(page.items.length, 2); assert.equal(page.page, 2);
  const filtered = await api('history', { status: 'failed', hostId: 'demo-app' });
  assert.equal(filtered.total, 1); assert.equal(filtered.items[0].status, 'failed');
  assert.equal((await api('discoverSsh')).hosts.length, 3);
  await assert.rejects(api('terminal'), /不打开终端/);
  await assert.rejects(api('chooseIdentity'), /不读取私钥/);
  await assert.rejects(invoke('unknown'), /不支持/);
  assert.throws(() => vm.runInNewContext(source, context), /不能覆盖原生宿主/);
});

test('React owns command execution, history and templates without legacy DOM adapters', () => {
  const html = fs.readFileSync(path.join(__dirname, '../ui/machines.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../ui/machines.js'), 'utf8');
  const workspace = fs.readFileSync(path.join(__dirname, '../src/command/CommandWorkspace.tsx'), 'utf8');
  assert.match(html, /id="commandReactRoot"/);
  assert.match(html, /id="historyReactRoot"/);
  for (const legacyId of ['commandLegacy', 'historyLegacy', 'templateEditor', 'runCommand', 'consoleOutput', 'historyPageSize']) {
    assert(!html.includes(`id="${legacyId}"`), `${legacyId} should be physically removed`);
    assert(!script.includes(`#${legacyId}`), `${legacyId} should have no legacy listener`);
  }
  assert.match(workspace, /byteLength\(value\) > 8192/);
  assert.match(workspace, /disabled=\{running \|\| !selectedHosts\.length \|\| !command\.trim\(\)\}/);
  assert.match(workspace, /api\('templates', \{ templates: next \}\)/);
  assert.match(workspace, /run\(\{ hostId: job\.hostId, expectedAlias: job\.alias/);
});

test('browser preview never invokes SSH or exposes enabled write controls', async () => {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      value: '', textContent: '', innerHTML: '', checked: false, hidden: false, disabled: false,
      options: [{ value: '60' }], classList: { toggle() {} }, add(option) { this.options.push(option); }, addEventListener() {},
    });
    return elements.get(selector);
  };
  let fleetProps;
  let intervals = 0;
  const context = vm.createContext({
    window: { FlowHubFleet: { update(props) { fleetProps = props; } } }, document: { body: { classList: { contains: () => false, add() {}, toggle() {} } }, querySelector: element, querySelectorAll: () => [] },
    Set, Date, String, Number, JSON, Promise, Option: function(text, value) { this.text = text; this.value = value; },
    setInterval() { intervals++; },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui/machines.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(element('#notice').textContent, /只读浏览器预览/);
  assert.equal(fleetProps.config.enabled, false);
  assert.equal(element('main').hidden, true); assert.equal(intervals, 0);
});
