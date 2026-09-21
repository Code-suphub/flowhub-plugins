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
  const list = await api.invoke('list');
  assert.equal(list.context, '本机 · 模拟数据');
});
