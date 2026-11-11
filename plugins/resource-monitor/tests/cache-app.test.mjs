// Exercise App's actual effects/handlers with controlled promises and a hook
// runtime. DOM/CSP rendering is covered separately by card-entry.test.mjs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const hookKey=Symbol.for('flowhub.cache-app.hooks');
const result=await build({entryPoints:[new URL('../src/App.tsx',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'controlled-app',setup(build){
 build.onResolve({filter:/^react(?:\/jsx-runtime)?$|^antd$|^@ant-design\/cssinjs$|^@local\/common-components\/react\/antd$|^@flowhub\/plugin-common\/react$|^\.\/applications$|^\.\/ResourceHistory$/},args=>({path:args.path,namespace:'controlled-app'}));
 build.onLoad({filter:/.*/,namespace:'controlled-app'},({path})=>({contents:path==='react'?`const hooks=()=>globalThis[Symbol.for('flowhub.cache-app.hooks')];${['useState','useRef','useEffect','useMemo','useDeferredValue'].map(name=>`export const ${name}=(...args)=>hooks().${name}(...args);`).join('')}`:
 path==='react/jsx-runtime'?`export const jsx=(type,props)=>({type,props});export const jsxs=jsx;export const Fragment='Fragment';`:
 path==='./ResourceHistory'?`export const ResourceHistory='ResourceHistory';`:
 path==='./applications'?`export const AppMark='AppMark';const empty={};export const useApplications=()=>empty;export const applicationIdentity=g=>({name:g.presentation?.name||g.name,description:g.source||'',originName:g.origin?.name||'',sourceText:''});export const sourceNames=s=>s.map(x=>x.name).join('、');`:
 path==='@local/common-components/react/antd'?`export const createCommonAntdTheme=()=>({});`:
 `${['Alert','ConfigProvider','Descriptions','Drawer','Empty','Switch','Table','Tabs','Tag','StyleProvider','Button','HelpPopover','Input'].map(name=>`export const ${name}='${name}';`).join('')}export const Modal=Object.assign(function Modal(){},{displayName:'Modal',confirm:options=>globalThis[Symbol.for('flowhub.cache-app.hooks')].confirm(options)});export const theme={};`}));
}}]});
const {App}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const modelBuild=await build({entryPoints:[new URL('../src/model.ts',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'esm'});
const model=await import(`data:text/javascript;base64,${Buffer.from(modelBuild.outputFiles[0].text).toString('base64')}`);
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function fixture(t){
 const records=[],calls=[],timers=new Map();let cursor=0,pending=[],dirty=false,mounted=true,tree,sequence=0,time=0,writes=0,confirmation;
 const document=new EventTarget();document.hidden=false;const originalDocument=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,writable:true,value:document});
 const timeout=(callback,delay)=>{const id=++sequence;timers.set(id,{callback,at:time+delay});return id;};
 t.mock.method(globalThis,'setTimeout',timeout);t.mock.method(globalThis,'clearTimeout',id=>timers.delete(id));
 const runtime={
   confirm(options){confirmation=options;},
   useState(initial){const index=cursor++;const record=records[index]??(records[index]={value:typeof initial==='function'?initial():initial});return [record.value,next=>{assert.ok(mounted,'state write after unmount');record.value=typeof next==='function'?next(record.value):next;dirty=true;writes++;}];},
   useRef(initial){return records[cursor++]??(records[cursor-1]={current:initial});},
   useEffect(effect,deps){const index=cursor++,old=records[index],changed=!old||deps.some((dep,i)=>!Object.is(dep,old.deps[i]));const record=records[index]={...old,effect,deps};if(changed)pending.push(record);},
   useMemo(make,deps){const index=cursor++,old=records[index];if(!old||deps.some((dep,i)=>!Object.is(dep,old.deps[i])))records[index]={deps,value:make()};return records[index].value;},
   useDeferredValue(value){return value;}
 };
 globalThis[hookKey]=runtime;
 const api={preview:false,widget:false,invoke(method,params={}){return new Promise((resolve,reject)=>calls.push({method,params,resolve,reject}));}};
 const view={calls,timers,api,get writes(){return writes;},get confirmation(){return confirmation;},
   render(){let runs=0;do{assert.ok(++runs<25);cursor=0;pending=[];dirty=false;tree=App({api,context:{}});for(const record of pending)record.cleanup?.();for(const record of pending)record.cleanup=record.effect();}while(dirty);return tree;},
   async settle(){await flush();if(dirty)view.render();await flush();if(dirty)view.render();},
   async advance(ms){time+=ms;for(const [id,timer] of [...timers])if(timer.at<=time){timers.delete(id);timer.callback();await view.settle();}},
   nodes(type){const found=[];function visit(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}if(node.type===type||node.type?.displayName===type)found.push(node);visit(node.props?.children);visit(node.props?.action);}visit(tree);return found;},
   table(){return view.nodes('Table').find(node=>node.props.columns[0].key==='name');},
   detail(){return view.nodes('Modal')[0];},
   open(row){const cell=view.table().props.columns[0].render(undefined,row);let button;function find(node){if(!node||typeof node!=='object')return;if(Array.isArray(node))return node.forEach(find);if(node.type==='button'&&node.props.className==='name-link')button=node;find(node.props?.children);}find(cell);button.props.onClick();view.render();},
   unmount(){if(!mounted)return;for(const record of records)record.cleanup?.();mounted=false;}
 };
 t.after(()=>{view.unmount();delete globalThis[hookKey];if(originalDocument)Object.defineProperty(globalThis,'document',originalDocument);else delete globalThis.document;});view.render();return view;
}
const snapshot=(revision=2)=>({...model.sampleSnapshot(),at:1000+revision,revision});
async function seed(view){const full=snapshot();const read=view.calls.find(call=>call.method==='ranking_snapshot');read.resolve(model.rankingFrom(full,'',false));await view.settle();return full;}
test('main polls only summaries; opening and closing detail scopes process reads and ignores late selections',async t=>{
 const view=fixture(t),full=await seed(view);
 assert.deepEqual(view.calls.map(call=>call.method),['ranking_snapshot']);
 view.open(view.table().props.dataSource[0]);const first=view.calls.at(-1);assert.equal(first.method,'group_detail');assert.deepEqual(first.params.trackedPids,[]);
 const other=view.table().props.dataSource[1];view.open(other);const second=view.calls.at(-1);
 second.resolve(model.detailFrom(full,other.id));await view.settle();first.resolve(model.detailFrom(full,first.params.groupId));await view.settle();
 assert.equal(view.detail().props.open,true);assert.equal(view.nodes('Table').find(node=>node.props.pagination.pageSize===12).props.dataSource[0].groupId,other.id);
 await view.advance(5000);const recent=view.calls.slice(-2);assert.ok(recent.some(call=>call.method==='ranking_snapshot'));const detail=recent.find(call=>call.method==='group_detail');assert.equal(detail.params.groupId,other.id);assert.deepEqual(detail.params.trackedPids,full.groups.find(g=>g.id===other.id).processes.map(p=>p.pid));
 view.detail().props.onCancel();view.render();detail.resolve(model.detailFrom(snapshot(4),other.id));recent.find(call=>call.method==='ranking_snapshot').resolve(model.rankingFrom(snapshot(4),'',false));await view.settle();
 assert.equal(view.detail().props.open,false);await view.advance(5000);assert.equal(view.calls.at(-1).method,'ranking_snapshot');assert.equal(view.calls.some(call=>call.method==='snapshot'||call.method==='refresh'),false);
 view.unmount();const writes=view.writes;view.calls.at(-1).resolve(model.rankingFrom(snapshot(6),'',false));await flush();assert.equal(view.writes,writes);assert.equal(view.timers.size,0);
});
test('manual sampling does not stop summary polls and an older manual response cannot replace newer failure state',async t=>{
 const view=fixture(t);await seed(view);
 view.nodes('Button').find(node=>node.props.children==='刷新').props.onClick();view.render();const manual=view.calls.at(-1);assert.equal(manual.method,'refresh_summary');
 await view.advance(5000);const poll=view.calls.at(-1);assert.equal(poll.method,'ranking_snapshot');
 const latest={...snapshot(6),error:'newest collection failure',sampling:false};poll.resolve(model.rankingFrom(latest,'',false));await view.settle();
 manual.resolve(model.rankingFrom(snapshot(4),'',false));await view.settle();assert.equal(view.nodes('Alert').some(node=>node.props.title==='newest collection failure'),true);
 const last=view.calls.at(-1);last.resolve(model.rankingFrom(latest,'',false));await view.settle();assert.equal(view.nodes('Alert').some(node=>node.props.title==='newest collection failure'),true);
});

