import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {fileURLToPath} from 'node:url';
const load=name=>{
 const code=buildSync({entryPoints:[fileURLToPath(new URL('../src/'+name,import.meta.url))],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;
 const module={exports:{}};new Function('module','exports',code)(module,module.exports);return module.exports;
};
const model=load('model.ts'),{createApi}=load('api.ts');

test('older widget config selections remain compatible with current context selections',()=>{
 assert.deepEqual(model.contextSelection({config:{selection:{deviceId:'legacy',view:'power'}}}),{deviceId:'legacy',view:'power'});
 assert.deepEqual(model.contextSelection({selection:{deviceId:'current'},config:{selection:{deviceId:'legacy',view:'power'}}}),{deviceId:'current',view:'power'});
});

test('zero battery is a real reading, missing and invalid readings stay unknown',()=>{
 assert.equal(model.batteryLevel('0%'),0);assert.equal(model.batteryLevel('82%'),82);
 for(const input of [null,undefined,'','—','101%','-1%','NaN%'])assert.equal(model.batteryLevel(input),null);
 assert.equal(model.watts(null),'未提供');assert.equal(model.watts(0),'0.0');assert.equal(model.watts(-12.5),'12.5');
});
test('device artwork selection uses a known family, never a substring or a guessed color',()=>{
 assert.equal(model.family({kind:'phone',name:'iPhone 15'}),'iphone');
 assert.equal(model.family({kind:'phone',name:'Samsung Galaxy'}),undefined);
 assert.equal(model.family({kind:'phone',name:'not-an-iPhone'}),undefined);
 assert.equal(model.family({kind:'headphones',name:'AirPods Pro 2'}),'airpods-pro');
 assert.equal(model.family({kind:'headphones',name:'AirPods 4'}),'airpods');
 assert.equal(model.family({kind:'headphones',name:'Other AirPods headset'}),undefined);
});
test('power supply and battery direction remain independent from adapter rating',()=>{
 assert.deepEqual(model.source({externalConnected:true,batteryPresent:false}),{label:'外接电源',state:'无内置电池'});
 assert.equal(model.source({externalConnected:false,adapterWatts:96}).label,'电池');
 assert.equal(model.source({externalConnected:true,batterySideWatts:-3.4}).label,'混合供电');
 assert.equal(model.source({adapterWatts:96}).label,'未提供');
});
test('display class uses pixel dimensions and does not infer a missing physical resolution',()=>{
 assert.equal(model.displaySpec({pixelResolution:'2160 × 3840',refreshRate:'60 Hz'}),'4K · 60 Hz');
 assert.equal(model.displaySpec({logicalResolution:'3840 × 2160',refreshRate:'60 Hz'}),'60 Hz');
 assert.equal(model.displayType({name:'Built-in display'}),'类型未提供');
});
test('expired and failed snapshots are distinguishable from current connections',()=>{
 assert.equal(model.isStale({at:1000,stale:false},1100),false);
 assert.equal(model.isStale({at:1000,stale:false},121001),true);
 assert.equal(model.isStale({at:1000,stale:false,error:'timeout'},1100),true);
});

function host({widget=false,preview=false}={}) {
 const sent=[],listeners=new Set();const parent={postMessage:message=>sent.push(message)};
 const result={parent,document:{body:{dataset:{surface:widget?'detail':'main'}}},location:new URL('https://local.test/ui/index.html?preview=1#flowhubWidgetToken=secret'),addEventListener:(name,fn)=>{if(name==='message')listeners.add(fn)},removeEventListener:(name,fn)=>listeners.delete(fn)};
 if(preview)result.parent=result;
 return {window:result,sent,receive:(data,source=parent)=>listeners.forEach(fn=>fn({source,data}))};
}
test('hosted page cannot opt into demo data, and accepts only its parent response',async()=>{
 const h=host(),api=createApi(h.window),promise=api.request('snapshot',{powerIntervalSeconds:5});
 assert.equal(api.preview,false);assert.equal(h.sent[0].type,'flowhub:request');
 let resolved=false;promise.then(()=>resolved=true);
 h.receive({type:'flowhub:response',id:h.sent[0].id,result:{devices:[]}},{});await Promise.resolve();assert.equal(resolved,false);
 h.receive({type:'flowhub:response',id:h.sent[0].id,result:{at:42}});assert.deepEqual(await promise,{at:42});api.dispose();
});
test('widget initialization preserves selection and requires its token for RPC',async()=>{
 const h=host({widget:true}),api=createApi(h.window);let context;
 api.onReady(value=>context=value);api.start();assert.equal(h.sent[0].type,'flowhub:widget-ready');
 h.receive({type:'flowhub:widget-init',token:'wrong',context:{selection:{view:'power'}}});assert.equal(context,undefined);
 h.receive({type:'flowhub:widget-init',token:'secret',context:{selection:{deviceId:'test'},config:{powerIntervalSeconds:30}}});
 assert.equal(context.selection.deviceId,'test');
 const result=api.request('snapshot',{powerIntervalSeconds:30});const request=h.sent.at(-1);
 assert.equal(request.params.action,'management');assert.equal(request.params.params.powerIntervalSeconds,30);
 h.receive({type:'flowhub:widget-result',token:'secret',id:request.id,result:{ok:true}});assert.deepEqual(await result,{ok:true});api.dispose();
});
test('transport has bounded waits and disposes outstanding requests',async()=>{
 const h=host(),api=createApi(h.window,3);await assert.rejects(api.request('snapshot'),/设备响应超时/);
 const pending=api.request('snapshot');const rejection=assert.rejects(pending,/页面已关闭/);api.dispose();await rejection;
 await assert.rejects(api.request('snapshot'),/页面已关闭/);
});
test('standalone preview remains read-only with explicit fixtures',async()=>{
 const h=host({preview:true}),api=createApi(h.window);const data=await api.request('snapshot');
 assert.equal(data.devices.length,9);assert.equal(h.sent.length,0);await assert.rejects(api.request('pair'),/只读预览/);api.dispose();
});
