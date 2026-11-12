import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'vite';
import {createLayoutWatcher,plasmicAutoSync} from '../scripts/plasmic-watch.mjs';
import {codegenFiles,projectId} from '../scripts/plasmic-sync.mjs';

function fixture(overrides={}){
 let local={revision:1,files:{'layout.css':'original'}},remote=1,syncs=0,updates=0;
 const states=[],delays=[];
 const watcher=createLayoutWatcher({
  readLocal:async()=>local,readRevision:async()=>remote,
  sync:async revision=>{syncs++;local={revision,files:{'layout.css':`revision-${revision}`}};},
  onUpdated:()=>{updates++;},onStatus:state=>states.push(state),
  intervalMs:20,maxRetryMs:80,setTimer:(_fn,delay)=>{delays.push(delay);return 1;},clearTimer(){},
  ...overrides
 });
 return {watcher,states,delays,setRemote:value=>{remote=value;},setLocal:value=>{local=value;},counts:()=>({syncs,updates})};
}

test('unchanged saved revisions never request codegen or refresh; changed or manually synced files refresh once',async()=>{
 const f=fixture();
 try{
  await f.watcher.start();await f.watcher.check();
  assert.deepEqual(f.counts(),{syncs:0,updates:0});
  f.setRemote(2);await f.watcher.check();await f.watcher.check();
  assert.deepEqual(f.counts(),{syncs:1,updates:1});
  assert.equal(f.watcher.getStatus().revision,2);
  f.setRemote(3);f.setLocal({revision:3,files:{'layout.css':'manual-sync'}});
  await f.watcher.check();assert.deepEqual(f.counts(),{syncs:1,updates:2});
 }finally{await f.watcher.stop();}
});

test('requests remain serial, failures back off without exposing errors and recover automatically',async()=>{
 let fail=true,checks=0,resolve;
 const f=fixture({readRevision:async()=>{checks++;if(fail)throw Error('secret-token-do-not-expose');return new Promise(done=>{resolve=done;});}});
 try{
  for(let i=0;i<4;i++)await f.watcher.check();
  assert.deepEqual(f.delays,[20,40,80,80]);
  assert.doesNotMatch(JSON.stringify(f.states),/secret-token/);
  fail=false;
  const first=f.watcher.check(),second=f.watcher.check();
  assert.equal(first,second);
  await new Promise(done=>setImmediate(done));
  resolve(2);await first;
  assert.equal(checks,5);assert.equal(f.watcher.getStatus().phase,'ready');
  assert.equal(f.watcher.getStatus().nextCheckMs,20);assert.equal(f.watcher.getStatus().error,null);
 }finally{await f.watcher.stop();}
});

test('closing the developer server aborts an in-flight request and sends no later refresh',async()=>{
 let signal;
 const f=fixture({readRevision:value=>{signal=value;return new Promise((_resolve,reject)=>value.addEventListener('abort',()=>reject(value.reason),{once:true}));}});
 const pending=f.watcher.start();await new Promise(done=>setImmediate(done));
 await f.watcher.stop();await pending;
 assert.equal(signal.aborted,true);assert.deepEqual(f.counts(),{syncs:0,updates:0});
 assert.equal(f.delays.length,0);assert.ok(f.states.every(state=>state.phase!=='error'));
});

test('a failed preview refresh is retried while preserving the confirmed layout',async()=>{
 let refreshes=0;
 const f=fixture({onUpdated:()=>{if(++refreshes===1)throw Error('temporary refresh failure');}});
 try{
  await f.watcher.start();f.setRemote(2);await f.watcher.check();
  assert.equal(f.watcher.getStatus().phase,'error');
  await f.watcher.check();assert.equal(refreshes,2);
  assert.equal(f.watcher.getStatus().phase,'ready');assert.equal(f.counts().syncs,1);
 }finally{await f.watcher.stop();}
});

test('Vite auto-sync changes the managed files, exposes only read-only safe status and refreshes the standalone preview',async t=>{
 const root=await mkdtemp(join(tmpdir(),'flowhub-plasmic-dev-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'src/plasmic'),{recursive:true});await mkdir(join(root,'design/plasmic'),{recursive:true});
 const config={projectId,componentName:'ResourceMonitorCardLayout',bindings:['header','alerts','list','footer']};
 const bundle={projectConfig:{projectId,revision:1,cssFileName:'plasmic.css',cssRules:'.root{}'},components:[{
  componentName:config.componentName,renderModuleFileName:'Card.tsx',cssFileName:'Card.module.css',cssRules:'.root{padding:12px}',
  renderModule:['Header','Alerts','List','Footer'].map(name=>`import ${name} from "./ResourceCard${name}Region";\n<div data-plasmic-name={"${name.toLowerCase()}"}/>`).join('\n')
 }]};
 const files=codegenFiles(bundle,config);
 for(const [name,body]of files)await writeFile(join(root,'src/plasmic',name),body);
 await writeFile(join(root,'src/plasmic/generated.json'),JSON.stringify({schema:1,projectId,component:config.componentName,revision:1,files:Object.fromEntries([...files].map(([name,body])=>[name,createHash('sha256').update(body).digest('hex')]))}));
 await writeFile(join(root,'design/plasmic/card-layout.json'),JSON.stringify(config));
 const authFile=join(root,'private-auth.json');await writeFile(authFile,JSON.stringify({host:'https://studio.plasmic.app',user:'fixture-user',token:'fixture-secret'}));
 let remote=1,codegens=0,reads=0;
 const fetchImpl=async(url,options)=>{
  assert.equal(options.headers['x-plasmic-api-token'],'fixture-secret');
  if(url.includes('revision-without-data')){reads++;return Response.json({rev:{projectId,revision:remote}});}
  codegens++;return Response.json(bundle);
 };
 const server=await createServer({root,configFile:false,cacheDir:join(root,'cache'),logLevel:'silent',plugins:[plasmicAutoSync({authFile,fetchImpl,intervalMs:20})],server:{host:'127.0.0.1',port:0,strictPort:false}});
 const events=[],send=server.ws.send.bind(server.ws);server.ws.send=(...args)=>{events.push(args[0]);return send(...args);};
 async function until(predicate){for(let i=0;i<100;i++){if(await predicate())return;await new Promise(done=>setTimeout(done,20));}assert.fail('development sync timed out');}
 try{
  await server.listen();const base=`http://127.0.0.1:${server.httpServer.address().port}`;
  const status=()=>fetch(base+'/__plasmic/status').then(response=>response.json());
  await until(async()=>(await status()).phase==='ready');
  assert.equal(codegens,0);
  remote=2;bundle.projectConfig.revision=2;bundle.components[0].cssRules='.root{padding:16px}';
  await until(async()=>(await status()).revision===2);
  assert.equal(codegens,1);assert.equal(await readFile(join(root,'src/plasmic/Card.module.css'),'utf8'),'.root{padding:16px}\n');
  const refreshes=events.filter(event=>event.type==='full-reload');
  assert.deepEqual(refreshes,[{type:'full-reload',path:'/plasmic-preview.html'}]);
  assert.doesNotMatch(JSON.stringify(await status()),/fixture-secret|fixture-user|private-auth/);
  assert.equal((await fetch(base+'/__plasmic/status',{method:'POST'})).status,405);
  await server.close();const stoppedAt=reads;await new Promise(done=>setTimeout(done,80));assert.equal(reads,stoppedAt);
 }finally{await server.close();}
});
