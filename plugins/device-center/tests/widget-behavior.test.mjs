import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code=fs.readFileSync(new URL('../ui/app.js',import.meta.url),'utf8');
const orderCode=fs.readFileSync(new URL('../ui/widget-order.js',import.meta.url),'utf8');
const artCode=fs.readFileSync(new URL('../ui/device-art.js',import.meta.url),'utf8');

// Exercise the shipped widget message protocol and rendering with host snapshots.
async function mountWidget(data,config={},surface='card'){
  const sent=[],listeners={},intervals=[],controls={},categories={};
  const node={innerHTML:'',querySelectorAll:selector=>selector==='[data-widget-category]'?[...node.innerHTML.matchAll(/data-widget-category="([^"]+)"/g)].map(([,key])=>({dataset:{widgetCategory:key},addEventListener:(event,callback)=>{categories[key]=callback;}})):[],querySelector:selector=>controls[selector]||null};
  const parent={postMessage:message=>sent.push(message)};
  const window={parent,addEventListener:(name,fn)=>{listeners[name]=fn;},removeEventListener(){}};
  const document={body:{dataset:{surface},classList:{add(){}}},getElementById:()=>node,
    documentElement:{scrollHeight:440},hidden:false,createTextNode:text=>text};
  const context=vm.createContext({window,document,location:{hash:'#flowhubWidgetToken=test-token',search:''},
    URLSearchParams,structuredClone,setTimeout:()=>1,clearTimeout(){},setInterval:(fn,ms)=>{intervals.push(ms);return 1;},clearInterval(){}});
  vm.runInContext(orderCode,context);vm.runInContext(artCode,context);vm.runInContext(code,context);
  listeners.message({source:parent,data:{type:'flowhub:widget-init',token:'test-token',context:{config}}});
  if(surface!=='editor'){
    const request=sent.find(message=>message.type==='flowhub:widget-rpc');
    assert.equal(request.params.method,'snapshot');
    listeners.message({source:parent,data:{type:'flowhub:widget-result',token:'test-token',id:request.id,result:data}});
  }
  await Promise.resolve();
  return {node,sent,intervals,controls,selectCategory:key=>categories[key](),receive:message=>listeners.message({source:parent,data:{token:'test-token',...message}})};
}
const renderWidget=async(data,config={})=>(await mountWidget(data,config)).node.innerHTML;

const devices=Array.from({length:8},(_,i)=>({id:`d${i}`,name:`Headset ${i}`,category:'bluetooth',
  kind:'headphones',detail:'Headset',status:'connected',battery:i===0?'0%':i===1?'70%':null}));
const snapshot={at:Date.now(),stale:false,error:null,devices,power:{adapterWatts:'68'},events:[]};

test('ADB widget category keeps unauthorized and offline connections and labels failures as cached',async()=>{
 const adbDevices=['device','unauthorized','offline'].map((state,i)=>({id:'adb-'+i,name:'Public Android '+i,category:'adb',kind:'phone',status:state==='device'?'connected':state,adb:{serial:'PUBLIC-'+i,state,transport:'usb'}}));
 const ui=await mountWidget({...snapshot,devices:[...devices,...adbDevices],adb:{at:Date.now(),available:true,stale:false}});
 ui.selectCategory('adb');assert.equal((ui.node.innerHTML.match(/data-device=/g)||[]).length,3);
 for(const text of ['未授权','离线','PUBLIC-0'])assert.ok(ui.node.innerHTML.includes(text));
 const failed=await mountWidget({...snapshot,devices:adbDevices,adb:{at:1000,available:true,stale:true,error:'ADB timeout'}});
 failed.selectCategory('adb');assert.match(failed.node.innerHTML,/ADB timeout/);assert.match(failed.node.innerHTML,/上次设备记录/);
});

test('existing three/five/eight limits no longer hide devices and the widget labels current connections',async()=>{
  for(const limit of [3,5,8]){
    const html=await renderWidget(snapshot,{limit,title:'我的设备'});
    assert.equal((html.match(/data-device=/g)||[]).length,8);
    assert.ok(html.includes('当前连接设备'));
    assert.ok(html.includes('我的设备'));
    assert.ok(!html.includes('常用设备'));
    assert.ok(!html.includes('显示 3/8'));
  }
  const html=await renderWidget(snapshot,{limit:99,title:'<script>'});
  assert.equal((html.match(/data-device=/g)||[]).length,8);
  assert.ok(html.includes('&lt;script&gt;'));
});
test('widget excludes disconnected devices and shows an explicit empty state',async()=>{
  const html=await renderWidget({...snapshot,devices:[{...devices[0],status:'disconnected'}]});
  assert.ok(!html.includes('data-device='));
  assert.ok(html.includes('当前没有检测到已连接设备'));
});
test('display badges are visible and Retina logical size stays in device details',async()=>{
  const internal={id:'display-1',name:'Color LCD',category:'display',kind:'monitor',status:'connected',
    displayConnection:'built-in',pixelResolution:'3024 × 1964',logicalResolution:'1512 × 982',refreshRate:'120.00Hz',detail:'3024 × 1964 · 120.00Hz'};
  const external={...internal,id:'display-2',name:'DELL P2419H',displayConnection:'external',pixelResolution:'1920 × 1080',refreshRate:'60.00Hz',detail:'1920 × 1080 · 60.00Hz'};
  const html=await renderWidget({...snapshot,devices:[internal,external]});
  for(const text of ['内置','外接','3024 × 1964','1080P · 60.00Hz'])assert.ok(html.includes(text),text);
  assert.ok(!html.includes('1512 × 982'));
  const unknown=await renderWidget({...snapshot,devices:[{...internal,displayConnection:undefined}]});
  assert.ok(unknown.includes('类型未知'));
});
test('stale and failed snapshots are identified as previous observations',async()=>{
  const html=await renderWidget({...snapshot,stale:true,error:'读取失败 <test>'});
  assert.ok(html.includes('上次连接设备'));
  assert.ok(html.includes('以下为上次采集结果'));
  assert.ok(html.includes('读取失败 &lt;test&gt;'));
  assert.ok(!html.includes('当前连接设备'));
});
test('battery labels and fill levels preserve zero and the actual percentage',async()=>{
  const html=await renderWidget(snapshot);
  assert.ok(html.includes('aria-label="电量 0%"'));
  assert.ok(html.includes('aria-label="电量 70%"'));
  assert.ok(html.includes('style="--battery-level:0"'));
  assert.ok(html.includes('style="--battery-level:0.7"'));
});
test('widget separates system consumption from supply and moves input/rating to details',async()=>{
  const html=await renderWidget({...snapshot,power:{externalConnected:true,charging:false,adapterWatts:68,inputWatts:27.44,systemWatts:29.79,batterySideWatts:0}});
  for(const text of ['整机耗电','29.8W','供电来源','外接电源','电池未充电'])assert.ok(html.includes(text),text);
  for(const text of ['27.4W','68W','每5秒','适配器规格'])assert.ok(!html.includes(text),text);
  const draining=await renderWidget({...snapshot,power:{externalConnected:false,batterySideWatts:-12.3,systemWatts:12.3}});
  assert.ok(draining.includes('<strong>电池</strong>'));
  assert.ok(!draining.includes('widget-power-note'));
  assert.ok(!draining.includes('>电池正在放电<'));
  assert.equal((draining.match(/12\.3W/g)||[]).length,1);
  const charging=await renderWidget({...snapshot,power:{externalConnected:true,batterySideWatts:20,systemWatts:30}});
  assert.ok(charging.includes('<small>充电 20.0W</small>'));
  const hybrid=await renderWidget({...snapshot,power:{externalConnected:true,batterySideWatts:-5,systemWatts:35}});
  assert.ok(hybrid.includes('混合供电'));assert.ok(hybrid.includes('电池补充供电 5.0W（估算）'));
});
test('missing or failed power telemetry never substitutes adapter rating for live watts',async()=>{
  const html=await renderWidget({...snapshot,power:{adapterWatts:68,inputWatts:null,systemWatts:null,batterySideWatts:null,telemetryError:'读取失败'}});
  assert.equal((html.match(/<strong>未提供<\/strong>/g)||[]).length,2);
  assert.ok(html.includes('当前功率读取失败：读取失败'));
  assert.ok(!html.includes('<strong>68W</strong>'));
});
test('desktop supply stays visible when wattage and battery telemetry are unavailable',async()=>{
  const html=await renderWidget({...snapshot,power:{source:'外接电源',externalConnected:null,batteryPresent:false,systemWatts:null,inputWatts:null,charging:null,powerUnavailableReason:'系统未提供实时功率读数，供电来源仍可独立读取。'}});
  assert.ok(html.includes('<strong>外接电源</strong>'));
  assert.ok(html.includes('无内置电池'));assert.ok(!html.includes('未充电'));
  assert.ok(html.includes('系统未提供实时功率读数'));
  assert.ok(!html.includes('0.0W'));
});
test('all categories remain complete even with legacy three-device config and survive context refresh',async()=>{
  const usb=Array.from({length:7},(_,i)=>({id:`usb-${i}`,name:`USB ${i}`,category:'usb',kind:'hub',status:'connected'}));
  const mixed={...snapshot,devices:[...devices.slice(0,2),{id:'display',name:'Display',category:'display',status:'connected'},...usb]};
  const mounted=await mountWidget(mixed,{limit:3});
  assert.equal((mounted.node.innerHTML.match(/data-device=/g)||[]).length,10);
  assert.ok(mounted.node.innerHTML.includes('data-device="usb-0"'));
  mounted.selectCategory('usb');
  assert.equal((mounted.node.innerHTML.match(/data-device=/g)||[]).length,7);
  assert.ok(mounted.node.innerHTML.includes('data-device="usb-0"'));
  assert.ok(mounted.node.innerHTML.includes('7 个'));
  mounted.receive({type:'flowhub:widget-init',context:{config:{limit:3}}});
  assert.ok(mounted.node.innerHTML.includes('data-widget-category="usb" aria-pressed="true"'));
  mounted.selectCategory('overview');
  assert.equal((mounted.node.innerHTML.match(/data-device=/g)||[]).length,10);
});
test('all-device mode renders beyond eight and is preserved by the editor save protocol',async()=>{
  const full={...snapshot,devices:[...devices,...devices.slice(0,2).map(d=>({...d,id:d.id+'-extra'}))]};
  const html=await renderWidget(full,{limit:'all'});
  assert.equal((html.match(/data-device=/g)||[]).length,10);
  assert.ok(html.includes('widget-device-list'));assert.ok(!html.includes('显示 3/10'));
  const editor=await mountWidget(full,{limit:'all'},'editor');
  assert.ok(!editor.node.innerHTML.includes('widget-limit'));
  editor.receive({type:'flowhub:widget-save',id:'all-save'});
  assert.equal(editor.sent.find(message=>message.type==='flowhub:widget-config').config.limit,'all');
});
test('saved device identities order every category while new devices append and separate handles preserve detail actions',async()=>{
 const html=await renderWidget({...snapshot,widgetOrder:{ids:['d7','absent','d2'],revision:2}});
 assert.deepEqual([...html.matchAll(/data-device="([^"]+)"/g)].map(match=>match[1]),['d7','d2','d0','d1','d3','d4','d5','d6']);
 assert.equal((html.match(/data-order-handle=/g)||[]).length,8);
 assert.ok(html.includes('aria-label="设备列表"'));
 assert.ok(html.includes('aria-description="拖动排序'));
});
test('sampling interval is configured, saved and sent to the backend with matching polling',async()=>{
  const mounted=await mountWidget(snapshot,{powerIntervalSeconds:30});
  assert.deepEqual(mounted.intervals,[30000]);
  const request=mounted.sent.find(message=>message.type==='flowhub:widget-rpc');
  assert.equal(request.params.params.powerIntervalSeconds,30);
  const editor=await mountWidget(snapshot,{powerIntervalSeconds:30},'editor');
  assert.ok(editor.node.innerHTML.includes('功率采样间隔'));
  assert.ok(editor.node.innerHTML.includes('value="30" selected'));
  assert.deepEqual(editor.intervals,[]);
  editor.controls['#widget-interval']={value:'10'};
  editor.receive({type:'flowhub:widget-save',id:'save-config'});
  const saved=editor.sent.find(message=>message.type==='flowhub:widget-config');
  assert.equal(saved.config.powerIntervalSeconds,10);
  const invalid=await mountWidget(snapshot,{powerIntervalSeconds:1});
  assert.deepEqual(invalid.intervals,[5000]);
});