test('open ranking and process detail recover automatically after backend reload resets revision',async t=>{
 const view=fixture(t);
 const old={...snapshot(240),at:Date.now()-21000,stale:true,sampling:true};
 view.calls.find(call=>call.method==='ranking_snapshot').resolve(model.rankingFrom(old,'',false));await view.settle();
 assert.ok(view.nodes('Alert').some(node=>node.props.title==='数据已过期，请刷新后再操作。'));
 const row=view.table().props.dataSource[0];
 view.open(row);
 view.calls.find(call=>call.method==='group_detail').resolve(model.detailFrom(old,row.id));await view.settle();
 await view.advance(5000);
 const reads=view.calls.slice(-2);
 const fresh={...snapshot(2),at:Date.now()};
 const group=fresh.groups.find(group=>group.id===row.id);
 group.processes[0].memory=1234;
 reads.find(call=>call.method==='ranking_snapshot').resolve(model.rankingFrom(fresh,'',false));
 reads.find(call=>call.method==='group_detail').resolve(model.detailFrom(fresh,row.id));await view.settle();
 assert.equal(view.nodes('Alert').some(node=>node.props.title==='数据已过期，请刷新后再操作。'),false);
 assert.equal(view.nodes('Table').find(node=>node.props.pagination.pageSize===12).props.dataSource[0].memory,1234);
 assert.equal(view.calls.some(call=>call.method==='refresh_summary'),false);
});

