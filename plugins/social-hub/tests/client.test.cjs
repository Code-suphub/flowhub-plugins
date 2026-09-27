const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(name) {
  const source = fs.readFileSync(path.join(__dirname, '../src', `${name}.ts`), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  const exports = {};
  vm.runInNewContext(code, {exports, URL, Promise, setTimeout, clearTimeout, Date});
  return exports;
}

const {createApi, createTransport, isOfficialOAuthUrl} = load('api');

function host() {
  let listener;
  let serial = 0;
  const sent = [];
  const parent = {postMessage: value => sent.push(value)};
  return {
    parent,
    sent,
    crypto: {randomUUID: () => String(++serial)},
    addEventListener: (_, callback) => {listener = callback;},
    removeEventListener: () => {listener = null;},
    respond(data, source = parent) {listener?.({source, data});},
  };
}

test('RPC rejects a response from another window and clears a timed-out request', async () => {
  const window = host();
  const transport = createTransport(window, 5);
  const request = transport.invoke('health', {});
  window.respond({type: 'flowhub:response', id: '1', result: {protocol: 99}}, {});
  await assert.rejects(request, /超时/);
  transport.dispose();
  await assert.rejects(transport.invoke('health', {}), /关闭/);
});

test('RPC falls back to getRandomValues when randomUUID is unavailable', async () => {
  const window = host();
  delete window.crypto.randomUUID;
  window.crypto.getRandomValues = array => {array.fill(7); return array;};
  const transport = createTransport(window);
  const request = transport.invoke('health', {});
  assert.match(window.sent[0].id, /^[0-9a-f]{32}$/);
  window.respond({type: 'flowhub:response', id: window.sent[0].id, result: {protocol: 1}});
  assert.deepEqual(await request, {protocol: 1});
  transport.dispose();
});

test('RPC forwards typed social methods and accepts only the matching response', async () => {
  const window = host();
  const transport = createTransport(window);
  const request = transport.invoke('send', {conversationId: 'demo', text: '保留草稿'});
  assert.deepEqual(window.sent[0].params, {conversationId: 'demo', text: '保留草稿'});
  window.respond({type: 'flowhub:response', id: window.sent[0].id, result: {ok: false, reason: '未授权'}});
  assert.deepEqual(await request, {ok: false, reason: '未授权'});
  transport.dispose();
});

test('preview API is explicit, read-only demo data and never authorizes or sends', async () => {
  const window = {parent: null};
  window.parent = window;
  const api = createApi(window);
  assert.equal(api.preview, true);
  assert.equal((await api.listConnectors()).items[0].mode, '演示数据');
  assert.equal((await api.listConversations())[0].title, '演示会话');
  assert.equal((await api.listConversations('不存在的会话')).length, 0);
  assert.equal((await api.listConversations('访客')).length, 1);
  assert.equal((await api.authorize({platform: 'douyin', clientKey: 'demo', redirectUri: 'https://example.com'})).ok, false);
  assert.equal((await api.send('preview', '不会发送')).ok, false);
});

test('OAuth links are limited to the official HTTPS endpoint', () => {
  assert.equal(isOfficialOAuthUrl('https://open.douyin.com/platform/oauth/connect/?client_key=demo'), true);
  assert.equal(isOfficialOAuthUrl('http://open.douyin.com/platform/oauth/connect/'), false);
  assert.equal(isOfficialOAuthUrl('https://evil.example/platform/oauth/connect/'), false);
  assert.equal(isOfficialOAuthUrl('https://open.douyin.com.evil.example/platform/oauth/connect/'), false);
  assert.equal(isOfficialOAuthUrl('https://user:pass@open.douyin.com/platform/oauth/connect/'), false);
  assert.equal(isOfficialOAuthUrl('https://open.douyin.com:8443/platform/oauth/connect/'), false);
});

test('source entry uses one React root, separate forms, and removes the legacy UI', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'ui/index.html'), 'utf8');
  assert.match(html, /react\/social-hub\.js/);
  assert.match(html, /<link rel="stylesheet" href="react\/social-hub\.css">/);
  for (const file of ['app.js', 'bridge.js', 'style.css']) assert.equal(fs.existsSync(path.join(root, 'ui', file)), false);
  const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');
  assert.match(app, /@flowhub\/plugin-common\/react/);
  assert.match(app, /id="social-oauth-form"/);
  assert.match(app, /contentClassName="social-hub__dialog-shell"/);
  assert.match(app, /className="social-hub__composer"/);
  assert.match(app, /\[drafts, setDrafts\]/);
  assert.doesNotMatch(app, /FLOWHUB \/ SOCIAL INBOX|>INBOX</);
  assert.doesNotMatch(app, /innerHTML|localStorage|window\.alert|window\.open/);
});

test('production style guard rejects missing links and missing layout rules', async () => {
  const {checkStyle} = await import('../scripts/check-style.mjs');
  const html = fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8');
  assert.doesNotThrow(() => checkStyle(html, css));
  assert.match(css, /\.social-hub__dialog\s*\{[^}]*height:min\(/);
  assert.match(css, /\.social-hub__dialog-shell\s*\{[^}]*grid-template-rows:auto minmax\(0,1fr\) auto/);
  assert.throws(() => checkStyle(html.replace(/<link[^>]+>/g, ''), css), /production stylesheet/);
  assert.throws(() => checkStyle(html, ''), /workspace layout/);
});
