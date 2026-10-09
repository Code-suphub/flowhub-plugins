const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const pluginRoot = path.resolve(__dirname, '..');

test('same-named SSH and Netdata targets show independent sources and collection status', () => {
  const exports = {};
  const source = fs.readFileSync(path.join(pluginRoot, 'src/widget-editor/options.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
  const rows = [
    { id: 'host-1', name: 'tencent-sg', source: 'SSH', status: 'healthy' },
    { id: 'netdata-1', name: 'tencent-sg', kind: 'netdata', status: 'error' },
    { id: 'host-2', name: 'exporter', source: 'Node Exporter', status: 'stale' },
  ];
  const options = exports.machineOptionsFromRows(rows);
  assert.equal(options[0].label, 'tencent-sg · SSH');
  assert.equal(options[1].label, 'tencent-sg · Netdata（采集失败）');
  assert.equal(options[2].label, 'exporter · Node Exporter（数据已过期）');
  assert.equal(options[0].value, 'host-1');
  assert.equal(options[1].value, 'netdata-1');
  rows[1].status = 'healthy';
  assert.equal(exports.machineOptionsFromRows(rows)[1].label, 'tencent-sg · Netdata');
});

test('widget editor has one React-owned entry and no replaced static implementation', () => {
  const sourceEntry = fs.readFileSync(path.join(pluginRoot, 'src/widget-editor/index.html'), 'utf8');
  assert.match(sourceEntry, /id="root"/);
  assert.match(sourceEntry, /widget\/widget-bridge\.js" data-flowhub-ready="editor"/);
  assert.match(sourceEntry, /<script src="react\/widget-editor\.js"><\/script>/);
  assert.doesNotMatch(sourceEntry, /widget\/widget-editor\.(?:js|css)/);

  for (const replaced of [
    'ui/widget/widget-editor.js',
    'ui/widget/widget-editor.css',
  ]) {
    assert.equal(fs.existsSync(path.join(pluginRoot, replaced)), false, `${replaced} must stay deleted`);
  }
});

test('React editor build guard keeps the host bridge and rejects stale editor assets', () => {
  const check = fs.readFileSync(path.join(pluginRoot, 'scripts/check-react-build.mjs'), 'utf8');
  assert.match(check, /data-flowhub-ready="editor"/);
  assert.match(check, /widget\/widget-editor\.js/);
  assert.match(check, /widget\/widget-editor\.css/);
});
