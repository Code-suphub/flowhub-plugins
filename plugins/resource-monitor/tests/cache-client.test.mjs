import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {webcrypto} from 'node:crypto';
async function moduleAt(entry){const result=await build({entryPoints:[new URL(entry,import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'esm'});return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);}
const model=await moduleAt('../src/model.ts'),{createApi,readGroupDetail}=await moduleAt('../src/api.ts');
function host(surface='main',token=''){
 const bus=new EventTarget(),messages=[],parent={postMessage:message=>messages.push(message)};
 const window={document:{body:{dataset:{surface}}},location:{hash:token?`#flowhubWidgetToken=${token}`:''},crypto:webcrypto,parent,addEventListener:bus.addEventListener.bind(bus),removeEventListener:bus.removeEventListener.bind(bus)};
 return {window,messages,receive(data){const event=new Event('message');Object.assign(event,{data,source:parent});bus.dispatchEvent(event);}};
}
test('summary search preserves every process/source field and localized labels without transporting processes',()=>{
 const sample=model.sampleSnapshot(),group=sample.groups[0],p=group.processes[1];
 Object.assign(p,{displayName:'Registered Worker',launchExecutable:'/launch/component',terminalOwner:{pid:9090,uid:501,started:1,executable:'/terminal/owner'},runtimeProject:{name:'fixture-project',root:'/project/root',entry:'/project/entry.mjs',evidence:'fixture'}});
 group.presentation={name:'Fixture Service',sources:[{name:'Source App',appPath:'/Applications/Source.app',evidence:'display only'}],services:[{name:'Registered Service',label:'local.private-label',evidence:'fixture'}]};
 for(const query of ['Codex','Registered Worker',p.name,String(p.pid),String(p.ppid),p.parentName,p.executable,p.cwd,'/launch/component','/terminal/owner','fixture-project','/project/root','/project/entry.mjs','Source App','Source.app','Registered Service','private-label']){
   const ranking=model.rankingFrom(sample,query),expected=model.filterGroups(sample.groups,query,false,'footprint').map(g=>g.id);
   assert.deepEqual(model.filterRanking(ranking.groups,query,ranking.matchedGroupIds,false,'footprint').map(g=>g.id),expected,query);
 }
 const ranking=model.rankingFrom(sample),row=ranking.groups.find(g=>g.id===group.id);
 for(const field of ['memory','footprint','cpu','incomplete','footprintIncomplete','canTerminate'])assert.equal(row[field],group[field]);
 assert.equal(row.processCount,group.processes.length);assert.equal(row.processes,undefined);assert.equal(row.instances,undefined);
 assert.equal(JSON.stringify(ranking).includes('local.private-label'),false);assert.equal(JSON.stringify(ranking).includes('/project/root'),false);
 assert.equal(model.filterRanking([{...row,name:'本地化应用名'}],'本地化应用名',[],false,'footprint').length,1);
 const restricted=structuredClone(sample);restricted.groups.at(-1).processes[0].protection='其他用户或系统账户';
 const hidden=model.rankingFrom(restricted,'',false);assert.equal(hidden.groups.some(g=>g.system),false);assert.equal(hidden.hasRestrictedProcesses,true);
});
test('selected group detail keeps instance data, moved rows and PID reuse separate with exact context identities',()=>{
 const initial=model.sampleSnapshot(),group=initial.groups[0],moving=group.processes[0],reused=group.processes[1];
 group.instances=[{id:'selected',root:moving,count:group.processes.length,canTerminate:true}];
 const current=structuredClone(initial);current.groups[0].processes=current.groups[0].processes.filter(p=>p.pid!==moving.pid);current.groups[0].processes[0].started++;
 current.groups[1].processes.push({...moving,groupId:current.groups[1].id});
 const result=model.detailFrom(current,group.id,[moving.pid,reused.pid],[moving.pid]);
 assert.deepEqual(result.group.instances,group.instances);assert.equal(result.groups,undefined);assert.equal(result.contextProcesses.length,1);
 const detail=model.updateDetail(group,result.group,result.elsewhere);
 assert.equal(detail.processes[0].moved,true);assert.equal(detail.processes[0].protected,true);assert.equal(detail.processes[0].exited,false);
 assert.equal(detail.processes[1].exited,true);assert.equal(detail.processes.at(-1).pid,reused.pid);assert.notEqual(detail.processes.at(-1).started,reused.started);
 const contexts={at:current.at,entries:[{id:'one',processes:[moving,moving]},{id:'reused',processes:[reused]}]};
 const rows=model.contextRows(contexts,{groups:[{processes:[...result.group.processes,...result.contextProcesses]}]},current.at);
 assert.equal(rows[0].liveProcesses.length,1);assert.equal(rows[0].memory,moving.memory);assert.equal(rows[1].liveProcesses.length,0);
 assert.equal(model.detailFrom(current,'gone',[moving.pid]).group,null);
});
test('publication revision handles failures and sampling updates at the same sample timestamp',()=>{
 assert.equal(model.newerSnapshot({at:100,revision:12},{at:100,revision:11}),true);
 assert.equal(model.newerSnapshot({at:100,revision:10},{at:100,revision:11}),false);
 assert.equal(model.newerSnapshot({at:99},{at:100}),false);
});
test('main status uses the private status protocol and summary/detail requests stay scoped through both transports',async t=>{
 for(const surface of ['main','detail']){
   const h=host(surface,surface==='detail'?'token':''),api=createApi(h.window);
   t.after(()=>api.dispose());
   if(surface==='detail')h.receive({type:'flowhub:widget-init',token:'token',context:{config:{}}});
   const status=api.status(),message=h.messages.at(-1);
   assert.equal(surface==='main'?message.method:message.params.action,surface==='main'?'status_snapshot':'snapshot');
   const response=(message,result)=>h.receive({type:surface==='main'?'flowhub:response':'flowhub:widget-result',token:'token',id:message.id,result});
   response(message,{at:10,rows:[],system:{}});assert.equal((await status).at,10);
   for(const [method,params] of [['ranking_snapshot',{query:'child-pid',includeSystem:false}],['group_detail',{groupId:'only-this-group',trackedPids:[401],contextPids:[402]}],['refresh_summary',{query:''}]]){
     const request=api.invoke(method,params),message=h.messages.at(-1);
     assert.equal(surface==='main'?message.method:message.params.method,method);
     assert.deepEqual(message.params._trace,{traceId:message.id,surface});
     const {_trace,...mainParams}=message.params;
     assert.deepEqual(surface==='main'?mainParams:message.params.params,params);
     response(message,{at:11});assert.equal((await request).at,11);
   }
   api.dispose();
 }
});
test('browser preview implements summary and selected group reads while keeping mutations disabled',async()=>{
 const h=host();h.window.parent=h.window;const api=createApi(h.window);
 const startup=await api.invoke('startup_snapshot');
 assert.deepEqual(startup.rows.map(row=>row.kind),['mysql','onedrive']);
 await assert.rejects(api.invoke('startup_set',{id:'homebrew.mxcl.mysql',confirmed:true,enabled:false}),/预览/);
 await assert.rejects(api.invoke('login_items_settings'),/预览/);
 const summary=await api.invoke('ranking_snapshot',{query:'401',includeSystem:false});
 assert.equal(summary.groups.some(g=>g.processes),false);assert.ok(summary.matchedGroupIds.includes('app:codex'));
 const detail=await api.invoke('group_detail',{groupId:'app:codex'});assert.ok(detail.group.processes.length);assert.equal(detail.group.id,'app:codex');
 const refreshed=await api.invoke('refresh_summary',{query:'471'});assert.ok(refreshed.matchedGroupIds.includes('app:arc'));
 await assert.rejects(api.invoke('terminate_confirm',{confirmed:true,token:'fixture'}),/预览/);assert.equal(h.messages.length,0);api.dispose();
});

test('large detail presence reads stay within the request limit and retry a changed publication without losing identities',async()=>{
 const pids=Array.from({length:6000},(_,i)=>100000+i),calls=[];let generation=1,changed=false;
 const api={async invoke(method,params){
   assert.equal(method,'group_detail');assert.ok(Buffer.byteLength(JSON.stringify({method,params}))<65536);calls.push(params);
   if(params.includeGroup===false&&!changed){changed=true;generation++;throw Error('详情采样版本已更新，请重试');}
   if(params.revision!=null&&params.revision!==generation)throw Error('详情采样版本已更新，请重试');
   return {at:generation,revision:generation,groupId:params.groupId,group:params.includeGroup===false?null:{id:params.groupId},elsewhere:params.trackedPids.map(pid=>({pid,started:pid,uid:501,executable:'/fixture'})),contextProcesses:params.contextPids.map(pid=>({pid,started:pid,uid:501,executable:'/fixture'}))};
 }};
 const result=await readGroupDetail(api,'selected',pids,pids);
 assert.equal(result.revision,2);assert.equal(result.group.id,'selected');assert.deepEqual(result.elsewhere.map(p=>p.pid),pids);assert.deepEqual(result.contextProcesses.map(p=>p.pid),pids);
 assert.ok(calls.some(params=>params.includeGroup===false));assert.equal(calls.filter(params=>params.includeGroup!==false).length,2);
});
