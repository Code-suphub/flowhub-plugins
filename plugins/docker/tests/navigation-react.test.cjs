const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {buildSync}=require('esbuild');
const {JSDOM}=require('jsdom');
const plugin=path.resolve(__dirname,'..');
const code=buildSync({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{App}from'./src/App';import{createPreviewApi}from'./src/api';import{LogSessions,emptyLogs}from'./src/log-state';window.LogSessions=LogSessions;window.emptyLogs=emptyLogs;window.sampleApi=createPreviewApi;window.mount=api=>{const root=createRoot(document.getElementById('root'));root.render(React.createElement(App,{api,context:{}}));return root;};`,resolveDir:plugin,loader:'tsx'},loader:{'.css':'empty'},jsx:'automatic',bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'},alias:{react:path.join(plugin,'node_modules/react'),'react-dom':path.join(plugin,'node_modules/react-dom')},logLevel:'silent'}).outputFiles[0].text;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(predicate){for(let i=0;i<150;i++){if(predicate())return;await delay(10);}assert.ok(predicate(),'Docker UI did not settle');}
function setup(t,{narrow=false}={}){
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
  const calls=[],copies=[],intervals=[],sample=w.sampleApi(),state={context:'local',listFailure:false,logs:async p=>({text:p.id[0]+' info ready\n'+p.id[0]+' error retry'})};
  const nativeInterval=w.setInterval.bind(w);w.setInterval=(callback,ms)=>{intervals.push({callback,ms});return nativeInterval(callback,ms);};
  Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async text=>{copies.push(text);}}});
  const api={preview:false,dispose(){},async invoke(method,params={}){
    calls.push({method,params});
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
  const select=(kind,id,zone='.docker-sidebar')=>doc.querySelector(zone)?.querySelector(`[data-docker-select="${kind}:${id}"]`);
  const heading=()=>doc.querySelector('[data-docker-detail-title]')?.textContent;
  const ready=()=>wait(()=>select('project','web-app') && !button('↻ 刷新')?.disabled);
  const logs=async(id='a'.repeat(64))=>{await ready();click(select('container',id));await wait(()=>heading()?.includes(id[0]==='a'?'api':'postgres'));click(button('运行日志'));await wait(()=>doc.querySelector('textarea')?.value.includes('info ready'));};
  return {w,doc,state,calls,copies,intervals,button,click,fill,select,heading,ready,logs};
}

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
  s.click([...s.doc.querySelectorAll('.docker-scope-nav button')].find(node=>node.textContent.startsWith('镜像')));await wait(()=>s.doc.querySelector('[aria-label="镜像列表"]'));
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
  s.state.context='other';s.click(s.button('↻ 刷新'));await wait(()=>!s.heading() && s.doc.querySelector('.docker-context').textContent==='other');
  s.state.logs=async()=>({text:'new context info ready'});s.click(s.select('container','a'.repeat(64)));await wait(()=>s.heading()==='web-app-api-1');s.click(s.button('运行日志'));await wait(()=>s.doc.querySelector('textarea')?.value==='new context info ready');assert.equal(s.doc.querySelector('[aria-label="过滤日志"]').value,'');
  assert.equal(s.button('← 返回上一步').disabled,false);s.click(s.button('← 返回上一步'));await wait(()=>!s.heading());assert.equal(s.button('← 返回上一步'),undefined);
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
