// Live RPC smoke test. Only this script's dedicated sleep children may be terminated.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
import {once} from 'node:events';

const backend=spawn(new URL('../bin/flowhub-resource-monitor',import.meta.url).pathname,[],{stdio:['pipe','pipe','inherit']});
const pending=new Map();let sequence=0;
createInterface({input:backend.stdout}).on('line',line=>{
  const response=JSON.parse(line),item=pending.get(response.id);if(!item)return;
  pending.delete(response.id);clearTimeout(item.timer);response.error?item.reject(Error(response.error)):item.resolve(response.result);
});
function rpc(method,params={}){return new Promise((resolve,reject)=>{
  const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout'));},15000);
  pending.set(id,{resolve,reject,timer});backend.stdin.write(JSON.stringify({id,method,params})+'\n');
});}
const children=[];
try{
  assert.equal((await rpc('health')).protocol,2);
  let snapshot=await rpc('refresh');assert.ok(snapshot.groups.length);
  assert.equal(snapshot.memoryMetric,'footprint');assert.ok(snapshot.system.totalMemory>0);
  const all=snapshot.groups.flatMap(g=>g.processes);
  assert.equal(new Set(all.map(p=>p.pid)).size,all.length);
  assert.ok(all.find(p=>p.pid===backend.pid)?.protected);
  assert.ok(all.find(p=>p.pid===backend.pid)?.footprint>0);
  const status=await rpc('status_snapshot');assert.ok(status.rows.length);
  assert.equal(JSON.stringify(status).includes('/Users/'),false);
  const codex=snapshot.groups.find(g=>g.appPath?.endsWith('/Codex.app')||(g.appPath?.endsWith('/ChatGPT.app')&&g.processes.some(p=>p.executable.toLowerCase().includes('codex'))));
  if(codex){
    const marker='d57ca944-ef25-48d8-9464-2ef7f3037345';
    const child=spawn('/bin/sleep',['90'],{stdio:'ignore',env:{...process.env,CODEX_THREAD_ID:marker,FLOWHUB_TEST_SECRET:'do-not-export-this-environment-field'}});children.push(child);await once(child,'spawn');
    const contexts=await rpc('contexts',{groupId:codex.id});
    assert.equal(contexts.mapping,'process-linked');assert.equal(contexts.kind,'codex');
    assert.ok(contexts.entries.length<=200);
    assert.ok(contexts.entries.every(entry=>typeof entry.title==='string'&&Array.isArray(entry.processes)));
    assert.ok(contexts.entries.find(entry=>entry.id===marker)?.processes.some(id=>id.pid===child.pid),'dedicated child must link to its own thread marker');
    assert.equal(JSON.stringify(contexts).includes('do-not-export-this-environment-field'),false);
    await assert.rejects(rpc('open_context',{groupId:codex.id,token:'untrusted'}),/失效/);
    console.log('PASS: Codex thread marker linked a dedicated child without exporting other environment fields');
  }
  if(process.env.FLOWHUB_ARC_SMOKE==='1'){
    const arc=snapshot.groups.find(g=>g.appPath?.endsWith('/Arc.app'));
    assert.ok(arc,'Start Arc before the optional Arc integration smoke test');
    const contexts=await rpc('contexts',{groupId:arc.id});
    assert.equal(contexts.kind,'arc');assert.equal(contexts.mapping,'application-only');
    assert.ok(contexts.entries.length>0&&contexts.entries.length<=500);
    assert.ok(contexts.entries.every(row=>typeof row.title==='string'&&typeof row.token==='string'));
    console.log(`PASS: live Arc RPC returned ${contexts.entries.length} titles; no tab activation or URL recreation`);
  }
  if(process.env.FLOWHUB_ARC_TASKS_SMOKE==='1'){
    const arc=snapshot.groups.find(g=>g.appPath?.endsWith('/Arc.app'));
    assert.ok(arc,'Start Arc before its optional task table smoke test');
    const contexts=await rpc('arc_tasks',{groupId:arc.id,open:false});
    assert.equal(contexts.diagnostics?.state,'ready',contexts.diagnostics?.hint);
    assert.equal(contexts.mapping,'process-linked');
    const linked=contexts.entries.filter(row=>row.processes.length);
    assert.ok(linked.length>0,'Open Arc Task Manager with ordinary tabs and the Process ID column');
    console.log(`PASS: Arc task table linked ${linked.length} entries to verified process identities; no tab activation or permission changes`);
  }
  for(const force of [false,true]){
    const child=spawn('/bin/sleep',['90'],{stdio:'ignore'});children.push(child);await once(child,'spawn');
    const exit=once(child,'exit');
    snapshot=await rpc('refresh');const process=snapshot.groups.flatMap(g=>g.processes).find(p=>p.pid===child.pid);
    assert.ok(process&&!process.protected);assert.ok(process.memory>=0);
    const identity={pid:process.pid,started:process.started,executable:process.executable,uid:process.uid};
    await assert.rejects(rpc('terminate_preview',{identity:{...identity,started:identity.started+1},force}),/身份/);
    const plan=await rpc('terminate_preview',{identity,force:false});assert.equal(plan.targets.length,1);assert.equal(plan.targets[0].pid,child.pid);
    await assert.rejects(rpc('terminate_confirm',{token:plan.token}),/确认/);
    const result=await rpc('terminate_confirm',{token:plan.token,confirmed:true,force});assert.equal(result.results[0].sent,true);
    await exit;
    assert.equal(child.signalCode,force?'SIGKILL':'SIGTERM');
    await assert.rejects(rpc('terminate_confirm',{token:plan.token,confirmed:true}),/失效/);
  }
  console.log(`PASS: native footprint/RSS (${snapshot.groups.length} groups), private status cache, self protection, identity mismatch, confirmation, force upgrade and single-use tokens`);
}finally{
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
  backend.stdin.end();
}
