const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const M = require('../ui/machines-model.js');

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

test('instance and SSH discovery filters compose without conflating aliases', () => {
  const jobs = [{ id: '1', hostId: 'old', alias: 'same', status: 'success', kind: 'collect' }, { id: '2', hostId: 'new', alias: 'same', status: 'failed', kind: 'command' }];
  assert.deepEqual(M.visibleJobs(jobs, 'old', 'success', 'collect').map(j => j.id), ['1']);
  assert.equal(M.visibleJobs(jobs, 'old', 'failed', '').length, 0);
  assert.deepEqual(M.visibleJobs(jobs, '', '', 'command').map(j => j.id), ['2']);
  const hosts = [{ alias: 'a', sources: ['/config:1', '/included:2'] }, { alias: 'b', sources: ['/included:8'] }];
  const managed = new Set(['a']);
  assert.deepEqual(M.visibleDiscovered(hosts, managed, '', 'managed', '/included').map(h => h.alias), ['a']);
  assert.deepEqual(M.visibleDiscovered(hosts, managed, 'B', 'unmanaged', '/included').map(h => h.alias), ['b']);
  assert.equal(M.visibleDiscovered(hosts, managed, '', 'unmanaged', '/config').length, 0);
});

test('host filtering and batch targets preserve stable IDs across filters', () => {
  const hosts = [{ id: 'a', alias: 'prod-1', name: '应用', group: '生产' }, { id: 'b', alias: 'dev-1', name: '应用', group: '开发' }];
  assert.deepEqual(M.visibleHosts(hosts, 'PROD', ''), [hosts[0]]);
  assert.deepEqual(M.visibleHosts(hosts, '应用', '开发'), [hosts[1]]);
  assert.deepEqual(M.targets(hosts, new Set(['a', 'deleted'])), [hosts[0]]);
});
test('old metrics cannot appear as freshly healthy and remote text is escaped', () => {
  assert.equal(M.metricStatus({ status: 'success', at: 1 }, 60, 200000), 'stale');
  assert.equal(M.metricStatus({ status: 'failed', at: 190000 }, 60, 200000), 'failed');
  assert.equal(M.metricStatus(null, 60), 'unknown');
  assert.equal(M.escape('<script>&"'), '&lt;script&gt;&amp;&quot;');
  for (const value of ['-oProxyCommand=bad', 'a;ls', 'a\nb', '$(id)']) assert.equal(M.validAlias(value), false);
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
  const writes = ['#sourceUrl', '#sourceKey', '#checkUpdate', '#installPending'].map(element);
  let intervals = 0;
  const context = vm.createContext({
    window: { FlowHubMachines: M }, document: { body: { classList: { contains: () => false, add() {}, toggle() {} } }, querySelector: element, querySelectorAll: selector => selector.includes('#sourceForm') ? writes : [] },
    Set, Date, String, Number, JSON, Promise, Option: function(text, value) { this.text = text; this.value = value; },
    setInterval() { intervals++; },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui/machines.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(element('#notice').textContent, /只读浏览器预览/);
  for (const id of ['addHost', 'collectSelected', 'monitor']) assert.equal(element('#' + id).disabled, true);
  assert.equal(element('main').hidden, true); assert.equal(intervals, 0);
});
test('SSH import scans, connects and adopts only on explicit user actions', async () => {
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '', hidden: false, disabled: false }); return elements.get(id); };
  const calls = [];
  const config = { enabled: true, installed: { capabilities: ['ssh:configure'] }, hosts: [{ id: 'a', alias: 'existing', name: 'existing', group: '' }] };
  const api = async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'discoverSsh') return { hosts: [{ alias: 'existing', sources: ['/tmp/config:1'] }, { alias: 'new', sources: ['/tmp/included.conf:2'] }], files: 2, root: '/tmp/config', warnings: [] };
    if (action === 'sshRead') return { effective: { hostname: 'test.example', user: 'tester', port: '22', proxyJump: 'none' }, inheritedKeys: ['~/.ssh/test'] };
    if (action === 'sshProbe') return { reason: '测试通过', durationMs: 5 };
    if (action === 'state') return { config };
    if (action === 'hosts') config.hosts = payload.hosts;
  };
  const window = { FlowHubMachines: M };
  const context = vm.createContext({ window, document: { body: { classList: { contains: () => false, add() {}, toggle() {} } }, querySelector: element }, crypto: { randomUUID: () => 'new-id' } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui/ssh/ssh-discovery.js'), 'utf8'), context);
  const update = () => window.FlowHubSshDiscovery.update(config, api, update);
  update(); await new Promise(resolve => setImmediate(resolve)); update();
  assert.deepEqual(calls, []);
  await element('#rescanSsh').onclick();
  assert.deepEqual(calls.map(c => c.action), ['discoverSsh']);
  assert(!element('#discoveryRows').innerHTML.includes('data-view="existing"'));
  assert.match(element('#discoveryRows').innerHTML, /included.conf:2/);
  await element('#discoveryRows').onclick({ target: { closest: () => ({ dataset: { view: 'new' } }) } });
  assert.match(element('#discoveryConfig').textContent, /test.example/);
  assert(!calls.some(c => c.action === 'sshProbe'));
  await element('#probeDiscovered').onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(c => c.action === 'sshProbe').payload)), { alias: 'new' });
  element('#discoveryRows').onchange({ target: { dataset: { alias: 'new' }, checked: true } });
  await element('#adoptSsh').onclick();
  assert.equal(config.hosts.length, 2);
  assert.equal(config.hosts[1].alias, 'new');
  assert(!element('#discoveryRows').innerHTML.includes('data-view="new"'));
  assert.match(element('#discoveryRows').innerHTML, /全部纳管/);
  assert.equal(calls.filter(c => c.action === 'discoverSsh').length, 1);
});
