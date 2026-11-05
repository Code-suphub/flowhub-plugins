// Read-only benchmark. Each run launches and closes only its own monitor backend.
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {performance} from 'node:perf_hooks';
const binary=process.argv[2]??new URL('../backend/target/debug/flowhub-resource-monitor',import.meta.url).pathname;
const pollMs=Number(process.argv[3]??5000),durationMs=Number(process.argv[4]??15500);
const backend=spawn(binary,[],{stdio:['pipe','pipe','inherit']}),pending=new Map();let sequence=0;
createInterface({input:backend.stdout}).on('line',line=>{const response=JSON.parse(line),item=pending.get(response.id);if(!item)return;pending.delete(response.id);clearTimeout(item.timer);response.error?item.reject(Error(response.error)):item.resolve(response.result);});
const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(`timeout: ${method}`));},20000);pending.set(id,{resolve,reject,timer});backend.stdin.write(JSON.stringify({id,method,params})+'\n');});
const median=items=>items.toSorted((a,b)=>a-b)[Math.floor(items.length/2)];
async function measure(method,params={}){const times=[],sizes=[];for(let i=0;i<9;i++){const start=performance.now(),result=await rpc(method,params);times.push(performance.now()-start);sizes.push(Buffer.byteLength(JSON.stringify(result)));}return {medianMs:+median(times).toFixed(3),maxMs:+Math.max(...times).toFixed(3),bytes:median(sizes)};}
function usage(){const text=execFileSync('/bin/ps',['-p',String(backend.pid),'-o','rss=,time='],{encoding:'utf8'}).trim();const [rss,time]=text.split(/\s+/),parts=time.split(':');return {rssKiB:Number(rss),cpuSeconds:Number(parts[0])*60+Number(parts[1])};}
try{
 const refresh=[];let snapshot;for(let i=0;i<5;i++){const start=performance.now();snapshot=await rpc('refresh');refresh.push(performance.now()-start);}
 const methods={status:await measure('status_snapshot'),full:await measure('snapshot')};
 try{methods.ranking=await measure('ranking_snapshot',{includeSystem:false});methods.search=await measure('ranking_snapshot',{query:'node',includeSystem:false});methods.detail=await measure('group_detail',{groupId:snapshot.groups.find(g=>g.processes.length>1)?.id??snapshot.groups[0].id});}catch(error){if(!String(error).includes('未知插件方法'))throw error;}
 const start=usage(),at=performance.now();const stop=at+durationMs;let polls=0;
 while(performance.now()<stop){await rpc(methods.ranking?'ranking_snapshot':'snapshot',{includeSystem:false});polls++;await new Promise(resolve=>setTimeout(resolve,Math.max(0,Math.min(pollMs,stop-performance.now()))));}
 const end=usage();console.log(JSON.stringify({binary,processes:snapshot.groups.reduce((n,g)=>n+g.processes.length,0),groups:snapshot.groups.length,refreshMedianMs:+median(refresh).toFixed(3),refreshMs:refresh.map(v=>+v.toFixed(3)),methods,usage:{durationSeconds:+((performance.now()-at)/1000).toFixed(2),pollIntervalMs:pollMs,polls,cpuSeconds:+(end.cpuSeconds-start.cpuSeconds).toFixed(3),rssKiB:end.rssKiB}},null,2));
}finally{backend.stdin.end();for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('closed'));}}
