import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {webcrypto} from 'node:crypto';

async function moduleAt(entry) {
  const result=await build({entryPoints:[new URL(entry,import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'esm',loader:{'.svg':'dataurl'}});
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const model=await moduleAt('../src/model.ts');
const {createApi}=await moduleAt('../src/api.ts');
const {applicationIdentity,applicationIcon}=await moduleAt('../src/applications.tsx');

test('independent process details expose one selected instance without application or context actions',()=>{
  const group=model.sampleSnapshot().groups.find(group=>group.id==='android:410');
  const instance={id:'emulator-one',root:group.processes[0],count:1,canTerminate:true};
  group.instances=[instance];
  let controls=model.detailControls(group,{canQuit:false});
  assert.equal(controls.canStop,true);assert.equal(controls.instance.id,instance.id);
  assert.equal(controls.canOpen,false);assert.equal(controls.canQuit,false);assert.equal(controls.contextLabel,undefined);
  assert.equal(controls.stopLabel,'结束此实例');
  const second={...instance,id:'emulator-two',root:{...instance.root,pid:999}};
  group.instances.push(second);
  controls=model.detailControls(group);
  assert.equal(controls.chooseInstance,true);assert.equal(controls.instance,undefined);
  assert.equal(controls.stopLabel,'结束全部实例');
  assert.deepEqual(controls.stopIds,[instance.id,second.id]);
  assert.equal(model.detailControls(group,undefined,second.id).instance,second);
  controls=model.detailControls(group,undefined,'no-longer-running');
  assert.equal(controls.canStop,false);assert.equal(controls.instance,undefined);
  assert.match(controls.stopHint,/已退出/);
  second.canTerminate=false;
  controls=model.detailControls(group,undefined,second.id);
  assert.equal(controls.canStop,false);assert.match(controls.stopHint,/受保护/);
});

test('batch selection is explicit, protected instances are excluded and vanished selections never become all',()=>{
  const group=model.sampleSnapshot().groups[0];
  group.instances=[{id:'one',root:group.processes[0],canTerminate:true},{id:'two',root:group.processes[1],canTerminate:true},{id:'root',root:{...group.processes[2],uid:0},canTerminate:false}];
  group.processes.push({...group.processes[0],uid:0,instanceId:'root',protected:true,protection:'其他用户或系统账户'});
  const all=model.detailControls(group);
  assert.equal(all.stopLabel,'结束全部实例');assert.deepEqual(all.stopIds,['one','two']);assert.match(all.stopHint,/1 个受保护/);
  const selected=model.detailControls(group,undefined,undefined,['two']);
  assert.equal(selected.stopLabel,'结束所选实例');assert.deepEqual(selected.stopIds,['two']);assert.equal(selected.canStop,true);
  const expired=model.detailControls(group,undefined,undefined,['gone']);
  assert.equal(expired.canStop,false);assert.deepEqual(expired.stopIds,['gone']);
  assert.equal(model.detailControls(group,undefined,undefined,['root']).canStop,false);
  assert.match(model.instanceStopReason(group,group.instances[2]),/root.*仅用于采集/);
});

test('normal quit and context tabs require actual application capabilities, never source hints',()=>{
  const group=model.sampleSnapshot().groups[0];
  group.instances=[{id:'main',root:group.processes[0],count:3,canTerminate:true}];
  const state={canQuit:true,quitInstances:['main'],contextKind:'codex'};
  const controls=model.detailControls(group,state);
  assert.equal(controls.canOpen,true);assert.equal(controls.canQuit,true);
  assert.equal(controls.contextLabel,'对话与任务');
  assert.equal(model.detailControls(group,{...state,contextKind:'arc'}).contextLabel,'标签页');
  assert.equal(model.detailControls(group,{...state,contextKind:'unsupported'}).contextLabel,undefined);
  assert.equal(model.detailControls(group).contextLabel,undefined);
  assert.equal(model.detailControls(group,state,'exited-instance').canQuit,false);
  assert.equal(model.detailControls(group,{canQuit:false,quitInstances:[]}).canQuit,false);
  const independent={...group,appPath:null,origin:{name:'Codex',appPath:group.appPath,evidence:'parent'}};
  assert.equal(model.detailControls(independent,state).canQuit,false);
  assert.equal(model.detailControls(independent,state).canOpen,false);
  assert.equal(model.detailControls(independent,state).contextLabel,undefined);
  assert.equal(model.detailControls({...group,origin:independent.origin},state).contextLabel,undefined);
});

test('application labels use matched paths while system services retain their identity',()=>{
  const apps={'/Applications/pcsuite.app':{path:'/Applications/pcsuite.app',name:'pcsuite',bundleId:'com.vivo.pcsuite',iconUrl:'data:image/png;base64,example'}};
  assert.equal(applicationIdentity({name:'pcsuite',appPath:'/Applications/pcsuite.app'},apps).name,'vivo办公套件');
  assert.match(applicationIdentity({name:'pcsuite',appPath:'/Applications/pcsuite.app'},apps).description,/连接与同步/);
  assert.equal(applicationIdentity({name:'pcsuite',appPath:'/Other/pcsuite.app'},apps).app,undefined);
  assert.equal(applicationIdentity({name:'mds_stores'},apps).name,'mds_stores');
  assert.match(applicationIdentity({name:'mds_stores'},apps).description,/Spotlight.*建议保留/);
});

test('runtime icons are bundled while native application icons retain priority and fail safely',()=>{
  const python=applicationIcon('python'),postgresql=applicationIcon('postgresql');
  assert.ok(python.startsWith('data:image/svg+xml'));assert.ok(postgresql.startsWith('data:image/svg+xml'));
  assert.notEqual(python,postgresql);assert.equal(applicationIcon('unrecognized'),'');
  const tools=['mysql','tmux','redis','android'].map(key=>applicationIcon(key));
  assert.ok(tools.every(url=>url.startsWith('data:image/svg+xml')));
  assert.equal(new Set(tools).size,4);
  assert.equal(applicationIcon('__proto__'),'');
  assert.equal(applicationIcon('toString'),'');
  const native={path:'/Applications/App.app',name:'App',bundleId:'app',iconUrl:'data:image/png;base64,native'};
  assert.equal(applicationIcon('python',native),native.iconUrl);
  assert.equal(applicationIcon('python',native,[native.iconUrl]),python);
  assert.equal(applicationIcon('python',native,[native.iconUrl,python]),'');
  assert.equal(applicationIcon('mysql',native),native.iconUrl);
});

test('related helper labels and icons never replace the independent application path or process scope',()=>{
  const parent={path:'/Applications/QQ.app',name:'QQ',bundleId:'com.tencent.qq',iconUrl:'data:image/png;base64,qq'};
  const helper={path:'/private/QQUpdate.app',name:'QQUpdate',bundleId:'com.tencent.qq.qqupdate',iconUrl:'data:image/png;base64,helper',relatedApplication:{...parent,evidence:'bundle-id-and-signing-team'}};
  const group={...model.sampleSnapshot().groups[0],name:'QQUpdate',appPath:helper.path};
  const apps={[helper.path]:helper,[parent.path]:parent},label=applicationIdentity(group,apps);
  assert.equal(label.name,'QQ · QQUpdate');assert.match(label.description,/QQ.*辅助应用.*独立运行/);
  assert.equal(applicationIdentity(group,{...apps,[helper.path]:{...helper,name:'QQ'}}).name,'QQ · QQUpdate');
  assert.equal(applicationIdentity({...group,name:label.name},{...apps,[helper.path]:{...helper,name:'QQ'}}).name,'QQ · QQUpdate');
  assert.equal(label.app.path,helper.path);assert.equal(group.appPath,helper.path);
  assert.equal(applicationIcon(undefined,label.app),parent.iconUrl);
  assert.equal(applicationIcon(undefined,label.app,[parent.iconUrl]),helper.iconUrl);
  assert.equal(model.filterGroups([{...group,name:label.name}],parent.name,false,'memory').length,1);
});

function host(surface='main',hosted=false,token='') {
  const bus=new EventTarget(),messages=[],parent={postMessage:message=>messages.push(message)};
  const window={document:{body:{dataset:{surface}}},location:{hash:token?`#flowhubWidgetToken=${token}`:''},crypto:webcrypto,
    addEventListener:bus.addEventListener.bind(bus),removeEventListener:bus.removeEventListener.bind(bus)};
  window.parent=hosted?parent:window;
  const receive=(data,source=parent)=>{const event=new Event('message');Object.assign(event,{data,source});bus.dispatchEvent(event);};
  return {window,messages,parent,receive};
}

test('rank/search includes child PID, cwd and parent; sorting does not mutate source',()=>{
  const snapshot=model.sampleSnapshot(),original=snapshot.groups.map(g=>g.id);
  assert.equal(model.filterGroups(snapshot.groups,'401',false,'memory')[0].name,'Codex');
  assert.equal(snapshot.groups.flatMap(g=>g.processes).filter(p=>model.matchesProcess(p,'401')).length,1);
  assert.ok(model.filterGroups(snapshot.groups,'mobile-automation',false,'cpu').length);
  assert.equal(model.filterGroups(snapshot.groups,'',false,'memory').some(g=>g.system),false);
  assert.equal(model.filterGroups(snapshot.groups,'',true,'memory').some(g=>g.system),true);
  assert.deepEqual(snapshot.groups.map(g=>g.id),original);
  assert.equal(model.bytes(null),'—');assert.equal(model.cpu(null),'采样中');
  assert.equal(model.bytes(1073741824),'1.00 GiB');
});

test('system display names and executable names both find the same app and process',()=>{
  const seed=model.sampleSnapshot().groups[0];
  const process={...seed.processes[0],name:'plugin-container',displayName:'ZenCP WebExtensions',executable:'/Applications/Zen.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container'};
  const group={...seed,name:'Zen',appPath:'/Applications/Zen.app',processes:[process]};
  for(const query of ['ZenCP WebExtensions','zencp','plugin-container',String(process.pid)]){
    assert.equal(model.filterGroups([group],query,false,'memory')[0],group);
    assert.equal(model.matchesProcess(process,query.toLocaleLowerCase()),true);
  }
  assert.equal(model.processName(process),'ZenCP WebExtensions');
  assert.equal(model.processName({...process,displayName:undefined}),'plugin-container');
  assert.equal(model.filterGroups([group],'missing-extension',false,'memory').length,0);
});

test('verified launch paths remain searchable without becoming signal identities or card status data',()=>{
  const seed=model.sampleSnapshot().groups[0];
  const process={...seed.processes[0],name:'bare-modifier-m',displayName:'bare-modifier-monitor',executable:'',launchExecutable:'/Applications/ChatGPT.app/Contents/Resources/native/bare-modifier-monitor',protected:true};
  const group={...seed,name:'ChatGPT',appPath:'/Applications/ChatGPT.app',processes:[process]};
  for(const query of ['bare-modifier-monitor','resources/native','bare-modifier-m']){
    assert.equal(model.filterGroups([group],query,false,'memory')[0],group);
    assert.equal(model.matchesProcess(process,query),true);
  }
  const identity=model.processKey(process);
  assert.equal(identity,model.processKey({...process,launchExecutable:'/different/path'}));
  const status=model.statusFrom({...model.sampleSnapshot(),groups:[group]});
  assert.equal(JSON.stringify(status).includes('Resources/native'),false);
  assert.equal(JSON.stringify(status).includes('launchExecutable'),false);
});

test('terminal ownership is searchable presentation metadata and never replaces process identity',()=>{
  const seed=model.sampleSnapshot().groups[0],process=seed.processes[0];
  const owned={...process,terminalOwner:{pid:12345,started:90,uid:501,executable:'/Applications/cmux.app/Contents/MacOS/cmux'}};
  assert.equal(model.matchesProcess(owned,'cmux.app'),true);
  assert.equal(model.processKey(owned),model.processKey(process));
  const status=model.statusFrom({...model.sampleSnapshot(),groups:[{...seed,processes:[owned]}]});
  assert.equal(JSON.stringify(status).includes('terminalOwner'),false);
  assert.equal(JSON.stringify(status).includes('12345'),false);
});

test('source application metadata never replaces an independent task name or application action path',()=>{
  const seed=model.sampleSnapshot().groups[0];
  const group={...seed,name:'ssh',source:'独立终端任务',appPath:null,origin:{name:'InternalTerminalName',appPath:'/Applications/Terminal.app',evidence:'系统来源线索'}};
  const apps={'/Applications/Terminal.app':{path:'/Applications/Terminal.app',name:'终端',bundleId:'com.example.Terminal',iconUrl:'data:image/png;base64,example'}};
  const label=applicationIdentity(group,apps);
  assert.equal(label.name,'ssh');assert.equal(label.app,undefined);assert.equal(label.originName,'终端');
  assert.match(label.description,/来源线索：终端/);assert.equal(group.appPath,null);
  assert.equal(model.filterGroups([group],'InternalTerminalName',false,'memory').length,1);
  assert.equal(model.statusFrom({...model.sampleSnapshot(),groups:[group]}).rows[0].origin.appPath,'/Applications/Terminal.app');
});

test('service names and multiple source hints remain presentation metadata and status omits detailed service registrations',()=>{
  const seed=model.sampleSnapshot().groups[0];
  const source={name:'InternalLauncher',appPath:'/Applications/ChatGPT.app',evidence:'verified parent'};
  const presentation={name:'Mycelia 服务',sources:[source],services:[{name:'Mycelia 服务',label:'local.fixture.private-service-label',evidence:'launchd'}]};
  const group={...seed,name:'python3.11',appPath:null,presentation};
  const original=structuredClone(group);
  const apps={[source.appPath]:{path:source.appPath,name:'ChatGPT',bundleId:'com.example.chatgpt',iconUrl:'data:image/png;base64,fixture'}};
  const label=applicationIdentity(group,apps);
  assert.equal(label.name,'Mycelia 服务');assert.equal(label.sourceText,'ChatGPT');assert.equal(label.app,undefined);
  assert.match(label.description,/独立服务/);assert.deepEqual(group,original);
  for(const query of ['Mycelia','InternalLauncher','private-service-label','ChatGPT.app'])assert.equal(model.filterGroups([group],query,false,'memory')[0],group);
  const status=model.statusFrom({...model.sampleSnapshot(),groups:[group]});
  assert.equal(status.rows[0].presentation.name,'Mycelia 服务');
  assert.equal(JSON.stringify(status).includes('private-service-label'),false);
  assert.equal(JSON.stringify(status).includes('verified parent'),true);
  const mixed={...group,presentation:{name:null,sources:[source,{name:'Warp',appPath:null,evidence:'another independent instance'}],services:presentation.services}};
  assert.equal(applicationIdentity(mixed,apps).name,'python3.11');
  assert.equal(applicationIdentity(mixed,apps).sourceText,'ChatGPT、Warp');
});

test('a live process moving to an independent task is not reported as exited or actionable from its old group',()=>{
  const group=model.sampleSnapshot().groups[0],process=group.processes[0];
  const detail=model.updateDetail(group,{...group,processes:group.processes.slice(1)},[{...process,groupId:'independent-task'}]);
  assert.equal(detail.processes[0].moved,true);assert.equal(detail.processes[0].exited,false);
  assert.equal(detail.processes[0].protected,true);assert.equal(detail.processes[0].memory,null);
  const execChanged={...process,executable:'/different/executable'};
  const changed=model.updateDetail({...group,processes:[process]},{...group,processes:[execChanged]});
  assert.equal(changed.processes.length,2);assert.equal(changed.processes[0].exited,true);
});

test('cards default to the complete ranked list, with explicit top-N and focus options',()=>{
  const snapshot=model.statusFrom(model.sampleSnapshot()),seed=snapshot.rows[0];
  const rows=Array.from({length:28},(_,i)=>({...seed,id:String(i),values:{...seed.values,footprint:i,cpu:i===27?null:i}}));
  const original=rows.map(row=>row.id),status={...snapshot,rows};
  assert.equal(model.widgetRows(status).length,28);
  assert.equal(model.widgetRows(status,{limit:5}).length,28,'old top-five defaults must not truncate the new complete list');
  assert.deepEqual(model.widgetRows(status,{display:'top',limit:3}).map(row=>row.id),['27','26','25']);
  assert.equal(model.widgetRows(status,{display:'top',limit:999}).length,10);
  assert.equal(model.widgetRows(status,{groupId:'12'}).length,1);
  assert.equal(model.widgetRows(status,{sort:'cpu'}).at(-1).id,'27');
  assert.deepEqual(rows.map(row=>row.id),original);
});

test('detail refresh keeps row order, marks exits and appends reused PIDs and new processes',()=>{
  const group=model.sampleSnapshot().groups[0];
  const [first,second,third]=group.processes;
  const latest={...group,processes:[{...second,footprint:1},{...first,footprint:9999999999},{...third,started:third.started+1}]};
  const detail=model.updateDetail(group,latest);
  assert.deepEqual(detail.processes.map(p=>[p.pid,p.started]),[[first.pid,first.started],[second.pid,second.started],[third.pid,third.started],[third.pid,third.started+1]]);
  assert.equal(detail.processes[0].footprint,9999999999);
  assert.equal(detail.processes[2].exited,true);
  assert.equal(detail.processes[2].memory,null);
  assert.equal(model.updateDetail(detail,undefined).canTerminate,false);
});

test('ranking switches metric and direction while keeping missing values last and input unchanged',()=>{
  const seed=model.sampleSnapshot().groups[0];
  for(const metric of ['footprint','memory','cpu']){
    const groups=[null,10,0,10,30].map((value,index)=>({...seed,id:String.fromCharCode(97+index),[metric]:value}));
    assert.deepEqual(model.filterGroups(groups,'',true,metric,'descend').map(g=>g.id),['e','b','d','c','a']);
    assert.deepEqual(model.filterGroups(groups,'',true,metric,'ascend').map(g=>g.id),['c','b','d','e','a']);
    assert.deepEqual(groups.map(g=>g.id),['a','b','c','d','e']);
  }
});

test('context usage deduplicates identities, rejects reused PIDs, preserves unknowns and expires mappings',()=>{
  const snapshot=model.sampleSnapshot(),contexts=model.sampleContexts('codex',snapshot);
  const process=snapshot.groups[0].processes[2];
  contexts.entries[0].processes.push({...process});
  let rows=model.contextRows(contexts,snapshot,snapshot.at);
  assert.equal(rows[0].memory,process.memory);assert.equal(rows[0].liveProcesses.length,1);
  assert.equal(rows[1].memory,null);assert.equal(rows[1].state,'未关联');
  const changed=structuredClone(snapshot);changed.groups[0].processes[2].started++;
  rows=model.contextRows(contexts,changed,snapshot.at);
  assert.equal(rows[0].memory,null);assert.equal(rows[0].state,'进程已退出');
  rows=model.contextRows(contexts,snapshot,snapshot.at+300001);
  assert.equal(rows[0].footprint,null);assert.equal(rows[0].state,'映射已过期');
  const arc=model.sampleContexts('arc',snapshot);
  const shared=model.contextRows(arc,snapshot,snapshot.at);
  assert.equal(shared[0].state,'共享进程');assert.equal(shared[0].liveProcesses[0].pid,471);
  assert.equal(shared[0].memory,shared[1].memory);
});

test('standalone preview blocks mutations and host settings without posting',async()=>{
  const h=host(),api=createApi(h.window);
  assert.equal(api.preview,true);assert.ok((await api.invoke('snapshot')).groups.length);
  assert.equal((await api.invoke('application_state',{groupId:'app:arc'})).contextKind,'arc');
  assert.equal((await api.invoke('application_state',{groupId:'app:codex'})).contextKind,'codex');
  assert.equal((await api.invoke('application_state',{groupId:'android:410'})).contextKind,null);
  assert.equal((await api.invoke('application_state',{groupId:'app:codex'})).canQuit,false);
  await assert.rejects(api.invoke('terminate_preview'),/预览/);
  await assert.rejects(api.invoke('quit_confirm',{confirmed:true,token:'fake'}),/预览/);
  await assert.rejects(api.invoke('flowhub_status'),/预览/);
  assert.equal(h.messages.length,0);api.dispose();
});

test('normal transport accepts only its parent and disposes pending work',async()=>{
  const h=host('main',true),api=createApi(h.window);
  const request=api.invoke('snapshot'),message=h.messages[0];
  h.receive({type:'flowhub:response',id:message.id,result:{spoofed:true}},{});
  h.receive({type:'flowhub:response',id:message.id,result:{at:42}});
  assert.deepEqual(await request,{at:42});
  const pending=api.invoke('snapshot');api.dispose();await assert.rejects(pending,/关闭/);
  await assert.rejects(api.invoke('snapshot'),/关闭/);
});

test('opaque sandbox contexts work without crypto.randomUUID',async()=>{
  const h=host('main',true);h.window.crypto={};const api=createApi(h.window);
  const request=api.invoke('snapshot'),message=h.messages[0];
  assert.ok(message.id.startsWith('resource-'));
  h.receive({type:'flowhub:response',id:message.id,result:{at:1}});
  assert.deepEqual(await request,{at:1});api.dispose();
});

test('widget handshake, token validation, preview gating, editor save and navigation',async()=>{
  const h=host('editor',true,'secret-token'),api=createApi(h.window);
  api.editor(()=>({sort:'cpu',limit:3}));api.ready();
  assert.equal(h.messages[0].type,'flowhub:widget-ready');assert.equal(api.preview,true);
  await assert.rejects(api.invoke('snapshot'),/未就绪/);
  await assert.rejects(api.status(),/未就绪/);
  h.receive({type:'flowhub:widget-init',token:'wrong',context:{preview:false}});
  assert.equal(api.preview,true);
  h.receive({type:'flowhub:widget-init',token:'secret-token',context:{preview:true}});
  await assert.rejects(api.invoke('terminate_confirm',{confirmed:true}),/预览/);
  h.receive({type:'flowhub:widget-save',token:'secret-token',id:'save-1'});
  assert.deepEqual(h.messages.at(-1).config,{sort:'cpu',limit:3});
  // Native detail windows intentionally omit preview:false in their context.
  h.receive({type:'flowhub:widget-init',token:'secret-token',context:{config:{}}});
  assert.equal(api.preview,false);
  const request=api.invoke('snapshot'),message=h.messages.at(-1);
  assert.equal(message.params.action,'management');assert.equal(message.params.method,'snapshot');
  h.receive({type:'flowhub:widget-result',token:'secret-token',id:message.id,result:{at:50}});
  assert.deepEqual(await request,{at:50});
  api.navigate('one-group');assert.deepEqual(h.messages.at(-1).selection,{groupId:'one-group'});
  api.dispose();
});


test('service self-labels are not displayed as external sources and original registration evidence remains intact',()=>{
  const group={...model.sampleSnapshot().groups[0],name:'postgres',appPath:null,origin:null,presentation:{name:'PostgreSQL 14',sources:[{name:'PostgreSQL 14',appPath:null,evidence:'macOS 运行服务登记'}],services:[{name:'PostgreSQL 14',label:'homebrew.mxcl.postgresql@14',evidence:'launchd'}]}};
  const before=structuredClone(group),label=applicationIdentity(group,{});
  assert.equal(label.name,'PostgreSQL 14');assert.equal(label.sourceText,'');assert.match(label.description,/独立服务/);assert.deepEqual(group,before);
  group.presentation.sources.push({name:'ChatGPT',appPath:'/Applications/ChatGPT.app',evidence:'verified external launcher'});
  assert.equal(applicationIdentity(group,{}).sourceText,'ChatGPT');
  const tmux={...group,name:'tmux',presentation:{name:null,sources:[{name:'tmux',appPath:null,evidence:'parent chain'}]}};
  assert.equal(applicationIdentity(tmux,{}).sourceText,'');
  const app={...group,name:'Same Name',appPath:'/Applications/A.app',presentation:{name:null,sources:[{name:'Same Name',appPath:'/Applications/B.app',evidence:'different application'}]}};
  assert.equal(applicationIdentity(app,{}).sourceText,'Same Name','different applications with equal display names remain distinguishable by path');
});
