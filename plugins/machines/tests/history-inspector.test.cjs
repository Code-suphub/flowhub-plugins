const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

test('selected history output rejects wrong targets and ignores late responses', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/history/HistoryInspector.tsx'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  let effect, state;
  const pending = [], exports = {};
  vm.runInNewContext(code, { exports, document: { hidden: false }, setTimeout: () => 1, clearTimeout() {}, require(name) {
    if (name === 'react') return { useState: () => [state, next => { state = typeof next === 'function' ? next(state) : next; }], useEffect: fn => { effect = fn; } };
    return {};
  } });
  const api = (action, payload) => new Promise(resolve => pending.push({ action, payload, resolve }));
  const job = id => ({ id, hostId: `host-${id}`, alias: id, kind: 'command', finishedAt: 2 });
  const render = (id, active = true) => { exports.useJobDetail(api, job(id), active, 0); return effect(); };
  const closeA = render('a'); closeA();
  const closeB = render('b');
  pending[1].resolve({ ...job('b'), stdout: 'correct' });
  await new Promise(resolve => setImmediate(resolve));
  pending[0].resolve({ ...job('a'), stdout: 'old' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.data.stdout, 'correct'); closeB();
  const closeC = render('c'); pending[2].resolve({ ...job('wrong'), stdout: 'must not publish' });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(state.error, /目标不匹配/); assert.equal(state.data, undefined); closeC();
  render('d', false); assert.equal(pending.length, 3);
  assert(pending.every(call => call.action === 'job'), 'viewing output never submits a command');
});
