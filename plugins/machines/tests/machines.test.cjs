const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('React shell owns availability, escaped notices and embedded layout', () => {
  const ts = require('typescript');
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const source = fs.readFileSync(path.join(__dirname, '../src/fleet/MachineShell.tsx'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {}, window = {};
  window.parent = window;
  const location = { search: '' };
  vm.runInNewContext(code, { exports, window, location, URLSearchParams, require(name) {
    if (name === './MachineWorkspace') return { MachineWorkspace: ({ fleet }) => fleet };
    return require(name);
  } });
  const render = props => renderToStaticMarkup(React.createElement(exports.MachineShell, props));
  const base = { available: false, version: '未安装', notice: { text: '<script>test</script>', error: true }, fleet: React.createElement('div', null, 'fleet') };
  const disabled = render(base);
  assert.match(disabled, /<main hidden=""/);
  assert.match(disabled, /class="notice error"/);
  assert.match(disabled, /&lt;script&gt;test&lt;\/script&gt;/);
  assert.match(disabled, /role="status" aria-live="polite"/);
  const enabled = render({ ...base, available: true, version: 'vtest', notice: { text: '', error: false } });
  assert.match(enabled, /id="unavailable" class="empty" hidden=""/);
  assert(!enabled.includes('<main hidden'));
  assert.match(enabled, /id="version">vtest/);
  window.parent = {};
  location.search = '?embedded=1';
  assert.match(render(base), /class="machine-shell embedded"/);
  const html = fs.readFileSync(path.join(__dirname, '../ui/machines.html'), 'utf8');
  assert(!/<header|<main|id="notice"|id="version"/.test(html));
  const controller = fs.readFileSync(path.join(__dirname, '../src/fleet/FleetController.tsx'), 'utf8');
  assert(!/querySelector|createPortal|classList/.test(controller));
});

// Run the controller effect with deterministic hooks and bridge responses.
function controllerHarness(api) {
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(__dirname, '../src/fleet/FleetController.tsx'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const effects = [], states = [], listeners = new Map(), timers = new Map();
  let timerId = 0;
  const window = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const exports = {};
  vm.runInNewContext(code, {
    exports, window, document: { hidden: false, querySelector: () => null },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    require(name) {
      if (name === 'react') return {
        useEffect: fn => effects.push(fn), useRef: value => ({ current: value }),
        useState(value) { const i = states.length; states.push(value); return [value, next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; },
      };
      if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null };
      if (name === './MachineShell') return { MachineShell() {} };
      if (name === './FleetPage') return { FleetPage() {} };
      throw Error(name);
    },
  });
  exports.FleetController({ api, run: null });
  const cleanup = effects[0]();
  return { cleanup, states, listeners, timers };
}

test('controller coalesces refreshes and ignores responses after unmount', async () => {
  const pending = [];
  const h = controllerHarness(() => new Promise(resolve => pending.push(resolve)));
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick();
  assert.equal(pending.length, 1);
  h.listeners.get('flowhub:hosts-changed')();
  h.listeners.get('flowhub:hosts-changed')();
  assert.equal(pending.length, 1, 'no overlapping requests');
  const state = name => ({ config: { hosts: [{ id: name, alias: name, name }], enabled: true, installed: { version: 'test' }, interval: 60 }, metrics: {}, active: [], history: [] });
  pending[0](state('stale'));
  await tick();
  assert.equal(h.states[0].config.hosts.length, 0, 'stale response must not publish');
  assert.equal(pending.length, 2);
  pending[1](state('fresh'));
  await tick();
  assert.equal(h.states[0].config.hosts[0].id, 'fresh');
  assert.equal(h.timers.size, 1);
  h.listeners.get('flowhub:hosts-changed')();
  await tick();
  h.cleanup();
  assert.equal(h.listeners.size, 0);
  assert.equal(h.timers.size, 0);
  pending[2](state('unmounted'));
  await tick();
  assert.equal(h.states[0].config.hosts[0].id, 'fresh');
});

test('read-only controller never starts polling or enables machines', async () => {
  const h = controllerHarness(null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.states[0].config.enabled, false);
  assert.match(h.states[2].text, /只读浏览器预览/);
  assert.equal(h.timers.size, 0);
  h.cleanup();
});

test('host actions use common menu and React confirmation without legacy DOM', () => {
  const html = fs.readFileSync(path.join(__dirname, '../ui/machines.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../src/fleet/FleetController.tsx'), 'utf8');
  const fleet = fs.readFileSync(path.join(__dirname, '../src/fleet/FleetPage.tsx'), 'utf8');
  assert(!html.includes('id="hostMenu"'));
  assert(!/confirmAction|openHostMenu|closeHostMenu|createElement\("dialog"\)/.test(script));
  assert.match(fleet, /<DropdownMenu/);
  assert.match(fleet, /initialFocusRef=\{cancelRef\}/);
  assert.match(fleet, /onSelect: \(\) => setConfirming\(true\)/);
  assert.match(fleet, /onAction\('delete', host\)/);
  assert.match(script, /if \(!enabled\) return/);
  assert.match(script, /if \(action === 'terminal' && host.readOnly\) return/);
});

test('Netdata and traffic use only the React monitoring workspace', () => {
  const html = fs.readFileSync(path.join(__dirname, '../ui/machines.html'), 'utf8');
  for (const file of ['monitoring/netdata.js', 'monitoring/netdata.css', 'cloud/cloud-traffic.js', 'cloud/cloud-traffic.css']) {
    assert(!html.includes(file));
    assert(!fs.existsSync(path.join(__dirname, '../ui', file)), `${file} should be physically deleted`);
  }
  for (const file of ['fleet/main.tsx', 'host-editor/HostEditorController.tsx', 'host-editor/types.ts']) {
    const source = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
    assert(!/onOpenCloudTraffic|onOpenNetdata|FlowHubCloudTraffic|FlowHubNetdata/.test(source));
  }
  const editor = fs.readFileSync(path.join(__dirname, '../src/host-editor/HostEditor.tsx'), 'utf8');
  assert.match(editor, /saved && api\) return <MonitoringWorkspace/);
});

test('monitor settings are owned by React and the legacy script is removed', () => {
  const html = fs.readFileSync(path.join(__dirname, '../ui/machines.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '../src/monitoring/MonitorSettings.tsx'), 'utf8');
  assert.match(fs.readFileSync(path.join(__dirname, '../src/fleet/MachineShell.tsx'), 'utf8'), /id="monitorSettingsReactRoot"/);
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
  const script = fs.readFileSync(path.join(__dirname, '../src/fleet/FleetController.tsx'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../ui/machine-controls.css'), 'utf8');
  const workspace = fs.readFileSync(path.join(__dirname, '../src/collections/CollectionWorkspace.tsx'), 'utf8');
  assert.match(fs.readFileSync(path.join(__dirname, '../src/fleet/MachineShell.tsx'), 'utf8'), /id="collectionsReactRoot"/);
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
  const script = fs.readFileSync(path.join(__dirname, '../src/fleet/FleetController.tsx'), 'utf8');
  const entry = fs.readFileSync(path.join(__dirname, '../src/fleet/main.tsx'), 'utf8');
  assert.match(html, /id="machineAppRoot"/);
  assert.match(fs.readFileSync(path.join(__dirname, '../src/fleet/MachineWorkspace.tsx'), 'utf8'), /root: 'fleetReactRoot'/);
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
  const script = fs.readFileSync(path.join(__dirname, '../src/fleet/FleetController.tsx'), 'utf8');
  const controller = fs.readFileSync(path.join(__dirname, '../src/host-editor/HostEditorController.tsx'), 'utf8');

  assert.match(fs.readFileSync(path.join(__dirname, '../src/fleet/MachineShell.tsx'), 'utf8'), /id="hostEditorReactRoot"/);
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
  const script = fs.readFileSync(path.join(__dirname, '../src/fleet/FleetController.tsx'), 'utf8');
  const workspace = fs.readFileSync(path.join(__dirname, '../src/command/CommandWorkspace.tsx'), 'utf8');
  const shell = fs.readFileSync(path.join(__dirname, '../src/fleet/MachineWorkspace.tsx'), 'utf8');
  assert.match(shell, /root: 'commandReactRoot'/);
  assert.match(shell, /root: 'historyReactRoot'/);
  assert.match(shell, /forceMount/);
  assert(!fs.existsSync(path.join(__dirname, '../ui/machine-tabs.js')));
  assert(!html.includes('machine-tabs.js'));
  for (const legacyId of ['commandLegacy', 'historyLegacy', 'templateEditor', 'runCommand', 'consoleOutput', 'historyPageSize']) {
    assert(!html.includes(`id="${legacyId}"`), `${legacyId} should be physically removed`);
    assert(!script.includes(`#${legacyId}`), `${legacyId} should have no legacy listener`);
  }
  assert.match(workspace, /byteLength\(value\) > 8192/);
  assert.match(workspace, /disabled=\{running \|\| !selectedHosts\.length \|\| !command\.trim\(\)\}/);
  assert.match(workspace, /api\('templates', \{ templates: next \}\)/);
  assert.match(workspace, /run\(\{ hostId: job\.hostId, expectedAlias: job\.alias/);
});

test('fleet controller owns lifecycle and physically replaces the legacy orchestrator', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/fleet/FleetController.tsx'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../ui/machines.html'), 'utf8');
  assert(!fs.existsSync(path.join(__dirname, '../ui/machines.js')));
  assert(!html.includes('src="machines.js"'));
  assert.match(source, /if \(disposed \|\| !api\) return/);
  assert.match(source, /clearTimeout\(timer\)/);
  assert.match(source, /removeEventListener\('flowhub:hosts-changed'/);
  assert.match(source, /removeEventListener\('flowhub:command-selection'/);
  assert.match(source, /if \(pending\) continue/);
  assert.match(source, /只读浏览器预览/);
});
