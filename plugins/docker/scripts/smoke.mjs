import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';

// Explicitly supplied, dedicated disposable container only. Never select an
// arbitrary existing container for a mutation test.
const cid=process.argv[2];
assert.match(cid||'',/^[a-f0-9]{64}$/);
const child=spawn('./bin/flowhub-docker',[],{stdio:['pipe','pipe','inherit']});
const pending=new Map();let sequence=0;
createInterface({input:child.stdout}).on('line',line=>{const r=JSON.parse(line),p=pending.get(r.id);if(!p)return;pending.delete(r.id);clearTimeout(p.timer);r.error?p.reject(Error(r.error)):p.resolve(r.result);});
function call(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout'));},115000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});}
try {
  assert.equal((await call('health')).protocol,2);
  const list=await call('list'),c=list.containers.find(c=>c.id===cid);
  assert.ok(c?.name.startsWith('flowhub-docker-smoke-'));
  assert.equal(c.project,'flowhub-plugin-test');
  assert.ok((await call('logs',{id:cid})).text.includes('FLOWHUB_PLUGIN_SMOKE_READY'));
  await assert.rejects(call('operate',{id:cid,action:'stop',context:list.context}),/确认/);
  await assert.rejects(call('operate',{id:cid,action:'rm',confirmed:true,context:list.context}),/不支持/);
  await assert.rejects(call('operate',{id:cid,action:'stop',confirmed:true,context:'wrong-context'}),/环境已变化/);
  for(const action of ['restart','stop','start']){
    await call('operate',{id:cid,action,confirmed:true,context:list.context});
    const detail=await call('detail',{id:cid});
    assert.equal(detail.state,action==='stop'?'exited':'running');
  }
  console.log('PASS: real Docker grouping, logs, detail/stats, confirmation, context guard, restart/stop/start');
} finally {child.stdin.end();child.kill();}
