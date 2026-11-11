// Real read-only OS sampling with an isolated data directory. No windows,
// authorization dialogs, global input, signals or installed state are changed.
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const binary=resolve(process.argv[2]??new URL('../build/bin/flowhub-resource-monitor',import.meta.url).pathname);
const data=await mkdtemp(join(tmpdir(),'flowhub-resource-history-'));
const env={...process.env,FLOWHUB_PLUGIN_DATA:data};
let backend,pending,sequence=0;
const delay=ms=>new Promise(done=>setTimeout(done,ms));
function start(){
 backend=spawn(binary,[],{env,stdio:['pipe','pipe','inherit']});pending=new Map();
 createInterface({input:backend.stdout}).on('line',line=>{const response=JSON.parse(line),item=pending.get(response.id);if(!item)return;pending.delete(response.id);clearTimeout(item.timer);response.error?item.reject(Error(response.error)):item.resolve(response.result);});
}
async function stop(){const child=backend;if(!child||child.exitCode!==null)return;const done=new Promise(resolve=>child.once('exit',resolve));child.stdin.end();await done;}
const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(`timeout: ${method}`));},20000);pending.set(id,{resolve,reject,timer});backend.stdin.write(JSON.stringify({id,method,params})+'\n');});
const cli=(...args)=>JSON.parse(execFileSync(binary,['--cli','history',...args,'--data',data],{env,encoding:'utf8'})).result;
try{
 start();let first;for(let i=0;i<200;i++){first=await rpc('snapshot');if(first.at)break;await delay(50);}const group=first.groups.find(g=>!g.system&&g.processes.length&&g.memory!=null&&g.footprint!=null);assert.ok(group);
 let saved;for(let i=0;i<100;i++){saved=await rpc('resource_history',{groupId:group.id});if(saved.points.length)break;await delay(20);}assert.ok(saved.points.length);
 assert.equal(saved.hours,48);assert.equal(saved.intervalSeconds,60);const initial=saved.points[0];assert.equal(initial.at,first.at);
 assert.equal(initial.footprint,group.footprint);assert.equal(initial.rss,group.memory);assert.equal(initial.cpu,group.processes.every(p=>p.cpu!=null)?group.cpu:null);
 const seven=await rpc('resource_history_settings',{groupId:group.id,hours:168});assert.equal(seven.hours,168);
 // This process opens no page. Only the five-second background collector runs.
 const deadline=Date.now()+75000;
 let status;while(Date.now()<deadline){status=cli('status');if(status.lastSampleAt>initial.at)break;await delay(1000);}
 assert.ok(status.lastSampleAt>initial.at,'no new minute sample while UI is closed');
 const key=createHash('sha256').update(group.id).digest('hex');const collected=cli('show',key);assert.ok(collected.points.length>=2);assert.ok(collected.points.every(p=>['cpu','footprint','rss'].every(k=>Object.hasOwn(p,k))));
 const timings=[];
 for(let i=0;i<20;i++){const begin=performance.now();await rpc('ranking_snapshot',{includeSystem:true});timings.push(performance.now()-begin);await rpc('resource_history',{groupId:group.id});}
 await stop();const persisted=cli('show',key);assert.deepEqual(persisted.points,collected.points);assert.equal(cli('status').hours,168);
 start();const restored=await rpc('resource_history',{groupId:group.id});assert.equal(restored.hours,168);for(const point of persisted.points)assert.ok(restored.points.some(p=>JSON.stringify(p)===JSON.stringify(point)));
 const widget=await rpc('widget_api',{action:'management',method:'resource_history',params:{groupId:group.id}});assert.equal(widget.groupId,group.id);
 const reset=await rpc('widget_api',{action:'management',method:'resource_history_settings',params:{groupId:group.id,hours:48}});assert.equal(reset.hours,48);
 const absent=await rpc('resource_history',{groupId:'public-test-nonexistent'});assert.deepEqual(absent.points,[]);
 console.log(JSON.stringify({result:'PASS',version:'0.5.0',driver:'isolated real backend RPC + persisted read-only CLI',openedPage:false,initialSampleAt:initial.at,lastSampleAt:status.lastSampleAt,recordedSamples:collected.points.length,metrics:['cpu','footprint','rss'],retentionRestart:true,retentionReset:48,widgetTransport:true,emptyGroup:true,maxRankingMs:Math.max(...timings),databaseBytes:(await stat(join(data,'history/resource-history.sqlite3'))).size},null,2));
}finally{await stop();for(const item of pending?.values()??[])clearTimeout(item.timer);await rm(data,{recursive:true,force:true});}
