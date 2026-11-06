const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

test('history responses cannot move between inspected machines or publish after closing', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/fleet/MachineInspector.tsx'), 'utf8');
  const code = ts.transpileModule(`${source}\nexport { InspectorHistory };`, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const state = [], pending = [];
  let cursor = 0, effect;
  const exports = {};
  vm.runInNewContext(code, { exports, require(name) {
    if (name === 'react') return {
      useState(initial) { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], next => { state[i] = typeof next === 'function' ? next(state[i]) : next; }]; },
      useEffect(fn) { effect = fn; },
    };
    if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null };
    return {};
  } });
  const api = (action, payload) => new Promise(resolve => pending.push({ action, payload, resolve }));
  const render = (hostId, active = true) => { cursor = 0; exports.InspectorHistory({ api, hostId, active }); return effect(); };
  const closeA = render('a'); closeA();
  const closeB = render('b');
  assert.equal(pending.length, 2);
  assert.equal(pending[0].action, 'metricHistory');
  assert.equal(pending[1].payload.hostId, 'b');
  pending[1].resolve({ data: [[1, 22]] });
  await new Promise(resolve => setImmediate(resolve));
  pending[0].resolve({ data: [[1, 99]] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state[2].hostId, 'b');
  assert.equal(state[2].data.data[0][1], 22);
  closeB();
  const closeC = render('c'); closeC();
  pending[2].resolve({ data: [[1, 77]] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state[2].data, undefined, 'a closed inspector must not receive its late result');
  render('d', false);
  assert.equal(pending.length, 3, 'hidden workspaces do not read history');
  assert(pending.every(call => call.action === 'metricHistory'), 'inspecting must not probe or connect SSH');
});
