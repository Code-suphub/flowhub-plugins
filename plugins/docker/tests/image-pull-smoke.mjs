import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const directory=mkdtempSync('/tmp/flowhub-pull-rpc-'),socket=directory+'/engine.sock',context='flowhub-pull-test',imageId='sha256:'+'d'.repeat(64);
let child,ui,serial=0,pulls=0,images=[],timers=new Set();const pending=new Map(),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function later(action,ms){const timer=setTimeout(()=>{timers.delete(timer);action();},ms);timers.add(timer);}
const engine=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture'),route=decodeURIComponent(url.pathname.replace(/^\/v\d+\.\d+/,''));res.setHeader('Api-Version','1.47');res.setHeader('OSType','linux');res.setHeader('Docker-Experimental','false');
 if(route==='/_ping'){res.end('OK');return;}res.setHeader('Content-Type','application/json');
 if(route==='/containers/json'){res.end('[]');return;}
 if(route==='/images/json'){res.end(JSON.stringify(images));return;}
 if(route.startsWith('/images/')&&route.endsWith('/json')){res.end(JSON.stringify({Id:imageId,RepoTags:['nginx:stable'],RepoDigests:[],Created:'2026-11-06T00:00:00Z',Size:2048,Os:'linux',Architecture:'arm64'}));return;}
 if(route==='/images/create' && req.method==='POST'){
  pulls++;const name=url.searchParams.get('fromImage');
  if(name?.includes('deny')){res.statusCode=403;res.end(JSON.stringify({message:'denied: PRIVATE_FIXTURE_TOKEN'}));return;}
  const frame=value=>{if(!res.destroyed)res.write(JSON.stringify(value)+'\n');};
  frame({status:'Pulling fs layer',id:'aaaaaaaaaaaa'});later(()=>frame({status:'Downloading',id:'aaaaaaaaaaaa',progressDetail:{current:1024,total:2048},progress:'[====> ] 1KB/2KB'}),80);
  later(()=>{frame({status:'Pull complete',id:'aaaaaaaaaaaa'});frame({status:'Status: Downloaded newer image'});images=[{Id:imageId,RepoTags:['nginx:stable'],RepoDigests:[],Created:1793923200,Size:2048,Containers:0}];res.end();},name?.includes('slow')?10000:700);return;
 }
 res.statusCode=500;res.end(JSON.stringify({message:'Unexpected fixture request '+req.method+' '+route}));
});
function call(method,params={}){return new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout'));},15000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});}
async function finished(job){for(let attempt=0;attempt<100;attempt++){const result=await call('image_pull_status',{context,id:job.id});if(result.job.state!=='running')return result.job;await delay(40);}throw Error('Pull did not finish');}
try{
 await new Promise(resolve=>engine.listen(socket,resolve));execFileSync('docker',['--config',directory,'context','create',context,'--docker','host=unix://'+socket],{stdio:'pipe'});execFileSync('docker',['--config',directory,'context','use',context],{stdio:'pipe'});
 child=spawn('./bin/flowhub-docker',[],{env:{...process.env,DOCKER_CONFIG:directory},stdio:['pipe','pipe','inherit']});createInterface({input:child.stdout}).on('line',line=>{const response=JSON.parse(line),item=pending.get(response.id);if(!item)return;clearTimeout(item.timer);pending.delete(response.id);response.error?item.reject(Error(response.error)):item.resolve(response.result);});
 if(process.argv.includes('--serve')){
  const base=fileURLToPath(new URL('../build/',import.meta.url));const host=`<!doctype html><meta charset="utf-8"><title>Docker 拉取隔离验收</title><style>body{margin:0}iframe{display:block;width:100%;height:100dvh;border:0}</style><iframe title="Docker 插件" src="/ui/index.html"></iframe><script>const frame=document.querySelector('iframe');addEventListener('message',async event=>{if(event.source!==frame.contentWindow||event.data?.type!=='flowhub:request')return;const{id,method,params}=event.data;const reply=await fetch('/rpc',{method:'POST',body:JSON.stringify({method,params})}).then(r=>r.json());frame.contentWindow.postMessage({type:'flowhub:response',id,...reply},location.origin);});</script>`;
  ui=createServer(async(req,res)=>{const url=new URL(req.url,'http://fixture');if(url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(host);return;}if(url.pathname==='/rpc'&&req.method==='POST'){let body='';for await(const chunk of req){body+=chunk;if(body.length>20000){res.writeHead(413).end();return;}}try{const {method,params}=JSON.parse(body);if(!['list','images','image_detail','image_pull_start','image_pull_status','image_pull_cancel'].includes(method))throw Error('隔离验证不执行此操作');res.end(JSON.stringify({result:await call(method,params)}));}catch(error){res.end(JSON.stringify({error:error.message}));}return;}const file=path.resolve(base,'.'+url.pathname);if(!file.startsWith(base)){res.writeHead(403).end();return;}try{const bytes=readFileSync(file);res.writeHead(200,{'Content-Type':{'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css'}[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'}).end(bytes);}catch{res.writeHead(404).end();}});
  await new Promise(resolve=>ui.listen(5205,'127.0.0.1',resolve));console.log('Isolated pull UI ready on 5205');await new Promise(resolve=>process.once('SIGINT',resolve));
 }else{
  await assert.rejects(call('image_pull_start',{context,reference:'nginx:stable'}),/确认/);await assert.rejects(call('image_pull_start',{context,reference:'--all-tags',confirmed:true}),/标签|名称/);await assert.rejects(call('image_pull_start',{context:'wrong',reference:'nginx:stable',confirmed:true}),/环境/);assert.equal(pulls,0);
  const {job}=await call('image_pull_start',{context,reference:'nginx:stable',platform:'linux/arm64',confirmed:true});assert.equal(job.state,'running');assert.equal((await call('health')).protocol,2);await assert.rejects(call('image_pull_start',{context,reference:'other:latest',confirmed:true}),/已有/);
  await delay(180);const progress=await call('image_pull_status',{context,id:job.id});assert.ok(progress.job.layers.some(layer=>layer.status.includes('下载')));const result=await finished(job);assert.equal(result.state,'succeeded');assert.equal(result.imageId,imageId);assert.equal(pulls,1);
  const denied=await call('image_pull_start',{context,reference:'deny:latest',confirmed:true});const deniedResult=await finished(denied.job);assert.equal(deniedResult.state,'failed');assert.match(deniedResult.error,/拒绝访问/);assert.ok(!JSON.stringify(deniedResult).includes('PRIVATE_FIXTURE_TOKEN'));
  const slow=await call('image_pull_start',{context,reference:'slow:latest',confirmed:true});await assert.rejects(call('image_pull_cancel',{context,id:slow.job.id}),/确认/);await assert.rejects(call('image_pull_cancel',{context:'wrong',id:slow.job.id,confirmed:true}),/环境/);await call('image_pull_cancel',{context,id:slow.job.id,confirmed:true});assert.equal((await finished(slow.job)).state,'cancelled');
  console.log('PASS: real Docker CLI + isolated engine: explicit reference/platform/context/confirmation, background health response, duplicate guard, streamed layer progress, inspect verification, credential-safe failure and targeted cancellation');
 }
}finally{if(ui){ui.closeAllConnections();await new Promise(resolve=>ui.close(resolve));}child?.kill();for(const timer of timers)clearTimeout(timer);for(const item of pending.values())clearTimeout(item.timer);engine.closeAllConnections();await new Promise(resolve=>engine.close(resolve));rmSync(directory,{recursive:true,force:true});}
