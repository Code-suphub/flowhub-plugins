const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {buildSync}=require('esbuild');
const {JSDOM}=require('jsdom');
const plugin=path.resolve(__dirname,'..');
const code=buildSync({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{App}from'./src/App';import{createPreviewApi}from'./src/api';import{LogSessions,emptyLogs}from'./src/log-state';window.LogSessions=LogSessions;window.emptyLogs=emptyLogs;window.sampleApi=createPreviewApi;window.mount=api=>{const root=createRoot(document.getElementById('root'));root.render(React.createElement(App,{api,context:{}}));return root;};`,resolveDir:plugin,loader:'tsx'},loader:{'.css':'empty'},jsx:'automatic',bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'},alias:{react:path.join(plugin,'node_modules/react'),'react-dom':path.join(plugin,'node_modules/react-dom')},logLevel:'silent'}).outputFiles[0].text;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const pullJob={id:'pull-test',context:'local',reference:'nginx:stable',platform:'',state:'running',layers:[{id:'aaaaaaaaaaaa',status:'正在下载 1MB/2MB'}],error:null,imageId:null};
async function wait(predicate){for(let i=0;i<150;i++){if(predicate())return;await delay(10);}assert.ok(predicate(),'Docker UI did not settle');}
function setup(t,{narrow=false,preview=false}={}){
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  w.HTMLElement.prototype.scrollIntoView=function(){};
  w.HTMLCanvasElement.prototype.getContext=()=>null; // Browsing never opens the terminal canvas.
  w.HTMLElement.prototype.getBoundingClientRect=()=>({x:10,y:10,left:10,top:10,right:130,bottom:42,width:120,height:32});
  w.matchMedia=()=>({matches:narrow,addEventListener(){},removeEventListener(){}});
  w.scrollTo=({top})=>{Object.defineProperty(w,'scrollY',{value:top,configurable:true});};
  Object.defineProperty(w.HTMLTextAreaElement.prototype,'scrollHeight',{get(){return 1200;}});
  Object.defineProperty(w.HTMLTextAreaElement.prototype,'clientHeight',{get(){return 300;}});
  w.eval(code);
  const calls=[],copies=[],intervals=[],sample=w.sampleApi(),state={context:'local',listFailure:false,handlers:{},logs:async p=>({text:p.id[0]+' info ready\n'+p.id[0]+' error retry'})};
  const nativeInterval=w.setInterval.bind(w);w.setInterval=(callback,ms)=>{intervals.push({callback,ms});return nativeInterval(callback,ms);};
  Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async text=>{copies.push(text);}}});
  const api={preview,dispose(){},async invoke(method,params={}){
    calls.push({method,params});
    if(state.handlers[method])return state.handlers[method](params);
    if(method==='list'){if(state.listFailure)throw new w.Error('引擎暂时不可用');const value=await sample.invoke(method,params);return {...value,context:state.context};}
    if(method==='logs')return state.logs(params);
    if(method==='stop_preview')return {context:state.context,targets:[{id:'a'.repeat(64),name:'web-app-api-1',state:'restarting'}]};
    return sample.invoke(method,params);
  }};
  const root=w.mount(api);t.after(()=>{root.unmount();w.close();});
  const doc=w.document;
  const button=label=>[...doc.querySelectorAll('button')].find(node=>node.textContent===label);
  const click=node=>{assert.ok(node,'button exists');node.focus();node.click();};
  const fill=(label,value)=>{const node=doc.querySelector(`[aria-label="${label}"]`);Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new w.Event('input',{bubbles:true}));};
  const select=(kind,id,zone='.docker-sidebar')=>[...doc.querySelector(zone)?.querySelectorAll('[data-docker-select]') || []].find(node=>node.dataset.dockerSelect===kind+':'+id || node.dataset.dockerSelect.startsWith(kind+':'+id+':from:'));
  const heading=()=>doc.querySelector('[data-docker-detail-title]')?.textContent;
  const nav=label=>[...doc.querySelectorAll('.docker-scope-nav button')].find(node=>node.children[1]?.textContent===label);
  const type=(selector,value)=>{const node=doc.querySelector(selector);Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new w.Event('input',{bubbles:true}));};
  const ready=()=>wait(()=>select('project','web-app') && !button('↻ 刷新')?.disabled);
  const logs=async(id='a'.repeat(64))=>{await ready();click(select('container',id));await wait(()=>heading()?.includes(id[0]==='a'?'api':'postgres'));click(button('运行日志'));await wait(()=>doc.querySelector('textarea')?.value.includes('info ready'));};
  return {w,doc,state,calls,copies,intervals,sample,button,click,fill,type,nav,select,heading,ready,logs};
}

test('image pull keeps draft on failure, guards IME and duplicate start, and can continue behind resource navigation',async t=>{
  const s=setup(t);s.state.handlers.image_pull_status=async()=>({job:null});await s.ready();s.click(s.nav('镜像'));await wait(()=>s.button('＋ 拉取镜像') && !s.button('＋ 拉取镜像').disabled);s.click(s.button('＋ 拉取镜像'));
  await wait(()=>s.doc.querySelector('#docker-pull-reference'));s.type('#docker-pull-reference','nginx:stable');let finish;
  s.state.handlers.image_pull_start=()=>new Promise((resolve,reject)=>{finish={resolve,reject};});const submit=()=>s.doc.querySelector('#docker-pull-form').dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));
  const input=s.doc.querySelector('#docker-pull-reference');input.dispatchEvent(new s.w.CompositionEvent('compositionstart',{bubbles:true}));submit();assert.equal(s.calls.filter(c=>c.method==='image_pull_start').length,0);input.dispatchEvent(new s.w.CompositionEvent('compositionend',{bubbles:true}));await delay(90);submit();submit();await wait(()=>finish);
  assert.equal(s.calls.filter(c=>c.method==='image_pull_start').length,1);assert.equal(s.calls.find(c=>c.method==='image_pull_start').params.confirmed,true);finish.reject(new s.w.Error('仓库暂不可用'));await wait(()=>s.doc.querySelector('[role="alert"]')?.textContent.includes('仓库暂不可用'));assert.equal(input.value,'nginx:stable');
  s.state.handlers.image_pull_start=async()=>({job:{...pullJob}});s.state.handlers.image_pull_status=async()=>({job:{...pullJob}});submit();await wait(()=>s.button('后台继续'));s.click(s.button('后台继续'));await wait(()=>!s.doc.querySelector('#docker-pull-form'));
  s.click(s.nav('卷'));await wait(()=>s.doc.querySelector('[aria-label="卷列表"]'));s.click(s.nav('镜像'));await wait(()=>s.button('查看拉取任务'));s.click(s.button('查看拉取任务'));await wait(()=>s.doc.querySelector('[aria-label="镜像层进度"]'));assert.match(s.doc.querySelector('[aria-label="镜像拉取任务"]').textContent,/正在下载/);
  const reads=s.calls.filter(c=>c.method==='images').length;s.state.handlers.image_pull_status=async()=>({job:{...pullJob,state:'succeeded',imageId:'sha256:'+'a'.repeat(64)}});await wait(()=>s.doc.querySelector('[aria-label="镜像拉取任务"]').textContent.includes('拉取完成'));await wait(()=>s.calls.filter(c=>c.method==='images').length>reads);
  assert.equal(s.calls.some(c=>c.method==='operate'),false);
});
test('pull cancellation targets the captured job; context change discards late start and clears the form',async t=>{
  const s=setup(t);s.state.handlers.image_pull_status=async()=>({job:null});await s.ready();s.click(s.nav('镜像'));await wait(()=>s.button('＋ 拉取镜像') && !s.button('＋ 拉取镜像').disabled);s.click(s.button('＋ 拉取镜像'));await wait(()=>s.doc.querySelector('#docker-pull-reference'));s.type('#docker-pull-reference','nginx:stable');
  let resolve;s.state.handlers.image_pull_start=()=>new Promise(done=>{resolve=done;});s.doc.querySelector('#docker-pull-form').dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));await wait(()=>resolve);
  s.state.context='other';s.click(s.button('↻ 刷新'));await wait(()=>!s.doc.querySelector('#docker-pull-form'));resolve({job:{...pullJob}});await delay(30);s.click(s.button('＋ 拉取镜像'));await wait(()=>s.doc.querySelector('#docker-pull-reference'));assert.equal(s.doc.querySelector('#docker-pull-reference').value,'');assert.equal(s.doc.querySelector('[aria-label="镜像拉取任务"]'),null);
  s.state.handlers.image_pull_start=async()=>({job:{...pullJob,context:'other'}});s.state.handlers.image_pull_cancel=async params=>({job:{...pullJob,context:params.context,state:'cancelled',error:'已停止请求'}});s.type('#docker-pull-reference','nginx:stable');s.doc.querySelector('#docker-pull-form').dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));await wait(()=>s.button('停止请求'));s.click(s.button('停止请求'));await wait(()=>s.doc.querySelector('[aria-label="镜像拉取任务"]').textContent.includes('请求已停止'));const cancel=s.calls.find(c=>c.method==='image_pull_cancel');assert.equal(cancel.params.id,pullJob.id);assert.equal(cancel.params.context,'other');assert.equal(cancel.params.confirmed,true);
});
test('readonly preview disables image pull without creating tasks',async t=>{
  const s=setup(t,{preview:true});await s.ready();s.click(s.nav('镜像'));await wait(()=>s.button('＋ 拉取镜像'));assert.equal(s.button('＋ 拉取镜像').disabled,true);s.button('＋ 拉取镜像').click();assert.equal(s.doc.querySelector('#docker-pull-form'),null);assert.equal(s.calls.some(c=>c.method==='image_pull_start'),false);
});

test('project drill-down preserves filters, restores list/detail positions and focuses the source on return',async t=>{
  const s=setup(t);await s.ready();s.fill('搜索资源','web-app');await wait(()=>s.doc.querySelector('input').value==='web-app');
  const sidebar=s.doc.querySelector('.docker-sidebar');sidebar.scrollTop=93;
  s.click(s.select('project','web-app'));await wait(()=>s.heading()==='web-app');
  const detail=s.doc.querySelector('.docker-detail');detail.scrollTop=167;
  s.click(s.select('container','a'.repeat(64),'.docker-detail'));await wait(()=>s.heading()==='web-app-api-1');
  assert.equal(s.doc.querySelector('[aria-label="搜索资源"]').value,'web-app');
  s.click(s.button('← 返回上一步'));await wait(()=>s.heading()==='web-app');
  assert.equal(detail.scrollTop,167);assert.equal(s.doc.activeElement,s.select('container','a'.repeat(64),'.docker-detail'));
  s.click(s.button('← 返回上一步'));await wait(()=>!s.heading());
  assert.equal(sidebar.scrollTop,93);assert.equal(s.doc.activeElement,s.select('project','web-app'));
  s.click(s.select('project','web-app'));await wait(()=>s.heading()==='web-app');s.click(s.button('资源列表'));await wait(()=>!s.heading());assert.equal(s.doc.activeElement,s.doc.querySelector('[aria-label="搜索资源"]'));
  assert.equal(s.calls.some(call=>/operate|confirm|terminal_open/.test(call.method)),false);
});

test('narrow navigation restores the scrolling list and image-to-container return restores image scope and filter',async t=>{
  const s=setup(t,{narrow:true});await s.ready();const list=s.doc.querySelector('.docker-resource-list');list.scrollTop=48;s.w.scrollTo({top:90});
  s.click(s.select('project','web-app'));await wait(()=>s.heading()==='web-app');s.w.scrollTo({top:500});s.click(s.button('← 返回上一步'));await wait(()=>!s.heading());assert.equal(list.scrollTop,48);assert.equal(s.w.scrollY,90);
  s.click([...s.doc.querySelectorAll('.docker-scope-nav button')].find(node=>node.textContent.includes('镜像')));await wait(()=>s.doc.querySelector('[aria-label="镜像列表"]'));
  s.fill('搜索资源','postgres');await wait(()=>s.doc.querySelectorAll('.docker-resource-row').length===1);
  const image=s.doc.querySelector('.docker-resource-row');s.click(image);await wait(()=>s.doc.querySelector('.docker-member-row'));
  s.click(s.doc.querySelector('.docker-member-row'));await wait(()=>s.heading()==='web-app-postgres-1');
  assert.match(s.doc.querySelector('.docker-selection-note').textContent,/保持原对象/);
  s.click(s.button('← 返回上一步'));await wait(()=>s.heading()==='postgres:16');
  assert.equal(s.doc.querySelector('[aria-label="搜索资源"]').value,'postgres');assert.equal(s.doc.activeElement,s.doc.querySelector('.docker-member-row'));
  s.click(s.button('← 返回上一步'));await wait(()=>!s.heading());assert.equal(s.doc.activeElement,image);
});

test('same-container selection keeps its tab; log refresh and errors retain content, filter, scroll and retry',async t=>{
  const s=setup(t);await s.logs();s.fill('过滤日志','error');await wait(()=>s.doc.querySelector('textarea').value==='a error retry');
  const output=s.doc.querySelector('textarea');output.scrollTop=120;output.dispatchEvent(new s.w.Event('scroll',{bubbles:true}));await wait(()=>s.button('回到最新'));
  s.click(s.select('container','a'.repeat(64)));await delay(30);assert.ok(s.doc.querySelector('textarea'));assert.equal(s.doc.querySelector('[aria-label="过滤日志"]').value,'error');
  let resolve;s.state.logs=()=>new Promise(done=>{resolve=done;});const previous=s.calls.filter(call=>call.method==='logs').length;
  s.click(s.button('刷新日志'));s.click(s.button('刷新日志'));await wait(()=>resolve);assert.equal(output.value,'a error retry');assert.equal(s.calls.filter(call=>call.method==='logs').length,previous+1);
  resolve({text:'a info new\na error retry\na error next'});await wait(()=>output.value.includes('next'));assert.equal(output.scrollTop,120);
  s.state.logs=async()=>{throw new s.w.Error('日志暂时不可用');};s.click(s.button('刷新日志'));await wait(()=>s.button('重试日志'));
  assert.match(s.doc.querySelector('.docker-log-error').textContent,/上次成功/);assert.match(output.value,/next/);
  s.state.logs=async()=>({text:'a error recovered'});s.click(s.button('重试日志'));await wait(()=>output.value==='a error recovered');assert.equal(s.doc.querySelector('.docker-log-error'),null);
  s.click(s.button('回到最新'));await wait(()=>output.scrollTop===1200);
});

test('logs remember per-container view state and ignore late results after navigation or context changes',async t=>{
  const s=setup(t);await s.logs();s.fill('过滤日志','error');await wait(()=>s.doc.querySelector('[aria-label="过滤日志"]').value==='error');
  let finish;s.state.logs=p=>p.id[0]==='a'?new Promise(done=>{finish=done;}):Promise.resolve({text:'b info ready'});
  s.click(s.button('刷新日志'));await wait(()=>finish);s.click(s.select('container','b'.repeat(64)));await wait(()=>s.heading()==='web-app-postgres-1');s.click(s.button('运行日志'));await wait(()=>s.doc.querySelector('textarea')?.value==='b info ready');
  finish({text:'stale a data'});await delay(30);assert.equal(s.doc.querySelector('textarea').value,'b info ready');assert.equal(s.doc.querySelector('[aria-label="过滤日志"]').value,'');
  s.click(s.button('← 返回上一步'));await wait(()=>s.heading()==='web-app-api-1' && s.doc.querySelector('textarea'));
  assert.equal(s.doc.querySelector('[aria-label="过滤日志"]').value,'error');assert.equal(s.doc.querySelector('textarea').value,'a error retry');
  s.state.context='other';s.click(s.button('↻ 刷新'));await wait(()=>!s.heading() && s.doc.querySelector('.docker-environment').textContent.includes('other'));
  s.state.logs=async()=>({text:'new context info ready'});s.click(s.select('container','a'.repeat(64)));await wait(()=>s.heading()==='web-app-api-1');s.click(s.button('运行日志'));await wait(()=>s.doc.querySelector('textarea')?.value==='new context info ready');assert.equal(s.doc.querySelector('[aria-label="过滤日志"]').value,'');
  assert.equal(s.button('← 返回上一步').disabled,false);s.click(s.button('← 返回上一步'));await wait(()=>!s.heading());assert.equal(s.button('← 返回上一步').disabled,true);
});

test('failed list refresh disables cached-resource mutations and a changed context closes pending confirmation',async t=>{
  const s=setup(t);await s.ready();s.click(s.select('project','web-app'));await wait(()=>s.heading()==='web-app');
  s.click(s.button('停止整个项目'));await wait(()=>s.doc.querySelector('dialog[open]'));s.state.context='other';
  s.click(s.button('↻ 刷新'));await wait(()=>!s.doc.querySelector('dialog[open]') && !s.heading());
  s.click(s.select('container','b'.repeat(64)));await wait(()=>s.heading()==='web-app-postgres-1');s.state.listFailure=true;s.click(s.button('↻ 刷新'));await wait(()=>s.doc.querySelector('.docker-alert'));
  assert.equal(s.button('停止').disabled,true);assert.equal(s.button('重启').disabled,true);
  s.click(s.button('终端'));await wait(()=>s.button('连接终端'));assert.equal(s.button('连接终端').disabled,true);
  assert.equal(s.calls.some(call=>/operate|stop_confirm|terminal_open/.test(call.method)),false);
});

test('log memory is bounded, copied on reads, and old-context cleanup cannot restore discarded data',async t=>{
  const s=setup(t);const sessions=new s.w.LogSessions();sessions.activate('one');
  for(let i=0;i<10;i++)sessions.remember('one',String(i),{...s.w.emptyLogs(),text:'line '+i});
  assert.equal(sessions.read('one','0'),undefined);assert.equal(sessions.read('one','1'),undefined);const copy=sessions.read('one','9');copy.text='modified';assert.equal(sessions.read('one','9').text,'line 9');
  sessions.activate('two');sessions.remember('one','9',copy);assert.equal(sessions.read('one','9'),undefined);assert.equal(sessions.read('two','9'),undefined);
});

test('automatic log polling skips hidden pages and outstanding requests, and the preference survives tab changes',async t=>{
  const s=setup(t);await s.logs();const checkbox=s.doc.querySelector('.docker-log-tools input[type="checkbox"]');assert.equal(checkbox.checked,false);s.click(checkbox);await wait(()=>s.intervals.some(timer=>timer.ms===3000));
  const tick=s.intervals.find(timer=>timer.ms===3000).callback;let finish;s.state.logs=()=>new Promise(done=>{finish=done;});const before=s.calls.filter(call=>call.method==='logs').length;
  Object.defineProperty(s.doc,'hidden',{value:true,configurable:true});tick();await delay(15);assert.equal(s.calls.filter(call=>call.method==='logs').length,before);
  Object.defineProperty(s.doc,'hidden',{value:false,configurable:true});tick();tick();await wait(()=>finish);assert.equal(s.calls.filter(call=>call.method==='logs').length,before+1);finish({text:'a info ready again'});await wait(()=>s.doc.querySelector('textarea').value.includes('again'));
  s.click(s.button('概览'));await wait(()=>!s.doc.querySelector('textarea'));s.click(s.button('运行日志'));await wait(()=>s.doc.querySelector('.docker-log-tools input[type="checkbox"]')?.checked);assert.equal(s.doc.querySelector('textarea').value,'a info ready again');
});

test('copying a log command quotes the context and target without running it',async t=>{
  const s=setup(t);s.state.context="team's local";await s.logs();s.click(s.button('复制日志命令'));await wait(()=>s.copies.length);
  assert.equal(s.copies[0],"docker --context 'team'\\''s local' logs --tail 300 --timestamps '"+'a'.repeat(64)+"'");
  assert.equal(s.calls.some(call=>/operate|terminal_open/.test(call.method)),false);
});

test('resource navigation exposes images, volumes and networks; linked-container return restores the volume and source focus',async t=>{
  const s=setup(t);await s.ready();for(const label of ['容器','Compose 项目','独立容器','镜像','卷','网络','通用设置'])assert.ok(s.nav(label));
  s.click(s.nav('卷'));await wait(()=>s.select('volume','web-app_postgres-data'));s.fill('搜索资源','postgres');s.click(s.select('volume','web-app_postgres-data'));await wait(()=>s.heading()==='web-app_postgres-data' && s.doc.querySelector('.docker-member-row'));
  assert.match(s.doc.querySelector('.docker-detail').textContent,/引擎内路径/);assert.equal(s.button('删除卷').disabled,true);
  const member=s.select('container','b'.repeat(64),'.docker-detail');s.click(member);await wait(()=>s.heading()==='web-app-postgres-1');s.click(s.button('← 返回上一步'));await wait(()=>s.heading()==='web-app_postgres-data' && s.doc.activeElement===s.select('container','b'.repeat(64),'.docker-detail'));
  s.click(s.button('← 返回上一步'));await wait(()=>!s.heading());assert.equal(s.doc.querySelector('[aria-label="搜索资源"]').value,'postgres');assert.equal(s.doc.activeElement,s.select('volume','web-app_postgres-data'));
  s.fill('搜索资源','');s.click(s.nav('网络'));await wait(()=>s.select('network','0'.repeat(64)));s.click(s.select('network','0'.repeat(64)));await wait(()=>s.button('删除网络'));assert.equal(s.button('删除网络').disabled,true);assert.match(s.doc.querySelector('.docker-detail').textContent,/默认网络/);
});

test('volume deletion refreshes references, requires the exact name, and sends the previewed identity only after confirmation',async t=>{
  const s=setup(t);await s.ready();let rows=(await s.sample.invoke('volumes')).volumes;s.state.handlers.volumes=async()=>({volumes:rows});
  s.state.handlers.volume_remove=async params=>{rows=rows.filter(row=>row.name!==params.name);return {ok:true};};
  s.click(s.nav('卷'));await wait(()=>s.select('volume','cache-data'));s.click(s.select('volume','cache-data'));await wait(()=>s.button('删除卷'));s.click(s.button('删除卷'));await wait(()=>s.doc.querySelector('dialog[open]'));
  assert.match(s.doc.querySelector('dialog').textContent,/永久丢失/);assert.equal(s.button('永久删除卷').disabled,true);s.type('#docker-confirm-name','other');s.click(s.button('永久删除卷'));assert.equal(s.calls.some(call=>call.method==='volume_remove'),false);
  s.type('#docker-confirm-name','cache-data');await wait(()=>!s.button('永久删除卷').disabled);s.click(s.button('永久删除卷'));await wait(()=>!s.doc.querySelector('dialog[open]') && !s.heading() && !s.select('volume','cache-data'));
  const call=s.calls.find(call=>call.method==='volume_remove');assert.equal(call.params.typedName,'cache-data');assert.equal(call.params.context,'local');assert.equal(call.params.identity.name,'cache-data');assert.equal(call.params.confirmed,true);assert.equal(s.calls.filter(call=>call.method==='volume_detail').length,2);
});

test('new references found by the deletion preflight prevent confirmation and execution',async t=>{
  const s=setup(t);await s.ready();s.click(s.nav('卷'));await wait(()=>s.select('volume','cache-data'));s.click(s.select('volume','cache-data'));await wait(()=>s.button('删除卷') && !s.button('删除卷').disabled);
  s.state.handlers.volume_detail=async p=>({...await s.sample.invoke('volume_detail',p),containers:[{id:'b'.repeat(64),name:'stopped-db',state:'exited'}]});s.click(s.button('删除卷'));await wait(()=>s.doc.querySelector('.docker-notice')?.textContent.includes('引用关系'));
  assert.equal(s.doc.querySelector('dialog[open]'),null);assert.equal(s.button('删除卷').disabled,true);assert.equal(s.calls.some(call=>call.method==='volume_remove'),false);
});

test('resource creation validates names, guards IME and repeated Enter, locks pending save and preserves failed drafts',async t=>{
  const s=setup(t);await s.ready();s.click(s.nav('卷'));await wait(()=>s.button('＋ 新建卷') && !s.button('＋ 新建卷').disabled);s.click(s.button('＋ 新建卷'));await wait(()=>s.doc.querySelector('#docker-new-name'));
  s.type('#docker-new-name','--invalid');assert.equal(s.button('创建卷').disabled,true);s.type('#docker-new-name','app-data');await wait(()=>!s.button('创建卷').disabled);
  const input=s.doc.querySelector('#docker-new-name'),submit=()=>s.doc.querySelector('#docker-create-resource').dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));
  input.dispatchEvent(new s.w.CompositionEvent('compositionstart',{bubbles:true}));submit();assert.equal(s.calls.some(call=>call.method==='volume_create'),false);input.dispatchEvent(new s.w.CompositionEvent('compositionend',{bubbles:true}));await delay(100);
  assert.equal(input.dispatchEvent(new s.w.KeyboardEvent('keydown',{key:'Enter',repeat:true,bubbles:true,cancelable:true})),false);
  let reject;s.state.handlers.volume_create=()=>new Promise((_,fail)=>{reject=fail;});submit();submit();await wait(()=>reject);s.click(s.button('取消'));assert.ok(s.doc.querySelector('dialog[open]'));assert.equal(s.calls.filter(call=>call.method==='volume_create').length,1);
  reject(new s.w.Error('同名卷已存在'));await wait(()=>s.doc.querySelector('dialog [role="alert"]'));assert.equal(input.value,'app-data');assert.equal(s.doc.querySelector('dialog [role="alert"]').textContent,'同名卷已存在');s.click(s.button('取消'));await wait(()=>!s.doc.querySelector('dialog[open]'));
});

test('a successful network creation refreshes its list and changing context closes an unsaved resource form',async t=>{
  const s=setup(t);await s.ready();let rows=(await s.sample.invoke('networks')).networks;
  s.state.handlers.networks=async()=>({networks:rows});s.state.handlers.network_create=async p=>{rows=[...rows,{...rows[0],id:'e'.repeat(64),name:p.name}];return {ok:true};};
  s.click(s.nav('网络'));await wait(()=>s.button('＋ 新建网络') && !s.button('＋ 新建网络').disabled);s.click(s.button('＋ 新建网络'));await wait(()=>s.doc.querySelector('#docker-new-name'));s.type('#docker-new-name','app-network');s.click(s.button('创建网络'));await wait(()=>!s.doc.querySelector('dialog[open]') && s.select('network','e'.repeat(64)));
  const call=s.calls.find(call=>call.method==='network_create');assert.equal(call.params.context,'local');assert.equal(call.params.name,'app-network');assert.equal(call.params.confirmed,true);
  s.click(s.button('＋ 新建网络'));await wait(()=>s.doc.querySelector('dialog[open]'));s.state.context='other';s.intervals.filter(timer=>timer.ms===15000).at(-1).callback();await wait(()=>!s.doc.querySelector('dialog[open]') && s.doc.querySelector('.docker-environment').textContent.includes('other'));
});

test('resource list failures show unavailable instead of a false unused state, retain cached rows, and disable mutations until recovery',async t=>{
  const s=setup(t);await s.ready();s.state.handlers.volumes=async()=>{throw new s.w.Error('卷引用读取失败');};s.click(s.nav('卷'));await wait(()=>s.doc.querySelector('.docker-alert'));assert.match(s.doc.querySelector('.docker-sidebar').textContent,/资源暂不可用/);assert.equal(s.button('＋ 新建卷').disabled,true);
  delete s.state.handlers.volumes;s.click(s.button('↻ 刷新'));await wait(()=>s.select('volume','cache-data') && !s.button('↻ 刷新').disabled);s.state.handlers.volumes=async()=>{throw new s.w.Error('卷引用读取失败');};s.click(s.button('↻ 刷新'));await wait(()=>s.doc.querySelector('.docker-alert'));assert.ok(s.select('volume','cache-data'));assert.equal(s.button('＋ 新建卷').disabled,true);
});

test('table pagination and the source row survive detail navigation without executing any operation',async t=>{
  const s=setup(t);await s.ready();const original=(await s.sample.invoke('list')).containers[1];s.state.handlers.list=async()=>({context:'local',containers:Array.from({length:60},(_,i)=>({...original,id:i.toString(16).padStart(64,'0'),name:'resource-'+String(i).padStart(2,'0')}))});await wait(()=>s.button('↻ 刷新') && !s.button('↻ 刷新').disabled);s.click(s.button('↻ 刷新'));await wait(()=>s.button('下一页'));
  s.click(s.button('下一页'));await wait(()=>s.select('container',(25).toString(16).padStart(64,'0')));const source=s.select('container',(25).toString(16).padStart(64,'0'));s.click(source);await wait(()=>s.heading()==='resource-25');s.click(s.button('← 返回上一步'));await wait(()=>!s.heading());assert.equal(s.doc.activeElement,source);assert.match(s.doc.querySelector('.fh-pagination').textContent,/2 \/ 3/);assert.equal(s.calls.some(call=>/operate|_remove|_create|terminal_open/.test(call.method)),false);
});

test('read-only previews cannot create resources, and changing resource type while a read is pending loads the latest type',async t=>{
  const s=setup(t,{preview:true});await s.ready();s.click(s.nav('卷'));await wait(()=>s.button('＋ 新建卷'));assert.equal(s.button('＋ 新建卷').disabled,true);s.click(s.select('volume','cache-data'));await wait(()=>s.button('删除卷'));assert.equal(s.button('删除卷').disabled,true);
  s.click(s.nav('容器'));await wait(()=>!s.heading());let finish;s.state.handlers.images=()=>new Promise(done=>{finish=done;});s.click(s.nav('镜像'));await wait(()=>finish);s.click(s.nav('网络'));finish({images:[]});await wait(()=>s.select('network','f'.repeat(64)));assert.equal(s.doc.querySelector('.docker-header h1').textContent,'网络');assert.equal(s.calls.some(call=>/_create|_remove/.test(call.method)),false);
});
