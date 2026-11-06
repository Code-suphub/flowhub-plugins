const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(name, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src', name + '.ts'), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {exports, ...globals, Promise, Map, Set, Date, Math, Error, setTimeout, clearTimeout});
  return exports;
}

const model = load('model');

test('untagged images use their real digest or ID rather than a placeholder tag', () => {
  const id='sha256:'+'a'.repeat(64),digest='sha256:'+'b'.repeat(64);
  const image={ID:id,Repository:'nginx',Tag:'<none>',Digest:digest};
  assert.equal(model.imageReference(image),'nginx@'+digest);
  assert.equal(model.imageLabel(image),'nginx（无标签）');
  assert.equal(model.imageReference({...image,Digest:'<none>'}),id);
  assert.equal(model.imageReference({...image,Repository:'<none>'}),id);
  assert.equal(model.imageReference({...image,Tag:'latest'}),'nginx:latest');
});

test('missing and epoch image creation dates show an explicit placeholder', () => {
  for (const value of [undefined, null, '', 'not-a-date', '1970-01-01T00:00:00Z', '0001-01-01T00:00:00Z']) {
    assert.equal(model.formatDate(value, '未提供创建时间'), '未提供创建时间');
  }
  assert.notEqual(model.formatDate('2026-10-27T00:00:00Z', '未提供创建时间'), '未提供创建时间');
  assert.equal(model.formatDate(undefined), '尚未启动');
});


test('resource counts live beside scope tabs instead of in summary cards', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
  assert.doesNotMatch(source, /StatStrip|StatItem/);
  assert.match(source, /docker-scope-nav__count/);
  assert.match(source, /compose: new Set\(data\.containers\.map\(\(row\) => row\.project\)\.filter\(Boolean\)\)\.size/);
  assert.match(source, /standalone: data\.containers\.filter\(\(row\) => !row\.project\)\.length/);
  assert.match(source, /images: images\?\.length \?\? null/);
  assert.match(source, /imagesContextRef\.current !== next\.context/);
});


