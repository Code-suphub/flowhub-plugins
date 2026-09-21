import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkBuiltUi } from './check-built-ui.mjs';
function fixture(t, html) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowhub-assets-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'ui/react'), { recursive: true });
  fs.writeFileSync(path.join(root, 'flowhub-plugin.json'), JSON.stringify({ ui: 'ui/index.html' }));
  fs.writeFileSync(path.join(root, 'ui/index.html'), html);
  fs.writeFileSync(path.join(root, 'ui/react/app.js'), '');
  return root;
}
test('accepts generated local scripts with query strings', t => {
  assert.deepEqual(checkBuiltUi(fixture(t, '<script src="react/app.js?v=1"></script>')), []);
});
test('detects missing assets, external and inline scripts', t => {
  const errors = checkBuiltUi(fixture(t, '<link href="react/missing.css"><script src="https://example.com/app.js"></script><script>alert(1)</script>'));
  assert.equal(errors.length, 3);
});
test('detects resource traversal and unresolved shared markers', t => {
  const errors = checkBuiltUi(fixture(t, '<link data-flowhub-common><script src="../../escape.js"></script>'));
  assert.equal(errors.length, 2);
});
