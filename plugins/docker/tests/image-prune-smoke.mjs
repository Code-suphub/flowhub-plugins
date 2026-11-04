import {spawn, execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import assert from 'node:assert/strict';

// Use the real Docker CLI and plugin RPC against a disposable Unix-socket
// engine fixture. No request can reach the user's Docker daemon or images.
const directory = mkdtempSync('/tmp/flowhub-prune-');
const socket = directory + '/engine.sock', context = 'flowhub-prune-test';
const iid = c => 'sha256:' + c.repeat(64);
const image = (c, tags, containers, size) => ({Id:iid(c), ParentId:'', RepoTags:tags,
  RepoDigests:[], Created:1790000000, Size:size, SharedSize:0, Containers:containers, Labels:{}});
let images = [image('a',['used-running:latest'],1,100), image('b',['used-stopped:latest'],1,200),
  image('c',['unused:one','unused:two'],0,1000), image('d',[],0,2000)];
images[3].RepoDigests = ['digest-only@' + iid('d')];
let requests = [], pruneCalls = 0, preserveAtPrune = false, child;
const server = createServer((req,res) => {
  const url = new URL(req.url,'http://engine');
  const path = url.pathname.replace(/^\/v\d+\.\d+/, '');
  requests.push([req.method, path]);
  res.setHeader('Api-Version','1.47'); res.setHeader('OSType','linux');
  res.setHeader('Docker-Experimental','false');
  if (path === '/_ping') {res.end('OK'); return;}
  res.setHeader('Content-Type','application/json');
  if (req.method === 'GET' && path === '/system/df') {res.end(JSON.stringify({LayersSize:3300,Images:images,Containers:[],Volumes:[],BuildCache:[]})); return;}
  if (req.method === 'GET' && path === '/images/json') {res.end(JSON.stringify(images)); return;}
  if (req.method === 'GET' && path === '/containers/json') {res.end('[]'); return;}
  if (req.method === 'POST' && path === '/images/prune') {
    const filters = JSON.parse(url.searchParams.get('filters') || '{}');
    const allUnused = Array.isArray(filters.dangling) ? filters.dangling.includes('false') : filters.dangling?.false === true;
    if (!allUnused) {res.statusCode = 400; res.end(JSON.stringify({message:'Expected all-unused prune filter'})); return;}
    pruneCalls++;
    // Model Docker protecting an image referenced after the final preview.
    if (preserveAtPrune) images.find(row => row.Id === iid('c')).Containers = 1;
    const removed = images.filter(row => row.Containers === 0);
    images = images.filter(row => row.Containers > 0);
    res.end(JSON.stringify({ImagesDeleted:removed.map(row=>({Deleted:row.Id})),SpaceReclaimed:removed.reduce((sum,row)=>sum+row.Size,0)})); return;
  }
  res.statusCode = 500; res.end(JSON.stringify({message:'Unexpected fixture request: '+req.method+' '+path}));
});
let serial = 0;
const pending = new Map();
function call(method, params) {
  return new Promise((resolve,reject) => {
    const id = ++serial, timer = setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout'));},15000);
    pending.set(id,{resolve,reject,timer});
    child.stdin.write(JSON.stringify({id,method:'widget_api',params:{action:'management',method,params}})+'\n');
  });
}
try {
  await new Promise(resolve => server.listen(socket,resolve));
  execFileSync('docker',['--config',directory,'context','create',context,'--docker','host=unix://'+socket],{stdio:'pipe'});
  execFileSync('docker',['--config',directory,'context','use',context],{stdio:'pipe'});
  child = spawn('./bin/flowhub-docker',[],{env:{...process.env,DOCKER_CONFIG:directory},stdio:['pipe','pipe','inherit']});
  createInterface({input:child.stdout}).on('line',line => {
    const response = JSON.parse(line), item = pending.get(response.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(response.id);
    response.error ? item.reject(Error(response.error)) : item.resolve(response.result);
  });
  await assert.rejects(call('image_prune_confirm',{context}),/确认/);
  await assert.rejects(call('image_prune_confirm',{context,confirmed:true,targets:[]}),/目标/);
  const plan = await call('image_prune_preview',{context});
  assert.deepEqual(plan.targets.map(row=>row.id),[iid('c'),iid('d')]);
  assert.deepEqual(plan.targets[0].references,['unused:one','unused:two']);
  assert.deepEqual(plan.targets[1].references,['digest-only@'+iid('d')]);
  assert.equal(plan.totalBytes,3000);
  await assert.rejects(call('image_prune_confirm',{context:'other',confirmed:true,targets:plan.targets}),/环境/);
  images[2].RepoTags.push('unused:new-tag');
  await assert.rejects(call('image_prune_confirm',{context,confirmed:true,targets:plan.targets}),/变化/);
  const retagged = await call('image_prune_preview',{context});
  images.push(image('e',['new-unused:latest'],0,100));
  await assert.rejects(call('image_prune_confirm',{context,confirmed:true,targets:retagged.targets}),/变化/);
  images.pop();
  images[3].Containers = 1;
  await assert.rejects(call('image_prune_confirm',{context,confirmed:true,targets:retagged.targets}),/变化/);
  assert.equal(pruneCalls,0);
  images[3].Containers = 0;
  const fresh = await call('image_prune_preview',{context});
  preserveAtPrune = true;
  const result = await call('image_prune_confirm',{context,confirmed:true,targets:fresh.targets});
  assert.equal(pruneCalls,1);
  assert.equal(result.removed,1); assert.equal(result.remaining,1);
  assert.equal(result.reclaimed,'2kB');
  assert.deepEqual(images.map(row=>row.Id),[iid('a'),iid('b'),iid('c')]);
  assert.deepEqual((await call('image_prune_preview',{context})).targets,[]);
  images = [];
  const empty = await call('image_prune_preview',{context});
  assert.deepEqual(empty.targets,[]); assert.equal(empty.totalBytes,0);
  assert.deepEqual(requests.filter(([method])=>!['GET','HEAD'].includes(method)),[['POST','/images/prune']]);
  console.log('PASS: real CLI + isolated engine fixture: prune preview, tag grouping, stopped-container protection, confirmation/context/changed-target guards, all-unused prune, partial results and empty state');
} finally {
  child?.kill();
  for (const item of pending.values()) clearTimeout(item.timer);
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
  rmSync(directory,{recursive:true,force:true});
}