test('settings typography is scoped and appearance card keeps its natural height', () => {
  const styles = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8');
  assert.match(styles, /\.docker-settings-form \{[^}]*align-items:start/);
  assert.match(styles, /\.docker-settings-form fieldset \{height:auto/);
  assert.match(styles, /\.docker-settings \.fh-field__label \{font-size:13px/);
  assert.match(styles, /\.docker-settings \.fh-select__trigger, \.docker-settings \.fh-select__menu \{font-size:13px/);
  assert.match(styles, /\.docker-settings \.fh-checkbox \{font-size:13px/);
});

test('settings explanations use contextual help and checked boxes use theme-aware contrast', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8');
  assert.match(source, /actions=\{<HelpPopover label="刷新与范围说明">/);
  assert.match(source, /<HelpPopover label="Docker 环境说明">/);
  assert.doesNotMatch(source, /description="后台采集|<footer className="docker-footer"/);
  assert.match(styles, /\.docker-settings \.fh-checkbox input\[type="checkbox"\]:checked \{[^}]*var\(--fh-on-accent/);
  const luminance = (hex) => {
    const parts = hex.match(/[a-f\d]{2}/gi).map((part) => parseInt(part, 16) / 255);
    return parts.map((part) => part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4).reduce((sum, part, index) => sum + part * [0.2126, 0.7152, 0.0722][index], 0);
  };
  for (const [accent, foreground] of [['91baff', '142238'], ['2563d9', 'ffffff']]) {
    const values = [luminance(accent), luminance(foreground)].sort((a, b) => b - a);
    assert.ok((values[0] + 0.05) / (values[1] + 0.05) >= 4.5);
  }
});


test('project groups can be reordered without changing container membership', () => {
  const groups = [['web-app', [{id: 'a'}]], ['', [{id: 'b'}]], ['worker', [{id: 'c'}]]];
  const order = model.reorderGroups(groups, [], 'worker', 'web-app');
  assert.deepEqual(JSON.parse(JSON.stringify(order)), ['worker', 'web-app', '']);
  assert.deepEqual(JSON.parse(JSON.stringify(model.sortGroups(groups, order).map(([name]) => name))), JSON.parse(JSON.stringify(order)));
  assert.equal(groups[0][1][0].id, 'a');
});

test('preview shows both referenced and unreferenced image states', async () => {
  const api = load('api').createPreviewApi();
  const {images} = await api.invoke('images');
  const unused = await api.invoke('image_detail', {id: images[0].ID});
  const used = await api.invoke('image_detail', {id: images[1].ID});
  assert.equal(unused.containers.length, 0);
  assert.equal(used.containers.length, 1);
  assert.equal(used.containers[0].name, 'web-app-postgres-1');
});

test('container terminal has its own tab and preview cannot start a session', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
  const terminal = fs.readFileSync(path.join(__dirname, '../src/ContainerTerminal.tsx'), 'utf8');
  assert.match(source, /<Tabs.Trigger value="terminal">终端<\/Tabs.Trigger>/);
  assert.match(source, /<Tabs.Panel value="terminal"><ContainerTerminal/);
  assert.match(terminal, /disabled=\{!canConnect\}/);
  assert.match(terminal, /terminal_close/);
  const api = load('api').createPreviewApi();
  await assert.rejects(api.invoke('terminal_open', {id: 'a'.repeat(64)}), /浏览器预览不执行操作/);
});

test('management model keeps issue filtering, grouping, and action boundaries', () => {
  const rows = [
    {id: 'a', name: 'api', image: 'demo/api', state: 'restarting', status: 'Restarting', project: 'demo', service: 'api'},
    {id: 'b', name: 'db', image: 'postgres', state: 'running', status: 'Up (healthy)', project: 'demo', service: 'db'},
    {id: 'c', name: 'redis', image: 'redis', state: 'exited', status: 'Exited (0)', project: '', service: ''},
  ];
  assert.equal(model.filterContainers(rows, 'compose', '', true).length, 1);
  assert.equal(model.filterContainers(rows, 'standalone', '', false)[0].id, 'c');
  assert.deepEqual(JSON.parse(JSON.stringify(model.groupContainers(rows).map(([name, group]) => [name, group.length]))), [['demo', 2], ['', 1]]);
  assert.deepEqual(JSON.parse(JSON.stringify(model.actionAvailability(rows[0]))), {start: false, stop: true, restart: true, remove: false});
  assert.equal(model.actionAvailability(rows[2]).remove, true);
});

test('management pages use the React bundle while widget-detail keeps its token bridge', () => {
  const index = fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf8');
  const detail = fs.readFileSync(path.join(__dirname, '../ui/widget-detail.html'), 'utf8');
  assert.match(index, /react\/docker\.js/);
  assert.doesNotMatch(index, /app-shell|app\.js|style\.css|management\.css/);
  assert.match(detail, /widget\/widget-bridge\.js/);
  assert.match(detail, /react\/docker\.js/);
  assert.doesNotMatch(detail, /app-shell|app\.js|management\.css/);
  assert.match(fs.readFileSync(path.join(__dirname, '../ui/widget/widget-bridge.js'), 'utf8'), /flowhubWidgetToken/);
});

test('transport ignores unknown or wrong message types and dispose rejects pending work', async () => {
  const apiSource = fs.readFileSync(path.join(__dirname, '../src/api.ts'), 'utf8');
  const code = ts.transpileModule(apiSource, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  const listeners = new Map();
  const parent = {messages: [], postMessage(message) {this.messages.push(message);}};
  const host = {
    parent,
    crypto: {randomUUID: () => 'request-1'},
    addEventListener(type, handler) {listeners.set(type, handler);},
    removeEventListener(type, handler) {if (listeners.get(type) === handler) listeners.delete(type);},
  };
  const exports = {};
  vm.runInNewContext(code, {exports, Promise, Map, Date, Math, Error, setTimeout, clearTimeout});
  const api = exports.createApi(host);
  const request = api.invoke('list');
  const receive = listeners.get('message');
  receive({source: parent, data: {type: 'unknown', id: 'request-1', result: {}}});
  receive({source: parent, data: {type: 'flowhub:response', id: 'unknown', result: {}}});
  assert.equal(parent.messages.length, 1);
  receive({source: parent, data: {type: 'flowhub:response', id: 'request-1', result: {ok: true}}});
  assert.deepEqual(await request, {ok: true});

  const pending = api.invoke('list');
  api.dispose();
  await assert.rejects(pending, /插件连接已关闭/);
  assert.equal(listeners.has('message'), false);
  const afterDispose = api.invoke('list');
  await assert.rejects(afterDispose, /插件连接已关闭/);
});

test('preview API rejects mutations asynchronously without sending host messages', async () => {
  const api = load('api').createPreviewApi();
  await assert.rejects(api.invoke('operate', {id: 'a'.repeat(64)}), /浏览器预览不执行操作/);
  await assert.rejects(api.invoke('image_prune_confirm', {confirmed: true, targets: []}), /浏览器预览不执行操作/);
  const list = await api.invoke('list');
  assert.equal(list.context, '本机 · 模拟数据');
});
