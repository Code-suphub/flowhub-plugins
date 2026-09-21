const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');

test('incremental builds preserve other bundles in shared output directories', () => {
  for (const config of ['vite.react.config.mjs', 'vite.fleet.config.mjs', 'vite.widget-card.config.mjs', 'vite.widget-detail.config.mjs']) {
    const source = readFileSync(resolve(__dirname, '..', config), 'utf8');
    assert.match(source, /emptyOutDir:\s*false/, `${config} must not erase sibling bundles`);
  }
});
