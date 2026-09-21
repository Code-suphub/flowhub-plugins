const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function load(name) {
  const source = fs.readFileSync(path.join(__dirname, '../src', name + '.ts'), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  const exports = {};
  vm.runInNewContext(code, {exports, setTimeout, clearTimeout, Date, console});
  return exports;
}
const {CodeCache, filterAccounts} = load('codes');
const {createApi, createTransport} = load('api');
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};

test('filter by name or issuer without changing account order', () => {
  const accounts = [{name:'Work', issuer:'GitHub'}, {name:'Mail', issuer:null}];
  assert.deepEqual(filterAccounts(accounts, ' github '), [accounts[0]]);
  assert.deepEqual(filterAccounts(accounts, 'MAIL'), [accounts[1]]);
  assert.equal(filterAccounts(accounts, 'missing').length, 0);
});
test('codes deduplicate in-flight requests, reuse until expiry, then refresh', async () => {
  let time = 1000, calls = 0;
  const request = deferred();
  const cache = new CodeCache(async () => {calls++; return request.promise;}, () => time);
  const a = cache.ensure('demo'), b = cache.ensure('demo');
  assert.equal(a,b);
  request.resolve({code:'123456', remaining:30});
  await a;
  time = 20_000; await cache.ensure('demo'); assert.equal(calls,1);
  time = 31_000; await cache.ensure('demo'); assert.equal(calls,2);
});
test('invalidate cache after mutation: late response cannot restore old code', async () => {
  const old = deferred();
  const cache = new CodeCache(() => old.promise);
  const request = cache.ensure('demo'); cache.clear();
  old.resolve({code:'123456', remaining:30}); await request;
  assert.equal(cache.read('demo'),undefined);
});
test('invalid responses and synchronous errors back off and can retry', async () => {
  let calls = 0, time = 0;
  const cache = new CodeCache(() => {calls++; throw Error('offline');}, () => time);
  await cache.ensure('demo'); await cache.ensure('demo'); assert.equal(calls,1);
  time = 5001; await cache.ensure('demo'); assert.equal(calls,2);
  const invalid = new CodeCache(async () => ({code:'bad',remaining:30}));
  await invalid.ensure('demo'); assert.equal(invalid.read('demo').code,undefined);
  assert.match(invalid.read('demo').error,/响应无效/);
});
function host() {
  let listener, serial = 0;
  const sent = [], parent = {postMessage: value => sent.push(value)};
  return {parent, sent, crypto:{randomUUID:()=>String(++serial)},
    addEventListener:(_,cb)=>{listener=cb;},removeEventListener:()=>{listener=null;},
    respond(data, source=parent) {listener?.({source,data});}};
}
test('RPC accepts only matching host responses and rejects pending calls on disposal', async () => {
  const window = host(), transport = createTransport(window);
  const request = transport.invoke('list');
  let settled = false; request.then(()=>{settled=true;});
  window.respond({type:'flowhub:response', id:'1', result:'untrusted'}, {});
  window.respond({type:'flowhub:response', id:'wrong', result:'untrusted'});
  await Promise.resolve(); assert.equal(settled,false);
  window.respond({type:'flowhub:response',id:'1',result:'ok'});
  assert.equal(await request,'ok');
  const pending = transport.invoke('list');
  transport.dispose(); await assert.rejects(pending,/关闭/);
  await assert.rejects(transport.invoke('list'),/关闭/);
});
test('RPC timeout clears pending request', async () => {
  const transport = createTransport(host(), 5);
  await assert.rejects(transport.invoke('list'), /超时/); transport.dispose();
});
test('standalone preview is read-only', async () => {
  const window = {}; window.parent = window;
  const api = createApi(window);
  assert.equal(api.preview,true);
  assert.equal((await api.list()).length,1);
  await assert.rejects(api.save({name:'test',secret:''}), /预览/);
  await assert.rejects(api.remove('test'), /预览/);
});
test('host API preserves names and edit previous field without returning secrets', async () => {
  const window = host(), api = createApi(window);
  const saving = api.save({name:'new',previous:'old',issuer:null,secret:''});
  assert.equal(window.sent[0].method,'save');
  assert.equal(window.sent[0].params.previous,'old');
  assert.equal(window.sent[0].params.secret,'');
  window.respond({type:'flowhub:response',id:'1',result:{saved:true}});
  await saving; api.dispose();
});
test('source entry has a single React root and no legacy scripts', () => {
  const root = path.join(__dirname,'..');
  const html = fs.readFileSync(path.join(root,'ui/index.html'),'utf8');
  assert.match(html,/react\/twofa.js/);
  for (const file of ['app.js','bridge.js','style.css']) assert.equal(fs.existsSync(path.join(root,'ui',file)),false);
  const app = fs.readFileSync(path.join(root,'src/App.tsx'),'utf8');
  assert.match(app,/@flowhub\/plugin-common\/react/);
  assert.doesNotMatch(app,/innerHTML|localStorage|window.confirm/);
});
