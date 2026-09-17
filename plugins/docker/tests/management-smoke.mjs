import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
const name=`flowhub-management-test-${process.pid}`,tag=`${name}:one`,alias=`${name}:two`,volume=`${name}-data`;
const docker=(args,input)=>execFileSync('docker',args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
let child,cid,iid;const pending=new Map();let serial=0;
function call(method,params){return new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout'));},120000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method:'widget_api',params:{action:'management',method,params}})+'\n');});}
try{
  // A new empty image, with no downloads or dependency on business images.
  const tar=execFileSync('tar',['-cf','-','-T','/dev/null']);iid=docker(['image','import','-',tag],tar);
  docker(['image','tag',iid,alias]);
  cid=docker(['container','create','--name',name,'--mount',`type=volume,src=${volume},dst=/data`,tag,'/unused']);
  child=spawn('./bin/flowhub-docker',[],{stdio:['pipe','pipe','inherit']});
  createInterface({input:child.stdout}).on('line',line=>{const r=JSON.parse(line),p=pending.get(r.id);if(!p)return;clearTimeout(p.timer);pending.delete(r.id);r.error?p.reject(Error(r.error)):p.resolve(r.result);});
  const context=docker(['context','show']);
  const list=await call('images',{context});assert.ok(list.images.some(i=>i.ID===iid));
  const detail=await call('image_detail',{id:iid,context});assert.ok(detail.containers.some(c=>c.id===cid));
  await assert.rejects(call('container_remove',{id:cid,context}),/确认/);
  await assert.rejects(call('container_remove',{id:cid,context:'wrong',confirmed:true}),/环境/);
  await assert.rejects(call('image_remove',{id:iid,reference:tag,context,confirmed:true}),/引用/);
  await call('container_remove',{id:cid,context,confirmed:true});
  assert.equal(docker(['ps','-a','--filter',`name=^${name}$`,'-q']),'');cid=null;
  assert.equal(docker(['volume','inspect','--format','{{.Name}}',volume]),volume);
  await assert.rejects(call('image_remove',{id:iid,reference:'unrelated:latest',context,confirmed:true}),/标签/);
  await call('image_remove',{id:iid,reference:tag,context,confirmed:true});
  assert.equal(docker(['image','inspect','--format','{{.Id}}',alias]),iid);
  await call('image_remove',{id:iid,reference:alias,context,confirmed:true});iid=null;
  assert.equal(docker(['image','ls','--filter',`reference=${name}:*`,'-q']),'');
  console.log('PASS: widget management RPC, exact object detail, guarded container deletion, preserved volume, used-image refusal and per-tag image removal');
}finally{
  child?.kill();for(const p of pending.values())clearTimeout(p.timer);
  if(cid)docker(['container','rm',cid]);
  if(iid){for(const ref of [tag,alias]){try{docker(['image','rm','--no-prune',ref]);}catch{}}}
  try{docker(['volume','rm',volume]);}catch{}
}