test('detail bulk action switches from all operable instances to explicit checkbox selection',async t=>{
 const view=fixture(t),full=snapshot(),group=full.groups[0];
 group.instances=group.processes.slice(0,3).map((p,index)=>({id:`instance-${index}`,root:p,count:1,canTerminate:index<2}));
 group.processes=group.processes.map((p,index)=>({...p,instanceId:`instance-${index}`,protected:index===2,uid:index===2?0:p.uid,protection:index===2?'其他用户或系统账户':''}));
 view.calls.find(call=>call.method==='ranking_snapshot').resolve(model.rankingFrom(full,'',false));await view.settle();
 view.open(view.table().props.dataSource.find(row=>row.id===group.id));
 view.calls.find(call=>call.method==='group_detail').resolve(model.detailFrom(full,group.id));await view.settle();
 const instances=()=>view.nodes('Table').find(node=>node.props.rowSelection);
 assert.equal(instances().props.rowSelection.getCheckboxProps(group.instances[2]).disabled,true);
 const services=view.calls.find(call=>call.method==='services_snapshot');
 services.resolve({at:Date.now(),supported:true,services:[{id:'unrelated',appPath:'/Applications/Other.app'}]});await view.settle();
 assert.equal(view.nodes('Button').filter(node=>Array.isArray(node.props.children)&&node.props.children.includes('后台服务 (')).length,0);
 view.nodes('Button').find(node=>node.props.children==='结束全部实例').props.onClick();view.render();
 let request=view.calls.at(-1);assert.equal(request.method,'terminate_preview');assert.deepEqual(request.params.instanceIds,['instance-0','instance-1']);
 request.reject(Error('fixture cancelled'));await view.settle();
 instances().props.rowSelection.onChange(['instance-1']);view.render();
 view.nodes('Button').find(node=>node.props.children==='结束所选实例').props.onClick();view.render();
 request=view.calls.at(-1);assert.deepEqual(request.params.instanceIds,['instance-1']);
 assert.equal(view.calls.some(call=>call.method==='terminate_confirm'),false,'selection must only prepare a reviewable plan');
 request.reject(Error('fixture cancelled'));await view.settle();
});

test('authorization status has one in-flight query and a timeout preserves known approval',async t=>{
 const view=fixture(t),full=snapshot();full.groups[0].processes[0].uid=0;
 view.calls.find(call=>call.method==='ranking_snapshot').resolve(model.rankingFrom(full,'',false));await view.settle();
 const queries=()=>view.calls.filter(call=>call.method==='privileged_status');
 assert.equal(queries().length,1);
 for(let i=0;i<3;i++)await view.advance(5000);
 assert.equal(queries().length,1,'slow status requests must not accumulate');
 queries()[0].resolve({ok:true,status:'enabled',rootControl:true,message:'control approved'});await view.settle();
 await view.advance(5000);assert.equal(queries().length,2);
 queries()[1].reject(Error('temporary timeout'));await view.settle();
 assert.ok(view.nodes('Alert').some(node=>node.props.title==='control approved'));
 assert.equal(view.nodes('Button').some(node=>node.props.children==='管理员授权安装'),false);
 assert.ok(view.nodes('p').some(node=>node.props.role==='status'&&String(node.props.children).includes('自动重试')));
});

