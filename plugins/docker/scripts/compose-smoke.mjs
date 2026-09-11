import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
const project=`flowhub-widget-smoke-${process.pid}`;
const compose=['compose','-p',project,'-f','tests/compose-smoke.yaml'];
const docker=args=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
let child;const pending=new Map();let serial=0;
function call(params){return new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout'));},115000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method:'widget_api',params})+'\n');});}
try{
  docker([...compose,'up','-d','--no-build','--pull','never']);
  child=spawn('./bin/flowhub-docker',[],{stdio:['pipe','pipe','inherit']});
  createInterface({input:child.stdout}).on('line',line=>{const r=JSON.parse(line),p=pending.get(r.id);if(p){clearTimeout(p.timer);pending.delete(r.id);r.error?p.reject(Error(r.error)):p.resolve(r.result);}});
  const context=docker(['context','show']).trim(),scope={scope:'project',project,context};
  let plan=await call({action:'stop_preview',...scope});assert.equal(plan.targets.length,2);
  await assert.rejects(call({action:'stop_confirm',...scope,ids:[],confirmed:true}),/已变化/);
  const single={scope:'container',id:plan.targets[0].id,context};
  const one=await call({action:'stop_preview',...single});
  const singleResult=await call({action:'stop_confirm',...single,ids:one.targets.map(t=>t.id),confirmed:true});assert.equal(singleResult.results[0].stopped,true);
  docker([...compose,'start']);
  plan=await call({action:'stop_preview',...scope});assert.equal(plan.targets.length,2);
  const response=await call({action:'stop_confirm',...scope,ids:plan.targets.map(t=>t.id),confirmed:true});
  assert.equal(response.results.length,2);assert.ok(response.results.every(r=>r.stopped));
  const after=docker([...compose,'ps','--status','running','-q']).trim();assert.equal(after,'');
  console.log('PASS: real Compose single stop, whole-project stop, changed-target rejection and post-stop verification');
}finally{child?.kill();for(const p of pending.values())clearTimeout(p.timer);docker([...compose,'down','--volumes','--remove-orphans']);}
