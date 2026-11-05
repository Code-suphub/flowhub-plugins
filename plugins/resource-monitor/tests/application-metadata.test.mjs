import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

async function moduleAt(entry,plugins=[]) {
  const result=await build({entryPoints:[new URL(entry,import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'esm',loader:{'.svg':'dataurl'},plugins});
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const {createApplicationMetadataRequests}=await moduleAt('../src/application-metadata.ts');
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};

class Clock {
  time=0;sequence=0;timers=new Map();delays=[];
  now=()=>this.time;
  setTimeout=(callback,delay)=>{
    assert.ok(Number.isFinite(delay)&&delay>=0);
    this.delays.push(delay);
    const id=++this.sequence;
    this.timers.set(id,{at:this.time+delay,callback});
    return id;
  };
  clearTimeout=id=>{this.timers.delete(id);};
  async advance(ms) {
    const target=this.time+ms;
    let iterations=0;
    for(;;) {
      const next=[...this.timers].sort((a,b)=>a[1].at-b[1].at).find(([,timer])=>timer.at<=target);
      if(!next)break;
      assert.ok(++iterations<1000,'scheduler must not spin');
      const [id,timer]=next;
      this.time=timer.at;this.timers.delete(id);timer.callback();await flush();
    }
    this.time=target;await flush();
  }
}

function host(clock,{allowOverlap=false}={}) {
  const calls=[];
  return {preview:false,calls,invoke(method,{paths}) {
    assert.equal(method,'application_metadata');
    assert.ok(paths.length>0&&paths.length<=64);
    assert.equal(new Set(paths).size,paths.length);
    const pending=calls.filter(call=>!call.settled).flatMap(call=>call.paths);
    if(!allowOverlap)assert.ok(paths.every(path=>!pending.includes(path)),'a path cannot overlap an in-flight batch');
    return new Promise((resolve,reject)=>{
      const call={paths:[...paths],at:clock.now(),settled:false,
        resolve(value){call.settled=true;resolve(value);},reject(error){call.settled=true;reject(error);}};
      calls.push(call);
    });
  }};
}

const path=name=>`/Applications/${name}.app`;
const png='data:image/png;base64,bmF0aXZl';
const app=(path,iconUrl=png,name='本地化应用')=>({path,name,bundleId:'local.fixture',iconUrl});
const rows=call=>call.paths.map(path=>app(path));
function fixture(t) {
  const clock=new Clock(),api=host(clock),updates=[];
  const requests=createApplicationMetadataRequests(api,value=>updates.push(value),clock);
  t.after(()=>requests.dispose());
  return {clock,api,updates,requests,get applications(){return updates.at(-1)??{};}};
}

test('a transport timeout recovers after 1s; successes stay cached across repeated snapshots and hide/show',async t=>{
  const f=fixture(t),a=path('A');
  f.requests.setPaths([a,a]);
  for(let i=0;i<10;i++)f.requests.setPaths([a]);
  assert.equal(f.api.calls.length,1);
  f.api.calls[0].reject(new Error('插件响应超时，请刷新核实状态'));await flush();
  assert.equal(f.clock.timers.size,1);
  await f.clock.advance(999);f.requests.setPaths([a]);assert.equal(f.api.calls.length,1);
  await f.clock.advance(1);assert.equal(f.api.calls.length,2);
  f.api.calls[1].resolve({applications:[app(a)]});await flush();
  assert.equal(f.applications[a].name,'本地化应用');assert.equal(f.applications[a].iconUrl,png);
  f.requests.setPaths([]);f.requests.setPaths([a]);
  await f.clock.advance(120000);
  assert.deepEqual(f.api.calls.map(call=>call.at),[0,1000]);
  assert.equal(f.clock.timers.size,0);
});

test('retries stop after four attempts at 0/1/3/7s and view churn cannot replenish the budget',async t=>{
  const f=fixture(t),a=path('A');f.requests.setPaths([a]);
  for(const [index,delay] of [1000,2000,4000,0].entries()) {
    assert.equal(f.api.calls.length,index+1);
    f.api.calls[index].reject(new Error('无法连接 FlowHub'));await flush();
    f.requests.setPaths([]);assert.equal(f.clock.timers.size,0);
    f.requests.setPaths([a]);
    if(delay) {await f.clock.advance(delay-1);assert.equal(f.api.calls.length,index+1);await f.clock.advance(1);}
  }
  await f.clock.advance(120000);
  for(let i=0;i<10;i++){f.requests.setPaths([]);f.requests.setPaths([a]);await f.clock.advance(5000);}
  assert.deepEqual(f.api.calls.map(call=>call.at),[0,1000,3000,7000]);
  assert.ok(f.clock.delays.every(delay=>delay<=4000));assert.equal(f.clock.timers.size,0);
  assert.deepEqual(f.applications,{});
});

test('legacy main/widget and explicit method-not-found hosts fail only one probe even with many paths',async t=>{
  for(const error of [new Error('未知插件方法'),new Error('不支持的组件操作'),new Error('Unknown command application_metadata'),new Error('Method application_metadata not found'),new Error('application_metadata is not supported'),new Error('未知方法：application_metadata'),{code:-32601},{code:'METHOD_NOT_FOUND'}]) {
    await t.test(String(error.message??error.code),async t=>{
      const f=fixture(t);f.requests.setPaths(Array.from({length:193},(_,i)=>path(String(i))));
      assert.equal(f.api.calls.length,1);assert.equal(f.api.calls[0].paths.length,64);
      f.api.calls[0].reject(error);await flush();
      for(let i=0;i<12;i++){f.requests.setPaths([path(`new-${i}`)]);await f.clock.advance(5000);}
      assert.equal(f.api.calls.length,1);assert.equal(f.clock.timers.size,0);assert.deepEqual(f.applications,{});
    });
  }
});

test('a synchronous unsupported dispatch error stops the initial batch loop',async t=>{
  const clock=new Clock();let calls=0;
  const requests=createApplicationMetadataRequests({invoke(){calls++;throw new Error('不支持的组件操作');}},()=>assert.fail('no metadata'),clock);
  t.after(()=>requests.dispose());
  requests.setPaths(Array.from({length:193},(_,i)=>path(String(i))));
  await flush();await clock.advance(60000);
  assert.equal(calls,1);assert.equal(clock.timers.size,0);
});

test('ordinary missing-app, icon-format and I/O errors remain retryable',async t=>{
  for(const message of ['Application not found','Unsupported image format','应用信息读取失败']) {
    const f=fixture(t),a=path(message);f.requests.setPaths([a]);
    f.api.calls[0].reject(new Error(message));await flush();await f.clock.advance(1000);
    assert.equal(f.api.calls.length,2);
    f.api.calls[1].resolve({applications:[app(a)]});await flush();
    assert.equal(f.applications[a].iconUrl,png);assert.equal(f.clock.timers.size,0);
  }
});

test('partial responses publish names immediately and retry only missing rows or empty icons',async t=>{
  const f=fixture(t),a=path('A'),b=path('B'),c=path('C'),foreign=path('Not requested');
  f.requests.setPaths([a,b,c]);
  f.api.calls[0].resolve({applications:[null,app(a),app(b,''),app(c,png,''),app(foreign)]});await flush();
  assert.deepEqual(Object.keys(f.applications).sort(),[a,b]);assert.equal(f.applications[b].name,'本地化应用');
  await f.clock.advance(1000);assert.deepEqual(f.api.calls[1].paths,[b,c]);
  f.api.calls[1].resolve({applications:[app(b),app(b,''),app(c,'')]});await flush();
  assert.equal(f.applications[b].iconUrl,png);assert.equal(f.applications[c].iconUrl,'');
  await f.clock.advance(2000);assert.deepEqual(f.api.calls[2].paths,[c]);
  f.api.calls[2].resolve({applications:[app(c)]});await flush();
  await f.clock.advance(60000);
  assert.equal(f.api.calls.length,3);assert.equal(f.clock.timers.size,0);
  assert.equal(f.applications[foreign],undefined);
});

test('an empty index can recover; later malformed or missing rows never discard a cached name',async t=>{
  const f=fixture(t),a=path('A');f.requests.setPaths([a]);
  f.api.calls[0].resolve({applications:[]});await flush();await f.clock.advance(1000);
  f.api.calls[1].resolve({applications:[app(a,'','已恢复名称')]});await flush();
  assert.equal(f.applications[a].name,'已恢复名称');
  await f.clock.advance(2000);f.api.calls[2].resolve({applications:{bad:true}});await flush();
  assert.equal(f.applications[a].name,'已恢复名称');
  await f.clock.advance(4000);f.api.calls[3].resolve(null);await flush();
  assert.equal(f.applications[a].name,'已恢复名称');assert.equal(f.api.calls.length,4);assert.equal(f.clock.timers.size,0);
});

test('permanently absent/remote/empty-data icons use a finite shared retry budget',async t=>{
  const f=fixture(t),a=path('A');f.requests.setPaths([a]);
  const icons=['','https://invalid.example/icon.png','data:image/png;base64,',''];
  for(const [index,icon] of icons.entries()) {
    f.api.calls[index].resolve({applications:[app(a,icon)]});await flush();
    assert.equal(f.applications[a].iconUrl,'');assert.equal(f.applications[a].name,'本地化应用');
    if(index<3)await f.clock.advance([1000,2000,4000][index]);
  }
  await f.clock.advance(60000);
  assert.equal(f.api.calls.length,4);assert.equal(f.clock.timers.size,0);
});

test('a native related-application icon completes a path even if the helper icon is absent',async t=>{
  const f=fixture(t),a=path('Helper');f.requests.setPaths([a]);
  f.api.calls[0].resolve({applications:[{...app(a,''),relatedApplication:{...app(path('Parent')),evidence:'verified'}}]});await flush();
  await f.clock.advance(60000);
  assert.equal(f.api.calls.length,1);assert.equal(f.applications[a].relatedApplication.iconUrl,png);assert.equal(f.clock.timers.size,0);
});

test('concurrent batches deduplicate paths; one failing batch cannot block queued independent paths',async t=>{
  const f=fixture(t),paths=Array.from({length:193},(_,i)=>path(String(i)));
  f.requests.setPaths(paths);assert.equal(f.api.calls.length,1);
  f.requests.setPaths([...paths].reverse());assert.equal(f.api.calls.length,1);
  f.api.calls[0].resolve({applications:[...rows(f.api.calls[0]),app(paths[192],png,'另一批次的未请求结果')]});await flush();
  assert.equal(f.api.calls.length,3);assert.equal(f.api.calls.filter(call=>!call.settled).length,2);
  assert.equal(f.applications[paths[192]],undefined,'even an active path must belong to the responding batch');
  const requested=new Set(f.api.calls.flatMap(call=>call.paths)),queued=paths.filter(path=>!requested.has(path));
  f.requests.setPaths([...paths,...paths]);assert.equal(f.api.calls.length,3);
  f.api.calls[1].reject(new Error('暂时失败'));await flush();
  assert.equal(f.api.calls.length,4);assert.deepEqual(f.api.calls[3].paths,queued);
  // Full slots have no spinning retry timer; completion will wake the scheduler.
  assert.equal(f.clock.timers.size,0);await f.clock.advance(1000);assert.equal(f.api.calls.length,4);
  f.api.calls[2].resolve({applications:rows(f.api.calls[2])});await flush();
  assert.equal(f.api.calls.length,5);assert.deepEqual([...f.api.calls[4].paths].sort(),[...f.api.calls[1].paths].sort());
  f.api.calls[3].resolve({applications:rows(f.api.calls[3])});f.api.calls[4].resolve({applications:rows(f.api.calls[4])});await flush();
  assert.equal(Object.keys(f.applications).length,193);assert.equal(f.clock.timers.size,0);
  await f.clock.advance(60000);assert.equal(f.api.calls.length,5);
});

test('path removal clears wakeups and ignores removed/re-added paths in old responses without overlapping requests',async t=>{
  const f=fixture(t),a=path('A'),b=path('B');f.requests.setPaths([a,b]);
  f.requests.setPaths([b]);f.requests.setPaths([a,b]);
  assert.equal(f.api.calls.length,1);
  f.api.calls[0].resolve({applications:[app(a,png,'过期名称'),app(b)]});await flush();
  assert.equal(f.applications[a],undefined);assert.equal(f.applications[b].iconUrl,png);
  assert.equal(f.clock.timers.size,1);
  f.requests.setPaths([b]);assert.equal(f.clock.timers.size,0);await f.clock.advance(5000);assert.equal(f.api.calls.length,1);
  f.requests.setPaths([a,b]);assert.equal(f.api.calls.length,2);assert.deepEqual(f.api.calls[1].paths,[a]);
  f.api.calls[1].resolve({applications:[app(a,png,'当前名称')]});await flush();
  assert.equal(f.applications[a].name,'当前名称');assert.equal(f.clock.timers.size,0);
});

test('disposal cancels retry timers and late fulfillments/rejections cannot publish or schedule',async t=>{
  const f=fixture(t),a=path('A');f.requests.setPaths([a]);
  f.api.calls[0].reject(new Error('暂时失败'));await flush();assert.equal(f.clock.timers.size,1);
  f.requests.dispose();assert.equal(f.clock.timers.size,0);f.requests.setPaths([a]);await f.clock.advance(60000);assert.equal(f.api.calls.length,1);
  for(const reject of [false,true]) {
    const f=fixture(t);f.requests.setPaths([a]);f.requests.dispose();
    if(reject)f.api.calls[0].reject(new Error('超时'));else f.api.calls[0].resolve({applications:[app(a)]});
    await flush();await f.clock.advance(60000);
    assert.equal(f.updates.length,0);assert.equal(f.api.calls.length,1);assert.equal(f.clock.timers.size,0);
  }
});

// Run the production hook with a tiny effect/state adapter, not a second
// scheduler. It lets these tests inspect the interval before passive effects,
// cleanup/replay, and writes after unmount without adding a DOM dependency.
const hooksKey=Symbol.for('flowhub.application-metadata.test-hooks');
const {useApplications,applicationIcon,AppMark}=await moduleAt('../src/applications.tsx',[{
  name:'controlled-hooks',setup(build) {
    build.onResolve({filter:/^react(?:\/jsx-runtime)?$/},args=>({path:args.path,namespace:'controlled-hooks'}));
    build.onLoad({filter:/.*/,namespace:'controlled-hooks'},args=>({contents:args.path==='react'
      ?`const hooks=()=>globalThis[Symbol.for('flowhub.application-metadata.test-hooks')]; export const useState=(...args)=>hooks().useState(...args); export const useRef=(...args)=>hooks().useRef(...args); export const useEffect=(...args)=>hooks().useEffect(...args);`
      :'export const jsx=(type,props)=>({type,props}); export const jsxs=jsx;'}));
  }
}]);

function hookView(t,clock,hook=useApplications) {
  const records=[];let cursor=0,dirty=false,mounted=true,pending=[],args=[],value,lateWrites=0,writes=0;
  const runtime={
    useState(initial) {
      const index=cursor++;
      if(!records[index])records[index]={value:typeof initial==='function'?initial():initial};
      const record=records[index];
      return [record.value,next=>{writes++;if(!mounted){lateWrites++;return;}record.value=typeof next==='function'?next(record.value):next;dirty=true;}];
    },
    useRef(initial) {const index=cursor++;return records[index]??(records[index]={current:initial});},
    useEffect(effect,deps) {
      const index=cursor++,previous=records[index];
      const changed=!previous||deps.some((dep,i)=>!Object.is(dep,previous.deps[i]));
      const record=records[index]={...previous,effect,deps};if(changed)pending.push(record);
    }
  };
  t.mock.method(globalThis,'setTimeout',clock.setTimeout);t.mock.method(globalThis,'clearTimeout',clock.clearTimeout);t.mock.method(Date,'now',clock.now);
  globalThis[hooksKey]=runtime;
  const view={
    renderOnly(...next) {args=next;cursor=0;pending=[];dirty=false;value=hook(...args);return value;},
    commit() {for(const record of pending)record.cleanup?.();for(const record of pending)record.cleanup=record.effect();pending=[];},
    flushRenders() {let count=0;while(dirty&&mounted){assert.ok(++count<20);view.renderOnly(...args);view.commit();}return value;},
    update(...args) {view.renderOnly(...args);view.commit();return view.flushRenders();},
    replayEffects() {for(const record of records)record.cleanup?.();for(const record of records)if(record.effect)record.cleanup=record.effect();return view.flushRenders();},
    unmount() {mounted=false;for(const record of records)record.cleanup?.();},
    get value(){return view.flushRenders();},get writes(){return writes;},get lateWrites(){return lateWrites;}
  };
  t.after(()=>{view.unmount();delete globalThis[hooksKey];});
  return view;
}

test('useApplications hides cached metadata before replacement effects and cancels old timers',async t=>{
  const clock=new Clock(),oldApi=host(clock),newApi=host(clock),a=path('A'),b=path('B'),view=hookView(t,clock);
  view.update(oldApi,[{appPath:a}]);oldApi.calls[0].resolve({applications:[app(a)]});await flush();assert.equal(view.value[a].iconUrl,png);
  view.update(oldApi,[{appPath:a},{appPath:b}]);oldApi.calls[1].reject(new Error('超时'));await flush();assert.equal(clock.timers.size,1);
  assert.deepEqual(view.renderOnly(newApi,[{appPath:a}]),{});view.commit();view.flushRenders();
  assert.equal(clock.timers.size,0);assert.equal(newApi.calls.length,1);
  newApi.calls[0].resolve({applications:[app(a,png,'新连接名称')]});await flush();assert.equal(view.value[a].name,'新连接名称');
  await clock.advance(60000);assert.equal(oldApi.calls.length,2);assert.equal(newApi.calls.length,1);
});

test('useApplications ignores an outstanding old API response and a response after unmount',async t=>{
  const clock=new Clock(),oldApi=host(clock),newApi=host(clock),a=path('A'),view=hookView(t,clock);
  view.update(oldApi,[{appPath:a}]);view.update(newApi,[{appPath:a}]);
  newApi.calls[0].resolve({applications:[app(a,png,'当前名称')]});await flush();assert.equal(view.value[a].name,'当前名称');
  const writes=view.writes;oldApi.calls[0].resolve({applications:[app(a,png,'旧名称')]});await flush();
  assert.equal(view.writes,writes);assert.equal(view.value[a].name,'当前名称');
  view.update(newApi,[{appPath:path('B')}]);view.unmount();const unmountedWrites=view.writes;
  newApi.calls[1].resolve({applications:[app(path('B'))]});await flush();await clock.advance(60000);
  assert.equal(view.writes,unmountedWrites);assert.equal(view.lateWrites,0);assert.equal(clock.timers.size,0);
});

test('useApplications scopes unsupported capability to the old API so a replacement can recover',async t=>{
  const clock=new Clock(),oldApi=host(clock),newApi=host(clock),view=hookView(t,clock),a=path('A');
  view.update(oldApi,[{appPath:a}]);oldApi.calls[0].reject(new Error('未知插件方法'));await flush();
  view.update(oldApi,[{appPath:path('B')}]);await clock.advance(5000);assert.equal(oldApi.calls.length,1);
  view.update(newApi,[{appPath:a}]);assert.equal(newApi.calls.length,1);
  newApi.calls[0].reject(new Error('插件响应超时'));await flush();await clock.advance(1000);assert.equal(newApi.calls.length,2);
  newApi.calls[1].resolve({applications:[app(a)]});await flush();
  assert.equal(view.value[a].iconUrl,png);assert.equal(clock.timers.size,0);assert.equal(oldApi.calls.length,1);
});

test('useApplications observes preview transitions with the same API and paths and collects all source paths once',async t=>{
  const clock=new Clock(),api=host(clock),view=hookView(t,clock),a=path('A'),b=path('B'),c=path('C');
  const groups=[{appPath:a,origin:{appPath:b},presentation:{sources:[{appPath:c},{appPath:a}]}},{appPath:b}];
  api.preview=true;view.update(api,groups);assert.equal(api.calls.length,0);
  api.preview=false;view.update(api,groups);assert.deepEqual(api.calls[0].paths,[a,b,c]);
  api.calls[0].reject(new Error('暂时失败'));await flush();assert.equal(clock.timers.size,1);
  api.preview=true;view.update(api,groups);assert.equal(clock.timers.size,0);
  await clock.advance(1000);api.preview=false;view.update(api,groups);assert.equal(api.calls.length,2);
  view.unmount();api.calls[1].reject(new Error('超时'));await flush();
  assert.equal(view.lateWrites,0);assert.equal(clock.timers.size,0);
});

test('effect cleanup/replay leaves only the current scheduler and unmount cancels its retry',async t=>{
  // The bridge cannot abort the first mount's physical request. Overlap across
  // distinct mount lifetimes is allowed here; its result must stay invalidated.
  const clock=new Clock(),api=host(clock,{allowOverlap:true}),view=hookView(t,clock),a=path('A');
  view.update(api,[{appPath:a}]);view.replayEffects();assert.equal(api.calls.length,2);
  api.calls[0].resolve({applications:[app(a,png,'旧挂载')]});api.calls[1].reject(new Error('暂时失败'));await flush();
  assert.deepEqual(view.value,{});assert.equal(clock.timers.size,1);
  view.unmount();assert.equal(clock.timers.size,0);await clock.advance(60000);assert.equal(api.calls.length,2);assert.equal(view.lateWrites,0);
});

test('native/related icon priority, builtins and initials survive absent, invalid and failed native icons',t=>{
  const clock=new Clock(),a=path('A'),native=app(a),builtin=applicationIcon('python');
  assert.ok(builtin.startsWith('data:image/svg+xml'));
  assert.equal(applicationIcon('python',native),png);
  assert.equal(applicationIcon('python',app(a,'data:image/png;base64,')),builtin);
  assert.equal(applicationIcon('python',app(a,'https://invalid.example/icon.png')),builtin);
  const related={...native,relatedApplication:{...app(path('Parent'),'data:image/png;base64,cGFyZW50'),evidence:'verified'}};
  assert.equal(applicationIcon('python',related),related.relatedApplication.iconUrl);
  assert.equal(applicationIcon('python',related,[related.relatedApplication.iconUrl]),png);
  const view=hookView(t,clock,AppMark);
  let mark=view.update({name:'Alpha',application:native,iconKey:'python'});assert.equal(mark.props.children.props.src,png);
  mark.props.children.props.onError();mark=view.value;assert.equal(mark.props.children.props.src,builtin);
  mark.props.children.props.onError();assert.equal(view.value.props.children,'A');
});