async function startInstallation(view){
 const full=snapshot();full.groups[0].processes[0].uid=0;
 view.calls.find(call=>call.method==='ranking_snapshot').resolve(model.rankingFrom(full,'',false));await view.settle();
 view.calls.find(call=>call.method==='privileged_status').resolve({ok:true,status:'needsUpdate',message:'upgrade required'});await view.settle();
 view.nodes('Button').find(node=>node.props.children==='授权更新').props.onClick();
 const pending=view.confirmation.onOk();view.render();
 view.calls.find(call=>call.method==='privileged_enable').reject(Error('authentication wait timed out'));await pending;await view.settle();
}
test('a late successful installation clears its old timeout only after a fresh confirmed status',async t=>{
 const view=fixture(t);await startInstallation(view);
 const failure=()=>view.nodes('Alert').find(node=>node.props.title==='安装或升级结果尚未确认');
 assert.ok(failure());
 assert.ok(view.nodes('Button').some(node=>node.props.children==='核实中…'));
 let query=view.calls.filter(call=>call.method==='privileged_status').at(-1);
 query.resolve({ok:true,status:'enabled',message:'old cached approval',checking:true});await view.settle();assert.ok(failure(),'cached approval must not resolve an uncertain installation');
 await view.advance(5000);query=view.calls.filter(call=>call.method==='privileged_status').at(-1);
 query.resolve({ok:true,status:'enabled',rootControl:true,serviceControl:true,message:'approved',stale:true,warning:'temporarily unreachable'});await view.settle();assert.ok(failure(),'stale approval must not hide uncertainty');
 await view.advance(5000);query=view.calls.filter(call=>call.method==='privileged_status').at(-1);
 query.resolve({ok:true,status:'enabled',rootControl:true,serviceControl:true,message:'approved',checking:false});await view.settle();
 assert.equal(failure(),undefined);assert.ok(view.nodes('Alert').some(node=>node.props.title==='approved'));
 assert.equal(view.nodes('Button').some(node=>node.props.children==='重新授权安装'),false);
 assert.equal(view.calls.filter(call=>call.method==='privileged_enable').length,1,'status recovery must never retry installation');
});
test('an unresolved installation exposes status verification and an explicit reviewed retry',async t=>{
 const view=fixture(t);await startInstallation(view);
 view.calls.filter(call=>call.method==='privileged_status').at(-1).resolve({ok:true,status:'needsUpdate',message:'still needs update',checking:false});await view.settle();
 const retry=view.nodes('Button').find(node=>node.props.children==='重新授权安装');assert.ok(retry&&!retry.props.disabled);
 assert.equal(view.calls.filter(call=>call.method==='privileged_enable').length,1);
 view.nodes('Button').find(node=>node.props.children==='核实状态').props.onClick();view.render();
 const queries=view.calls.filter(call=>call.method==='privileged_status');assert.equal(queries.length,3);
 view.nodes('Button').find(node=>node.props.children==='核实中…').props.onClick();await view.settle();
 assert.equal(view.calls.filter(call=>call.method==='privileged_status').length,3,'status verification must not overlap');
 queries.at(-1).resolve({ok:true,status:'needsUpdate',message:'still needs update',checking:false});await view.settle();
 view.nodes('Button').find(node=>node.props.children==='重新授权安装').props.onClick();
 assert.ok(view.confirmation.content.includes('macOS'));assert.equal(view.calls.filter(call=>call.method==='privileged_enable').length,1,'retry must wait for the review confirmation');
 const pending=view.confirmation.onOk();view.render();assert.equal(view.calls.filter(call=>call.method==='privileged_enable').length,2);
 view.calls.filter(call=>call.method==='privileged_enable').at(-1).reject(Error('fixture cancelled'));await pending;await view.settle();
});
