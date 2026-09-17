import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {checkPlugins} from './check-plugins.mjs';

function fixtureRoot(t, plugins) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowhub-check-plugins-'));
  fs.mkdirSync(path.join(root, 'plugins'), {recursive: true});
  for (const [id, files] of Object.entries(plugins)) {
    for (const [relative, content] of Object.entries(files)) {
      const file = path.join(root, 'plugins', id, relative);
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
    }
  }
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}

const validManifest = (overrides = {}) => ({
  schema: 2, id: 'demo', name: '演示', version: '1.0.0', description: '演示插件',
  ui: 'ui/index.html', executable: 'bin/flowhub-demo', permissions: ['native-process'], ...overrides
});

function validPlugin(overrides = {}) {
  const {manifest: manifestOverrides, ...fileOverrides} = overrides;
  return {
    'flowhub-plugin.json': validManifest(manifestOverrides),
    'package.json': {name: 'flowhub-demo-plugin', version: '1.0.0', private: true, scripts: {build: 'node scripts/build.mjs', test: 'node --test tests/*.test.cjs'}},
    'README.md': '# 演示\n',
    'package-lock.json': '{}\n',
    'backend/Cargo.toml': '[package]\nname="flowhub-demo"\nversion="1.0.0"\n',
    'ui/index.html': '<h1>demo</h1>\n',
    'scripts/build.mjs': '// build\n',
    ...fileOverrides
  };
}

test('a compliant plugin passes every convention', (t) => {
  const root = fixtureRoot(t, {demo: validPlugin()});
  assert.deepEqual(checkPlugins(root), {ids: ['demo'], errors: []});
});

test('the repository plugins satisfy the convention', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const {ids, errors} = checkPlugins(root);
  assert.deepEqual(errors, []);
  assert.ok(ids.length >= 4, `期望至少 4 个插件，实际 ${ids.length}`);
});

test('missing release inputs are reported per plugin', (t) => {
  const files = validPlugin();
  delete files['package-lock.json'];
  delete files['README.md'];
  delete files['backend/Cargo.toml'];
  delete files['package.json'];
  const {errors} = checkPlugins(fixtureRoot(t, {demo: files}));
  for (const expected of ['缺少 package-lock.json', '缺少 README.md', '缺少 backend/Cargo.toml', '缺少 package.json']) {
    assert.ok(errors.some(error => error.includes(expected)), `应报告 ${expected}：${errors.join(' | ')}`);
  }
});

test('schema 1 manifests, version drift and id mismatch are rejected', (t) => {
  const root = fixtureRoot(t, {
    demo: validPlugin({manifest: {schema: 1, id: 'other', version: '1.0'}}),
    broken: {'flowhub-plugin.json': 'not json\n'}
  });
  const {errors} = checkPlugins(root);
  assert.ok(errors.some(error => error.includes('schema 必须为 2')));
  assert.ok(errors.some(error => error.includes('与目录名不一致')));
  assert.ok(errors.some(error => error.includes('不是 x.y.z')));
  assert.ok(errors.some(error => error.includes('无法解析')));
});

test('version must agree across manifest, package.json and Cargo.toml', (t) => {
  const files = validPlugin();
  files['package.json'] = {...files['package.json'], version: '2.0.0'};
  files['backend/Cargo.toml'] = '[package]\nname="flowhub-demo"\nversion="3.0.0"\n';
  const {errors} = checkPlugins(fixtureRoot(t, {demo: files}));
  assert.ok(errors.some(error => error.includes('package.json version (2.0.0)')));
  assert.ok(errors.some(error => error.includes('Cargo.toml version (3.0.0)')));
});

test('ui, widget pages and executable paths are validated', (t) => {
  const files = validPlugin();
  delete files['ui/index.html'];
  files['flowhub-plugin.json'] = validManifest({
    ui: 'ui/missing.html',
    executable: '../outside',
    widget: {card: 'widget-card.html', detail: 'widget-missing.html'}
  });
  const {errors} = checkPlugins(fixtureRoot(t, {demo: files}));
  assert.ok(errors.some(error => error.includes('ui 页面不存在')));
  assert.ok(errors.some(error => error.includes('executable 必须是插件目录内的相对路径')));
  assert.ok(errors.some(error => error.includes('widget.card 页面不存在')));
  assert.ok(errors.some(error => error.includes('widget.detail 页面不存在')));
});

test('scaffold and schema 1 leftovers are rejected', (t) => {
  const files = validPlugin();
  files['.codex-plugin/plugin.json'] = '{}\n';
  files['legacy-package.json'] = '{}\n';
  const {errors} = checkPlugins(fixtureRoot(t, {demo: files}));
  assert.ok(errors.some(error => error.includes('.codex-plugin')));
  assert.ok(errors.some(error => error.includes('legacy-package.json')));
});

test('an empty plugins directory is a failure', (t) => {
  const root = fixtureRoot(t, {});
  assert.ok(checkPlugins(root).errors.some(error => error.includes('没有找到任何插件')));
});
