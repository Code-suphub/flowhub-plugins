const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');

test('shared SSH source selection and link lifecycle', {timeout: 30000}, () => {
  const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_ssh_core_source.py'], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
});
