// Controlled transport races use the real history component; packaged DOM,
// chart keyboard handling and themes are covered by card-entry.test.mjs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const hookKey=Symbol.for('flowhub.history-hooks');
const bundled=await build({entryPoints:[new URL('../src/ResourceHistory.tsx',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'history-hooks',setup(build){
 build.onResolve({filter:/^react(?:\/jsx-runtime)?$|^@flowhub\/plugin-common\/react$/},args=>({path:args.path,namespace:'history-hooks'}));
 build.onLoad({filter:/.*/,namespace:'history-hooks'},({path})=>({contents:path==='react'?`const hooks=()=>globalThis[Symbol.for('flowhub.history-hooks')];export const memo=component=>component;${['useState','useRef','useEffect','useMemo'].map(name=>`export const ${name}=(...args)=>hooks().${name}(...args);`).join('')}`:path==='react/jsx-runtime'?`export const jsx=(type,props)=>({type,props});export const jsxs=jsx;export const Fragment='Fragment';`:`${['Button','EmptyState','HelpPopover','HistoryChart','Select','Tabs','TabsList','TabsPanel','TabsTrigger'].map(name=>`export const ${name}='${name}';`).join('')}`}));
}}]});
const {ResourceHistory}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function fixture(t,{preview=false}={}){
 let cursor=0,pending=[],dirty=false,mounted=true,tree,sequence=0,writes=0;
 const records=[],calls=[],timers=new Map();const document=new EventTarget();document.hidden=false;
 const original=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:document});
 t.mock.method(globalThis,'setTimeout',(fn,delay)=>{const id=++sequence;timers.set(id,{fn,delay});return id;});t.mock.method(globalThis,'clearTimeout',id=>timers.delete(id));
 globalThis[hookKey]={
  useState(initial){const index=cursor++,record=records[index]??(records[index]={value:typeof initial==='function'?initial():initial});return[record.value,next=>{assert.ok(mounted,'state write after unmount');record.value=typeof next==='function'?next(record.value):next;dirty=true;writes++;}];},
  useRef(initial){return records[cursor++]??(records[cursor-1]={current:initial});},
  useMemo(make,deps){const index=cursor++,old=records[index];if(!old||deps.some((dep,i)=>!Object.is(dep,old.deps[i])))records[index]={deps,value:make()};return records[index].value;},
  useEffect(effect,deps){const index=cursor++,old=records[index],changed=!old||deps.some((dep,i)=>!Object.is(dep,old.deps[i]));const record=records[index]={...old,effect,deps};if(changed)pending.push(record);}
 };
 const api={preview,invoke(method,params){return new Promise((resolve,reject)=>calls.push({method,params,resolve,reject}));}};
 const view={calls,timers,document,get writes(){return writes;},
  render(){let runs=0;do{assert.ok(++runs<20);cursor=0;pending=[];dirty=false;tree=ResourceHistory({api,groupId:'app:first'});for(const r of pending)r.cleanup?.();for(const r of pending)r.cleanup=r.effect();}while(dirty);},
  async settle(){await flush();if(dirty)view.render();await flush();if(dirty)view.render();},
  async poll(){const timer=[...timers].find(([,timer])=>timer.delay===15000);assert.ok(timer);timers.delete(timer[0]);timer[1].fn();await view.settle();},
  nodes(type){const result=[];const visit=node=>{if(!node||typeof node!=='object')return;if(Array.isArray(node))return node.forEach(visit);if(node.type===type)result.push(node);visit(node.props?.children);};visit(tree);return result;},
  unmount(){if(!mounted)return;for(const r of records)r.cleanup?.();mounted=false;}
 };
 t.after(()=>{view.unmount();delete globalThis[hookKey];if(original)Object.defineProperty(globalThis,'document',original);else delete globalThis.document;});view.render();return view;
}
const report=(hours=48)=>({groupId:'app:first',hours,intervalSeconds:60,from:0,to:100000,points:[{at:60000,cpu:3,footprint:1048576,rss:524288,run:1,segment:1}],error:null,truncated:false});
test('history avoids overlapping reads, pauses hidden polling and ignores responses after close',async t=>{
 const v=fixture(t);assert.equal(v.calls.length,1);v.document.dispatchEvent(new Event('visibilitychange'));await v.settle();assert.equal(v.calls.length,1);
 v.calls[0].resolve(report());await v.settle();assert.equal(v.nodes('HistoryChart').length,3);
 v.document.hidden=true;await v.poll();assert.equal(v.calls.length,1);
 v.document.hidden=false;v.document.dispatchEvent(new Event('visibilitychange'));await v.settle();assert.equal(v.calls.length,2);
 v.unmount();const writes=v.writes;v.calls[1].resolve(report());await flush();assert.equal(v.writes,writes);assert.equal(v.timers.size,0);
});
test('saving retention cannot be overwritten by an older read and failures remain visible',async t=>{
 const v=fixture(t);v.calls[0].resolve(report());await v.settle();await v.poll();const older=v.calls.at(-1);
 v.nodes('Select')[0].props.onChange('168');v.render();const save=v.calls.at(-1);assert.equal(save.method,'resource_history_settings');assert.deepEqual(save.params,{groupId:'app:first',hours:168});
 save.resolve(report(168));await v.settle();older.resolve(report());await v.settle();assert.equal(v.nodes('Select')[0].props.value,'168');
 v.nodes('Select')[0].props.onChange('48');v.calls.at(-1).reject(Error('磁盘不可写'));await v.settle();assert.equal(v.nodes('Select')[0].props.value,'168');assert.ok(v.nodes('p').some(n=>n.props.role==='alert'&&n.props.children==='磁盘不可写'));
});
test('wrong application report clears the chart and preview cannot write retention',async t=>{
 const v=fixture(t,{preview:true});v.calls[0].resolve(report());await v.settle();assert.equal(v.nodes('Select')[0].props.disabled,true);
 v.nodes('Select')[0].props.onChange('168');assert.equal(v.calls.length,1);
 await v.poll();v.calls.at(-1).resolve({...report(),groupId:'app:other'});await v.settle();assert.equal(v.nodes('HistoryChart').length,0);assert.ok(v.nodes('p').some(n=>String(n.props.children).includes('不匹配')));
});
