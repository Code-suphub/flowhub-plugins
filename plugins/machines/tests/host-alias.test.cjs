const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');

test('SSH identity is automatic, stable on rename, independent on copy and mode switch', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/host-editor/HostEditorController.tsx'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const slots = [];
  let cursor = 0, props, handle;
  let hosts = [];
  const writes = [];
  const api = async (method, args) => {
    if (method === 'state') return { config: { hosts } };
    if (method === 'sshRead') return { revision: 'r1', profile: { hostname: 'example.test', user: 'root', port: 22, proxyJump: '', identityFile: '' } };
    if (method === 'sshSave') { writes.push(args.profile.alias); return { revision: 'r2' }; }
    if (method === 'hosts') { hosts = args.hosts; return {}; }
    throw Error(method);
  };
  const exports = {};
  vm.runInNewContext(code, { exports, crypto, window: {}, require(name) {
    if (name === 'react') return {
      forwardRef: fn => fn,
      useImperativeHandle: (_, factory) => { handle = factory(); },
      useRef: initial => { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
      useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    };
    if (name === 'react/jsx-runtime') return { jsx: (_, value) => { props = value; } };
    if (name === './HostEditor') return { HostEditor() {} };
    throw Error(name);
  } });
  const render = () => { cursor = 0; exports.HostEditorController({ api }, null); };
  const change = (field, value) => { props.actions.onChange(field, value); render(); };
  render();
  await handle.open(); render();
  const alias = props.value.alias;
  assert.match(alias, /^flowhub-[a-f0-9-]+$/);
  change('name', '新加坡服务器');
  change('sshHostname', 'example.test');
  change('sshUser', 'root');
  change('connectionType', 'bastion');
  assert.equal(props.value.alias, '');
  change('alias', 'target-01');
  change('connectionType', 'ssh');
  assert.equal(props.value.alias, alias);
  await props.actions.onSave(); render();
  assert.equal(hosts[0].alias, alias);
  assert.deepEqual(writes, [alias]);
  await handle.open(hosts[0].id); render();
  change('name', '改名后');
  await props.actions.onSave(); render();
  assert.equal(hosts[0].alias, alias);
  await handle.open(hosts[0].id, { copy: true }); render();
  assert.notEqual(props.value.alias, alias);
  assert.match(props.value.alias, /^flowhub-/);
  await props.actions.onSave(); render();
  assert.equal(hosts.length, 2);
  assert.notEqual(hosts[0].alias, hosts[1].alias);
  assert.deepEqual(writes, [alias, hosts[1].alias]);
});
