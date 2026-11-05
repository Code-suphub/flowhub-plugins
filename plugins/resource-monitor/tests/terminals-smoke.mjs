// Disposable tmux server only: no existing sessions, SSH targets or user applications are changed.
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,realpathSync,existsSync,rmSync} from 'node:fs';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
const root=realpathSync(mkdtempSync('/tmp/flowhub-terminal-smoke-')),socket=root+'/server.sock';
const tmux=['/opt/homebrew/bin/tmux','/usr/local/bin/tmux','/usr/bin/tmux'].find(existsSync);
const pending=new Map();let backend,sequence=0;
function run(...args){return execFileSync(tmux,['-S',socket,'-f','/dev/null',...args],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();}
function rpc(method,params={}){return new Promise((resolve,reject)=>{
  const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout'));},15000);
  pending.set(id,{resolve,reject,timer});backend.stdin.write(JSON.stringify({id,method,params})+'\n');
});}
try{
  assert.ok(tmux,'install tmux before running this integration test');
  run('new-session','-d','-s','first','/bin/sleep','120');
  run('new-session','-d','-s','second','/bin/sleep','120');
  const server=Number(run('display-message','-p','#{pid}'));
  const panes=Object.fromEntries(run('list-panes','-a','-F','#{session_name}\t#{pane_pid}').split('\n').map(line=>line.split('\t')));
  const first=Number(panes.first),second=Number(panes.second);
  backend=spawn(new URL('../bin/flowhub-resource-monitor',import.meta.url).pathname,[],{stdio:['pipe','pipe','inherit']});
  createInterface({input:backend.stdout}).on('line',line=>{
    const result=JSON.parse(line),item=pending.get(result.id);if(!item)return;
    pending.delete(result.id);clearTimeout(item.timer);result.error?item.reject(Error(result.error)):item.resolve(result.result);
  });
  let snapshot,group;
  for(let attempt=0;attempt<30;attempt++){
    snapshot=await rpc('refresh');group=snapshot.groups.find(g=>g.processes.some(p=>p.pid===server));
    if([first,second].every(pid=>snapshot.groups.some(g=>g.processes.some(p=>p.pid===pid))))break;
    await new Promise(resolve=>setTimeout(resolve,75));
  }
  assert.equal(group?.name,'tmux');assert.equal(group.appPath,null);
  const firstGroup=snapshot.groups.find(g=>g.processes.some(p=>p.pid===first));
  const secondGroup=snapshot.groups.find(g=>g.processes.some(p=>p.pid===second));
  assert.notEqual(firstGroup.id,group.id);assert.notEqual(secondGroup.id,group.id);assert.notEqual(firstGroup.id,secondGroup.id);
  assert.equal(firstGroup.origin.name,'tmux');assert.equal(firstGroup.appPath,null);
  assert.ok(!group.processes.some(p=>[first,second].includes(p.pid)));
  const firstInstance=firstGroup.instances.find(i=>i.root.pid===first),secondInstance=secondGroup.instances.find(i=>i.root.pid===second);
  assert.ok(firstInstance&&secondInstance);assert.notEqual(firstInstance.id,secondInstance.id);
  const serverProcess=group.processes.find(p=>p.pid===server);
  assert.equal(serverProcess.protected,true);assert.match(serverProcess.protection,/tmux/);
  const identity=Object.fromEntries(['pid','started','executable','uid'].map(key=>[key,serverProcess[key]]));
  await assert.rejects(rpc('terminate_preview',{identity,force:false}),/不能结束/);
  await assert.rejects(rpc('quit_preview',{groupId:firstGroup.id}),/独立任务|应用|界面/);
  const plan=await rpc('terminate_preview',{groupId:firstGroup.id,instanceId:firstInstance.id,force:false});
  assert.deepEqual(plan.targets.map(p=>p.pid),[first]);
  assert.equal(plan.scope.root.pid,first);
  run('new-session','-d','-s','third','/bin/sleep','120');
  const third=Number(run('list-panes','-t','third','-F','#{pane_pid}'));
  const result=await rpc('terminate_confirm',{token:plan.token,confirmed:true});
  assert.deepEqual(result.results.map(p=>p.pid),[first]);assert.equal(result.results[0].sent,true);
  for(const pid of [server,second,third])process.kill(pid,0);
  await assert.rejects(rpc('terminate_confirm',{token:plan.token,confirmed:true}),/失效/);
  assert.ok(!JSON.stringify(await rpc('status_snapshot')).includes(socket));
  console.log('PASS: tmux is source-only, jobs excluded from manager scope, protected server, selected-pane stop and unaffected existing/new sessions');
}finally{
  backend?.stdin.end();for(const item of pending.values())clearTimeout(item.timer);
  if(tmux){try{run('kill-server');}catch{}}
  rmSync(root,{recursive:true,force:true});
}
