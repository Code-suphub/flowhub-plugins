const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pluginRoot = path.resolve(__dirname, '..');

test('widget editor has one React-owned entry and no replaced static implementation', () => {
  const sourceEntry = fs.readFileSync(path.join(pluginRoot, 'src/widget-editor/index.html'), 'utf8');
  assert.match(sourceEntry, /id="root"/);
  assert.match(sourceEntry, /widget\/widget-bridge\.js" data-flowhub-ready="editor"/);
  assert.match(sourceEntry, /type="module" src="react\/widget-editor\.js"/);
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
