// Live read-only cache contract checks. Only this script's monitor is created/closed.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
const binary=process.argv[2]??new URL('../backend/target/debug/flowhub-resource-monitor',import.meta.url).pathname;
const backend=spawn(binary,[],{stdio:['pipe','pipe','inherit']}),pending=new Map();let sequence=0;
createInterface({input:backend.stdout}).on('line',line=>{const response=JSON.parse(line),item=pending.get(response.id);if(!item)return;pending.delete(response.id);clearTimeout(item.timer);response.error?item.reject(Error(response.error)):item.resolve(response.result);});
const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(`timeout: ${method}`));},15000);pending.set(id,{resolve,reject,timer});backend.stdin.write(JSON.stringify({id,method,params})+'\n');});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 let full=await rpc('refresh');
 const ranked=await rpc('ranking_snapshot',{includeSystem:false});
 assert.equal(ranked.groups.some(g=>'processes' in g||'instances' in g),false);
 assert.equal(ranked.groups.some(g=>g.system),false);
 for(const row of ranked.groups){const original=full.groups.find(g=>g.id===row.id);for(const key of ['memory','footprint','cpu','incomplete','footprintIncomplete','canTerminate'])assert.deepEqual(row[key],original[key]);assert.equal(row.processCount,original.processes.length);assert.equal(row.instanceCount,original.instances.length);}
 const group=full.groups.filter(g=>!g.system&&g.processes.length>1).toSorted((a,b)=>b.processes.length-a.processes.length)[0];
 const detail=await rpc('group_detail',{groupId:group.id});assert.deepEqual(detail.group,group);assert.equal(detail.groups,undefined);
 const queries=[group.name,...group.processes.slice(0,3).flatMap(p=>[p.name,p.displayName,p.executable,p.launchExecutable,p.cwd,p.parentName,String(p.pid),String(p.ppid),p.runtimeProject?.name,p.runtimeProject?.root,p.runtimeProject?.entry])].filter(Boolean);
 for(const query of queries){const result=await rpc('ranking_snapshot',{query,includeSystem:false});assert.ok(result.matchedGroupIds.includes(group.id),`missing query field: ${query}`);}
 let done=false;const refresh=rpc('refresh_summary',{includeSystem:false}).then(value=>{done=true;return value;});let concurrent=0,maxMs=0;
 for(let i=0;i<100&&!done;i++){const start=performance.now(),status=await rpc('status_snapshot');maxMs=Math.max(maxMs,performance.now()-start);if(status.sampling&&!done)concurrent++;await delay(2);}
 const refreshed=await refresh;assert.ok(concurrent>0,'cache reads must complete while a real refresh is sampling');assert.ok(refreshed.revision>ranked.revision);assert.equal(refreshed.sampling,false);
 const widget=await rpc('widget_api',{action:'management',method:'group_detail',params:{groupId:group.id}});assert.equal(widget.groupId,group.id);
 const privateStatus=JSON.stringify(await rpc('status_snapshot'));for(const field of ['"pid":','"started":','"cwd":','"executable":','"services":'])assert.equal(privateStatus.includes(field),false,field);
 console.log(JSON.stringify({result:'PASS',groups:full.groups.length,processes:full.groups.reduce((n,g)=>n+g.processes.length,0),fullBytes:Buffer.byteLength(JSON.stringify(full)),rankingBytes:Buffer.byteLength(JSON.stringify(ranked)),detailBytes:Buffer.byteLength(JSON.stringify(detail)),detailProcesses:detail.group.processes.length,readsDuringRealSample:concurrent,maxConcurrentStatusMs:+maxMs.toFixed(3)}));
}finally{backend.stdin.end();for(const item of pending.values())clearTimeout(item.timer);}
