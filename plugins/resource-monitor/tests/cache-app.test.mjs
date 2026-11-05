// Exercise App's actual effects/handlers with controlled promises and a hook
// runtime. DOM/CSP rendering is covered separately by card-entry.test.mjs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const hookKey=Symbol.for('flowhub.cache-app.hooks');
const result=await build({entryPoints:[new URL('../src/App.tsx',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'controlled-app',setup(build){
 build.onResolve({filter:/^react(?:\/jsx-runtime)?$|^antd$|^@ant-design\/cssinjs$|^@local\/common-components\/react\/antd$|^@flowhub\/plugin-common\/react$|^\.\/applications$/},args=>({path:args.path,namespace:'controlled-app'}));
 build.onLoad({filter:/.*/,namespace:'controlled-app'},({path})=>({contents:path==='react'?`const hooks=()=>globalThis[Symbol.for('flowhub.cache-app.hooks')];${['useState','useRef','useEffect','useMemo','useDeferredValue'].map(name=>`export const ${name}=(...args)=>hooks().${name}(...args);`).join('')}`:
 path==='react/jsx-runtime'?`export const jsx=(type,props)=>({type,props});export const jsxs=jsx;export const Fragment='Fragment';`:
 path==='./applications'?`export const AppMark='AppMark';const empty={};export const useApplications=()=>empty;export const applicationIdentity=g=>({name:g.presentation?.name||g.name,description:g.source||'',originName:g.origin?.name||'',sourceText:''});export const sourceNames=s=>s.map(x=>x.name).join('、');`:
 path==='@local/common-components/react/antd'?`export const createCommonAntdTheme=()=>({});`:
 `${['Alert','ConfigProvider','Descriptions','Modal','Switch','Table','Tabs','Tag','StyleProvider','Button','HelpPopover','Input'].map(name=>`export const ${name}='${name}';`).join('')}export const theme={};`}));
}}]});
const {App}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const modelBuild=await build({entryPoints:[new URL('../src/model.ts',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'esm'});
const model=await import(`data:text/javascript;base64,${Buffer.from(modelBuild.outputFiles[0].text).toString('base64')}`);
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function fixture(t){
 const records=[],calls=[],timers=new Map();let cursor=0,pending=[],dirty=false,mounted=true,tree,sequence=0,time=0,writes=0;
 const document=new EventTarget();document.hidden=false;const originalDocument=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,writable:true,value:document});
 const timeout=(callback,delay)=>{const id=++sequence;timers.set(id,{callback,at:time+delay});return id;};
 t.mock.method(globalThis,'setTimeout',timeout);t.mock.method(globalThis,'clearTimeout',id=>timers.delete(id));
 const runtime={
   useState(initial){const index=cursor++;const record=records[index]??(records[index]={value:typeof initial==='function'?initial():initial});return [record.value,next=>{assert.ok(mounted,'state write after unmount');record.value=typeof next==='function'?next(record.value):next;dirty=true;writes++;}];},
   useRef(initial){return records[cursor++]??(records[cursor-1]={current:initial});},
   useEffect(effect,deps){const index=cursor++,old=records[index],changed=!old||deps.some((dep,i)=>!Object.is(dep,old.deps[i]));const record=records[index]={...old,effect,deps};if(changed)pending.push(record);},
   useMemo(make,deps){const index=cursor++,old=records[index];if(!old||deps.some((dep,i)=>!Object.is(dep,old.deps[i])))records[index]={deps,value:make()};return records[index].value;},
   useDeferredValue(value){return value;}
 };
 globalThis[hookKey]=runtime;
 const api={preview:false,widget:false,invoke(method,params={}){return new Promise((resolve,reject)=>calls.push({method,params,resolve,reject}));}};
 const view={calls,timers,api,get writes(){return writes;},
   render(){let runs=0;do{assert.ok(++runs<25);cursor=0;pending=[];dirty=false;tree=App({api,context:{}});for(const record of pending)record.cleanup?.();for(const record of pending)record.cleanup=record.effect();}while(dirty);return tree;},
   async settle(){await flush();if(dirty)view.render();await flush();if(dirty)view.render();},
   async advance(ms){time+=ms;for(const [id,timer] of [...timers])if(timer.at<=time){timers.delete(id);timer.callback();await view.settle();}},
   nodes(type){const found=[];function visit(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}if(node.type===type)found.push(node);visit(node.props?.children);}visit(tree);return found;},
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
