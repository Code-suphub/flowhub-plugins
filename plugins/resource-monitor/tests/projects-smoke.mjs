// Stop only disposable fixtures. Never signal existing applications or project services.
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,realpathSync,rmSync} from 'node:fs';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
const root=realpathSync(mkdtempSync('/tmp/flowhub-node-project-'));
const project=root+'/project',other=root+'/other',entry=project+'/index.mjs',dependency=project+'/node_modules/dependency/worker.js';
const children=[],pending=new Map();let backend,sequence=0;
function rpc(method,params={}){return new Promise((resolve,reject)=>{
  const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout'));},15000);
  pending.set(id,{resolve,reject,timer});backend.stdin.write(JSON.stringify({id,method,params})+'\n');
});}
const delay=()=>new Promise(resolve=>setTimeout(resolve,60));
async function ready(label,count=1){for(let i=0;i<60;i++){
  const path=project+'/ready-'+label;
  if(existsSync(path)){try{const pids=JSON.parse(readFileSync(path,'utf8'));if(pids.length===count)return pids;}catch{}}
  await delay();
}throw Error('fixture not ready: '+label);}
try{
  mkdirSync(project+'/node_modules/dependency',{recursive:true});mkdirSync(other);
  writeFileSync(project+'/package.json',JSON.stringify({name:'flowhub-project-fixture'}));
  writeFileSync(other+'/package.json',JSON.stringify({name:'unrelated-working-directory'}));
  writeFileSync(dependency,'setInterval(()=>{},1000);');
  writeFileSync(entry,`import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
const workers=[],label=process.argv[2];
function worker(){workers.push(spawn(process.execPath,[${JSON.stringify(dependency)}],{cwd:${JSON.stringify(project)},stdio:'ignore'}));writeFileSync(${JSON.stringify(project)}+'/ready-'+label,JSON.stringify(workers.map(child=>child.pid)));}
process.on('message',message=>{if(message==='extra-worker')worker();});
process.on('SIGTERM',()=>{for(const child of workers)child.kill('SIGTERM');process.exit(0);});
worker();setInterval(()=>{},1000);
`);
  const launch=(label,cwd)=>{const child=spawn(process.execPath,[entry,label,'--token','private-fixture-token'],{cwd,stdio:['ignore','ignore','ignore','ipc']});children.push(child);return child;};
  const first=launch('first',other),second=launch('second',project);
  const [firstWorkers,secondWorkers]=await Promise.all([ready('first'),ready('second')]);
  const inferred=spawn(process.execPath,['-e','setInterval(()=>{},1000); // private-inline-code'],{cwd:project,stdio:'ignore'});children.push(inferred);
  backend=spawn(new URL('../bin/flowhub-resource-monitor',import.meta.url).pathname,[],{stdio:['pipe','pipe','inherit']});
  createInterface({input:backend.stdout}).on('line',line=>{
    const result=JSON.parse(line),item=pending.get(result.id);if(!item)return;
    pending.delete(result.id);clearTimeout(item.timer);result.error?item.reject(Error(result.error)):item.resolve(result.result);
  });
  let snapshot,group;
  async function refresh(){snapshot=await rpc('refresh');group=snapshot.groups.find(g=>g.processes.some(p=>p.pid===second.pid));return group;}
  for(let attempt=0;attempt<30;attempt++){await refresh();if(group?.processes.length===5&&group.instances.length===3)break;await delay();}
  assert.equal(group?.name,'flowhub-project-fixture');assert.equal(group.appPath,null);assert.equal(group.instances.length,3);
  assert.equal(group.canTerminate,false,'project aggregate cannot offer a bulk stop');
  const instance=group.instances.find(instance=>instance.root.pid===first.pid);
  const firstPids=[first.pid,...firstWorkers].sort((a,b)=>a-b);
  assert.deepEqual(group.processes.filter(p=>p.instanceId===instance.id).map(p=>p.pid).sort((a,b)=>a-b),firstPids);
  const tool=group.processes.find(p=>p.pid===first.pid);assert.equal(tool.name,'node');
  assert.equal(tool.cwd,other);assert.equal(tool.runtimeProject.root,project);assert.equal(tool.runtimeProject.entry,entry);
  const inferredProcess=group.processes.find(p=>p.pid===inferred.pid);assert.equal(inferredProcess.runtimeProject.entry,null);assert.equal(inferredProcess.runtimeProject.evidence,'工作目录推断');
  const full=JSON.stringify(snapshot);assert.ok(!full.includes('private-fixture-token'));assert.ok(!full.includes('private-inline-code'));
  const status=await rpc('status_snapshot'),row=status.rows.find(row=>row.id===group.id);
  assert.equal(row.instanceCount,3);assert.ok(!JSON.stringify(status).includes(project));assert.ok(!JSON.stringify(status).includes('instances'));
  for(const force of [false,true])await assert.rejects(rpc('terminate_preview',{groupId:group.id,force}),/多个.*实例/);
  await assert.rejects(rpc('terminate_preview',{groupId:group.id,instanceId:'forged',force:false}),/实例.*变化|实例.*退出/);
  const stale=await rpc('terminate_preview',{groupId:group.id,instanceId:instance.id,force:false});
  first.send('extra-worker');const expanded=await ready('first',2);
  await assert.rejects(rpc('terminate_confirm',{token:stale.token,confirmed:true}),/集合|身份/);
  for(const pid of [first.pid,second.pid,...secondWorkers])process.kill(pid,0);
  const plan=await rpc('terminate_preview',{groupId:group.id,instanceId:instance.id,force:false});
  const selected=[first.pid,...expanded].sort((a,b)=>a-b);
  assert.equal(plan.scope.kind,'instance');assert.equal(plan.scope.root.pid,first.pid);
  assert.deepEqual(plan.targets.map(p=>p.pid).sort((a,b)=>a-b),selected);
  // A new parallel launch after preview must never expand the selected target set.
  const third=launch('third',project),thirdWorkers=await ready('third');
  await assert.rejects(rpc('terminate_confirm',{token:plan.token}),/确认/);
  const result=await rpc('terminate_confirm',{token:plan.token,confirmed:true});
  assert.deepEqual(result.results.map(p=>p.pid).sort((a,b)=>a-b),selected);
  assert.ok(result.results.every(p=>!p.error),JSON.stringify(result.results));
  for(let attempt=0;attempt<50;attempt++){await refresh();if(!snapshot.groups.flatMap(g=>g.processes).some(p=>selected.includes(p.pid)))break;await delay();}
  assert.ok(!snapshot.groups.flatMap(g=>g.processes).some(p=>selected.includes(p.pid)),'selected tree must exit');
  for(const pid of [second.pid,...secondWorkers,inferred.pid,third.pid,...thirdWorkers])process.kill(pid,0);
  assert.ok(!group.instances.some(item=>item.id===instance.id));
  await assert.rejects(rpc('terminate_confirm',{token:plan.token,confirmed:true}),/失效/);
  const batchIds=group.instances.filter(item=>[second.pid,inferred.pid].includes(item.root.pid)).map(item=>item.id);
  assert.equal(batchIds.length,2);
  const batch=await rpc('terminate_preview',{groupId:group.id,instanceIds:batchIds,force:false});
  assert.equal(batch.scope.kind,'instances');assert.equal(batch.scope.instances.length,2);
  const batchPids=[second.pid,...secondWorkers,inferred.pid].sort((a,b)=>a-b);
  assert.deepEqual(batch.targets.map(p=>p.pid).sort((a,b)=>a-b),batchPids);
  const fourth=launch('fourth',project),fourthWorkers=await ready('fourth');
  const stopped=await rpc('terminate_confirm',{token:batch.token,confirmed:true});
  assert.deepEqual(stopped.results.map(p=>p.pid).sort((a,b)=>a-b),batchPids);
  assert.ok(stopped.results.every(p=>!p.error),JSON.stringify(stopped.results));
  for(const pid of [third.pid,...thirdWorkers,fourth.pid,...fourthWorkers])process.kill(pid,0);
  const script=spawn('/usr/bin/osascript',['-e','delay 90'],{cwd:root,stdio:'ignore'});children.push(script);
  await new Promise((resolve,reject)=>{script.once('spawn',resolve);script.once('error',reject);});
  await refresh();const activity=await rpc('script_activity');
  const record=activity.records.find(item=>item.process.pid===script.pid);
  assert.ok(record?.running,'live script activity must be sampled');
  assert.ok(record.chain.some(item=>item.pid===script.pid));
  assert.equal(record.process.executable,'/usr/bin/osascript');
  script.kill('SIGTERM');await new Promise(resolve=>script.once('exit',resolve));
  await refresh();const recent=(await rpc('script_activity')).records.find(item=>item.id===record.id);
  assert.equal(recent.running,false,'recent script record must survive exit');
  console.log('PASS: explicit batch stop excludes later launches; script activity keeps its observed chain after exit');
  console.log('PASS: same-project independent instances, aggregate rejection, exact tree stop, changed-child rejection, new parallel launch isolation, confirmation/token validation and private status');
}finally{
  backend?.stdin.end();for(const item of pending.values())clearTimeout(item.timer);
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
  // Each root fixture handles SIGTERM and stops only the workers it created.
  await new Promise(resolve=>setTimeout(resolve,150));
  rmSync(root,{recursive:true,force:true});
}
