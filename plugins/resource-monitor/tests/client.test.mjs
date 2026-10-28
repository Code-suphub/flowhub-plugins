import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {webcrypto} from 'node:crypto';

async function moduleAt(entry) {
  const result=await build({entryPoints:[new URL(entry,import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'esm'});
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const model=await moduleAt('../src/model.ts');
const {createApi}=await moduleAt('../src/api.ts');

function host(surface='main',hosted=false,token='') {
  const bus=new EventTarget(),messages=[],parent={postMessage:message=>messages.push(message)};
  const window={document:{body:{dataset:{surface}}},location:{hash:token?`#flowhubWidgetToken=${token}`:''},crypto:webcrypto,
    addEventListener:bus.addEventListener.bind(bus),removeEventListener:bus.removeEventListener.bind(bus)};
  window.parent=hosted?parent:window;
  const receive=(data,source=parent)=>{const event=new Event('message');Object.assign(event,{data,source});bus.dispatchEvent(event);};
  return {window,messages,parent,receive};
}

test('rank/search includes child PID, cwd and parent; sorting does not mutate source',()=>{
  const snapshot=model.sampleSnapshot(),original=snapshot.groups.map(g=>g.id);
  assert.equal(model.filterGroups(snapshot.groups,'401',false,'memory')[0].name,'Codex');
  assert.equal(snapshot.groups.flatMap(g=>g.processes).filter(p=>model.matchesProcess(p,'401')).length,1);
  assert.ok(model.filterGroups(snapshot.groups,'mobile-automation',false,'cpu').length);
  assert.equal(model.filterGroups(snapshot.groups,'',false,'memory').some(g=>g.system),false);
  assert.equal(model.filterGroups(snapshot.groups,'',true,'memory').some(g=>g.system),true);
  assert.deepEqual(snapshot.groups.map(g=>g.id),original);
  assert.equal(model.bytes(null),'—');assert.equal(model.cpu(null),'采样中');
  assert.equal(model.bytes(1073741824),'1.00 GiB');
});

test('detail refresh keeps row order, marks exits and appends reused PIDs and new processes',()=>{
  const group=model.sampleSnapshot().groups[0];
  const [first,second,third]=group.processes;
  const latest={...group,processes:[{...second,footprint:1},{...first,footprint:9999999999},{...third,started:third.started+1}]};
  const detail=model.updateDetail(group,latest);
  assert.deepEqual(detail.processes.map(p=>[p.pid,p.started]),[[first.pid,first.started],[second.pid,second.started],[third.pid,third.started],[third.pid,third.started+1]]);
  assert.equal(detail.processes[0].footprint,9999999999);
  assert.equal(detail.processes[2].exited,true);
  assert.equal(detail.processes[2].memory,null);
  assert.equal(model.updateDetail(detail,undefined).canTerminate,false);
});

test('context usage deduplicates identities, rejects reused PIDs, preserves unknowns and expires mappings',()=>{
  const snapshot=model.sampleSnapshot(),contexts=model.sampleContexts('codex',snapshot);
  const process=snapshot.groups[0].processes[2];
  contexts.entries[0].processes.push({...process});
  let rows=model.contextRows(contexts,snapshot,snapshot.at);
  assert.equal(rows[0].memory,process.memory);assert.equal(rows[0].liveProcesses.length,1);
  assert.equal(rows[1].memory,null);assert.equal(rows[1].state,'未关联');
  const changed=structuredClone(snapshot);changed.groups[0].processes[2].started++;
  rows=model.contextRows(contexts,changed,snapshot.at);
  assert.equal(rows[0].memory,null);assert.equal(rows[0].state,'进程已退出');
  rows=model.contextRows(contexts,snapshot,snapshot.at+300001);
  assert.equal(rows[0].footprint,null);assert.equal(rows[0].state,'映射已过期');
  const arc=model.sampleContexts('arc',snapshot);
  const shared=model.contextRows(arc,snapshot,snapshot.at);
  assert.equal(shared[0].state,'共享进程');assert.equal(shared[0].liveProcesses[0].pid,471);
  assert.equal(shared[0].memory,shared[1].memory);
});

test('standalone preview blocks mutations and host settings without posting',async()=>{
  const h=host(),api=createApi(h.window);
  assert.equal(api.preview,true);assert.ok((await api.invoke('snapshot')).groups.length);
  await assert.rejects(api.invoke('terminate_preview'),/预览/);
  await assert.rejects(api.invoke('flowhub_status'),/预览/);
  assert.equal(h.messages.length,0);api.dispose();
});

test('normal transport accepts only its parent and disposes pending work',async()=>{
  const h=host('main',true),api=createApi(h.window);
  const request=api.invoke('snapshot'),message=h.messages[0];
  h.receive({type:'flowhub:response',id:message.id,result:{spoofed:true}},{});
  h.receive({type:'flowhub:response',id:message.id,result:{at:42}});
  assert.deepEqual(await request,{at:42});
  const pending=api.invoke('snapshot');api.dispose();await assert.rejects(pending,/关闭/);
  await assert.rejects(api.invoke('snapshot'),/关闭/);
});

test('opaque sandbox contexts work without crypto.randomUUID',async()=>{
  const h=host('main',true);h.window.crypto={};const api=createApi(h.window);
  const request=api.invoke('snapshot'),message=h.messages[0];
  assert.ok(message.id.startsWith('resource-'));
  h.receive({type:'flowhub:response',id:message.id,result:{at:1}});
  assert.deepEqual(await request,{at:1});api.dispose();
});

test('widget handshake, token validation, preview gating, editor save and navigation',async()=>{
  const h=host('editor',true,'secret-token'),api=createApi(h.window);
  api.editor(()=>({sort:'cpu',limit:3}));api.ready();
  assert.equal(h.messages[0].type,'flowhub:widget-ready');assert.equal(api.preview,true);
  await assert.rejects(api.invoke('snapshot'),/未就绪/);
  await assert.rejects(api.status(),/未就绪/);
  h.receive({type:'flowhub:widget-init',token:'wrong',context:{preview:false}});
  assert.equal(api.preview,true);
  h.receive({type:'flowhub:widget-init',token:'secret-token',context:{preview:true}});
  await assert.rejects(api.invoke('terminate_confirm',{confirmed:true}),/预览/);
  h.receive({type:'flowhub:widget-save',token:'secret-token',id:'save-1'});
  assert.deepEqual(h.messages.at(-1).config,{sort:'cpu',limit:3});
  // Native detail windows intentionally omit preview:false in their context.
  h.receive({type:'flowhub:widget-init',token:'secret-token',context:{config:{}}});
  assert.equal(api.preview,false);
  const request=api.invoke('snapshot'),message=h.messages.at(-1);
  assert.equal(message.params.action,'management');assert.equal(message.params.method,'snapshot');
  h.receive({type:'flowhub:widget-result',token:'secret-token',id:message.id,result:{at:50}});
  assert.deepEqual(await request,{at:50});
  api.navigate('one-group');assert.deepEqual(h.messages.at(-1).selection,{groupId:'one-group'});
  api.dispose();
});
