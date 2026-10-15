const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync('src/command/useBastionSession.ts', 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const flush = async () => { for (let i=0;i<5;i++) await Promise.resolve(); };
function harness(api, hidden=false) {
  const slots=[], effects=[], timers=new Map(), errors=[];
  let cursor=0, timerId=0, host={id:'a',bastion:{target:'a'}}, value;
  const react = {
    useRef(initial) { const i=cursor++; return slots[i] ??= {current:initial}; },
    useState(initial) { const i=cursor++; if (!(i in slots)) slots[i]=initial; return [slots[i], next => {slots[i]=typeof next==='function'?next(slots[i]):next;}]; },
    useMemo(fn,deps) { const i=cursor++; if (!slots[i] || deps.some((d,j)=>d!==slots[i].deps[j])) slots[i]={deps,value:fn()}; return slots[i].value; },
    useEffect(fn,deps) { const i=cursor++; if (!slots[i] || deps.some((d,j)=>d!==slots[i].deps[j])) { const previous=slots[i]; slots[i]={deps}; effects.push(()=>{previous?.cleanup?.(); slots[i].cleanup=fn();}); } },
  };
  const exports={}; const onError=e=>errors.push(e);
  vm.runInNewContext(code, {exports, require:()=>react, document:{hidden}, window:{setTimeout(fn){const id=++timerId;timers.set(id,fn);return id;}, clearTimeout(id){timers.delete(id);}}});
  const render = () => { cursor=0; value=exports.useBastionSession(api,host,true,onError); while(effects.length) effects.shift()(); return value; };
  return { render, errors, timers, switch(id){host={id,bastion:{target:id}};return render();}, tick(){const entries=[...timers];timers.clear();for(const [,fn] of entries)fn();} };
}
test('old host responses cannot replace the new host or clear its busy state', async () => {
  const requests=[];
  const h=harness((action,payload)=>{const d=deferred();requests.push({action,id:payload.hostId,...d});return d.promise;});
  h.render(); const oldPoll=requests[0];
  const oldAction=h.render().sessionAction('bastionStart');
  assert.equal(h.render().bastionBusy,true);
  assert.equal(h.switch('b').bastionBusy,false);
  const newPoll=requests.at(-1);
  const newAction=h.render().sessionAction('bastionStart');
  const newActionRequest=requests.at(-1);
  oldPoll.resolve({connected:true,output:'wrong old output'});
  requests[1].reject(Error('wrong old error'));
  await oldAction; await flush();
  assert.equal(h.render().bastionBusy,true);
  assert.equal(h.render().bastion.connected,false);
  assert(!h.errors.includes('wrong old error'));
  newActionRequest.resolve({connected:true,output:'new action'});await newAction;
  newPoll.resolve({connected:false,output:'stale new poll'});await flush();
  assert.equal(h.render().bastion.output,'new action');
  assert.equal(h.render().bastionBusy,false);
});
test('polling waits for completion and actions keep the visible session stable', async () => {
  const requests=[];
  const h=harness((action)=>{const d=deferred();requests.push({action,...d});return d.promise;});
  h.render();h.tick();h.tick();assert.equal(requests.length,1);
  requests[0].resolve({connected:true,output:'ready'});await flush();
  assert.equal(h.render().bastion.output,'ready');
  const action=h.render().sessionAction('bastionSend');
  assert.equal(h.render().bastion.connected,true);
  h.tick();await flush();assert.equal(requests.length,2);
  requests[1].resolve({connected:true,output:'sent'});await action;
  assert.equal(h.render().bastion.output,'sent');
  h.tick();assert.equal(requests.length,3);
});

test('a hidden host window reads the initial session once and then pauses polling', async () => {
  let calls=0;
  const h=harness(async()=>{calls++;return {connected:true,output:'existing session'};},true);
  h.render();await flush();assert.equal(h.render().bastion.connected,true);assert.equal(calls,1);
  h.tick();await flush();h.tick();await flush();assert.equal(calls,1);
});
