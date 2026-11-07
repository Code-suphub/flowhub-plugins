import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,join,extname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {buildSync} from 'esbuild';

// Test the shipped bundle and CSP in an opaque iframe. No real application,
// keyboard, mouse, clipboard, hardware state or installed plugin is modified.
const root=fileURLToPath(new URL('../',import.meta.url));
const out=resolve(process.argv.slice(2).find(arg=>arg!=='--')||join(root,'screenshots'));
await mkdir(out,{recursive:true});
const compiled=buildSync({entryPoints:[join(root,'src/fixtures.ts')],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;
const module={exports:{}};new Function('module','exports',compiled)(module,module.exports);
const fixture=module.exports.demo;
let artwork={available:false,icons:{}};
try{const icons=JSON.parse(execFileSync(join(root,'build/bin/flowhub-device-icons'),[],{timeout:4000,maxBuffer:600000,stdio:['ignore','pipe','ignore']}));artwork={available:true,icons};}catch{}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.txt':'text/plain'};
const csp="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'";
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/qa'){
   const card=url.searchParams.get('surface')==='card',editor=url.searchParams.get('surface')==='editor',widget=url.searchParams.get('widget')==='1'||card||editor;
   const context={config:{powerIntervalSeconds:5,limit:3},selection:{deviceId:url.searchParams.get('device')||undefined,view:url.searchParams.get('view')||undefined}};
   context.scenario=url.searchParams.get('scenario')||'';
   if(url.searchParams.has('cards'))context.config.cards=JSON.parse(url.searchParams.get('cards'));
   const source=widget?(card?'widget-card.html':editor?'widget-editor.html':'widget-detail.html')+'#flowhubWidgetToken=qa-token':'index.html';
   if(url.searchParams.get('pending')==='1')context.pending=true;
   if(url.searchParams.get('legacy')==='1'){context.config.selection=context.selection;delete context.selection;}
   res.writeHead(200,{'content-type':mime['.html']});
   res.end('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style><script src="/qa-host.js?context='+encodeURIComponent(JSON.stringify(context))+'"></script><iframe id="plugin" sandbox="allow-scripts" src="/ui/'+source+'"></iframe>');return;
  }
  if(url.pathname==='/qa-host.js'){
   const context=JSON.parse(url.searchParams.get('context'));
   res.writeHead(200,{'content-type':mime['.js']});
   res.end(`window.__qa={snapshot:${JSON.stringify(fixture(context.scenario))},artwork:${JSON.stringify(artwork)},error:null,requests:[]};
   if(window.__qa.snapshot.catalog?.['pixel-8-pro']){
     const canvas=document.createElement('canvas');
     canvas.width=8;canvas.height=8;
     window.__qa.snapshot.catalog['pixel-8-pro'].image={dataUrl:canvas.toDataURL('image/jpeg'),author:'Test Author',license:'CC BY 4.0'};
   }
   let pending=${Boolean(context.pending)};
   window.addEventListener('message',event=>{if(event.source===document.querySelector('iframe').contentWindow&&event.data?.type==='flowhub:widget-config')window.__qa.savedConfig=event.data.config;});
   window.addEventListener('message',event=>{if(event.source===document.querySelector('iframe').contentWindow&&event.data?.type==='flowhub:widget-navigate')window.__qa.navigation=event.data;});
   window.addEventListener('message',event=>{const frame=document.querySelector('iframe');if(event.source!==frame.contentWindow)return;const m=event.data;if(m.type==='flowhub:theme-ready'){frame.contentWindow.postMessage({type:'flowhub:theme',theme:'light'},'*');return;}if(m.type==='flowhub:widget-ready'){frame.contentWindow.postMessage({type:'flowhub:widget-init',token:'qa-token',context:${JSON.stringify(context)}},'*');return;}if(!['flowhub:request','flowhub:widget-rpc'].includes(m.type))return;const widget=m.type==='flowhub:widget-rpc',method=widget?m.params.method:m.method;window.__qa.requests.push(method);const reply={type:widget?'flowhub:widget-result':'flowhub:response',token:widget?'qa-token':undefined,id:m.id};
   if(method==='open_display_settings'){if(window.__qa.settingsError)reply.error=window.__qa.settingsError;else reply.result={opened:true};if(window.__qa.holdSettings){window.__qa.finishSettings=()=>frame.contentWindow.postMessage(reply,'*');return;}frame.contentWindow.postMessage(reply,'*');return;}
   if(method==='open_device_reference'){window.__qa.reference=widget?m.params.params:m.params;reply.result={opened:true};frame.contentWindow.postMessage(reply,'*');return;}
   if(method==='keyboard_mode'){const args=widget?m.params.params:m.params;if(args.id==='usb-k75')reply.result=window.__qa.keyboardMode||{status:'read',mode:'mac',usbRelease:'0x4023',configurationSupported:true,lighting:'off'};else reply.error='设备不支持';frame.contentWindow.postMessage(reply,'*');return;}
   if(['keyboard_presets','keyboard_record_preset','keyboard_apply_preset','keyboard_delete_preset','keyboard_diagnostics'].includes(method)){
    const args=widget?m.params.params:m.params;
    const reading=window.__qa.keyboardMode||{status:'read',mode:'mac',usbRelease:'0x4023',configurationSupported:true,lighting:'off'};
    const presets=window.__qa.presets??=[];
    if(method==='keyboard_record_preset')presets.push({name:args.name,mode:reading.mode,lighting:reading.lighting});
    if(method==='keyboard_delete_preset')presets.splice(presets.findIndex(p=>p.name===args.name),1);
    if(method==='keyboard_apply_preset'){
     const selected=presets.find(p=>p.name===args.name);
     if(args.expectedMode!==reading.mode)reply.error='键盘状态已变化';
     else reply.result=window.__qa.keyboardMode={...reading,mode:args.mode||selected.mode,lighting:selected?.lighting||reading.lighting};
    }else if(method==='keyboard_diagnostics')reply.result={configurationBytes:128,powerBytes:[4,4],configurationDigest:'abcdef',modeByte:1,lightingByte:4};
    else reply.result=presets;
    frame.contentWindow.postMessage(reply,'*');return;
   }
   if(method==='battery_history'||method==='battery_history_set_retention'){
    const args=widget?m.params.params:m.params;
    if(method==='battery_history_set_retention')window.__qa.batteryHours=args.hours;
    const to=Date.now(),hours=window.__qa.batteryHours||48;
    reply.result={hours,from:to-hours*3600000,to,points:args.id==='keyboard'?[{at:to-2000000,percent:30,source:'system_profiler'},{at:to-1500000},{at:to-1000000,percent:100,source:'pmset'}]:[]};
    frame.contentWindow.postMessage(reply,'*');return;
   }
   if(method==='adb_set_alias'||method==='adb_set_low_battery_threshold'){
    const params=widget?m.params.params:m.params;
    const previous=window.__qa.snapshot.adbPreferences||{aliases:{},lowBatteryThreshold:30,revision:0};
    if(window.__qa.preferenceError)reply.error=window.__qa.preferenceError;
    else{
     const next={...previous,aliases:{...previous.aliases},revision:previous.revision+1};
     if(method==='adb_set_alias'){if(params.alias)next.aliases[params.id]=params.alias;else delete next.aliases[params.id];}
     else next.lowBatteryThreshold=params.threshold;
     reply.result=next;
     window.__qa.snapshot.adbPreferences=next;
    }
    frame.contentWindow.postMessage(reply,'*');return;
   }
   if(method==='widget_order_set'){const params=widget?m.params.params:m.params,old=window.__qa.snapshot.widgetOrder||{ids:[],revision:0};if(window.__qa.orderError)reply.error=window.__qa.orderError;else if(params.expectedRevision!==old.revision)reply.error='设备顺序已在其他组件更新，请重新排序';else {reply.result={ids:params.ids,revision:old.revision+1};window.__qa.snapshot.widgetOrder=reply.result;}if(window.__qa.holdOrder){window.__qa.finishOrder=()=>frame.contentWindow.postMessage(reply,'*');return;}frame.contentWindow.postMessage(reply,'*');return;}
   if(window.__qa.error&&method!=='device_icons')reply.error=window.__qa.error;else reply.result=method==='device_icons'?window.__qa.artwork:pending?{at:0,stale:true,devices:[],power:{},events:[]}:window.__qa.snapshot;if(method!=='device_icons')pending=false;frame.contentWindow.postMessage(reply,'*');});`);return;
  }
  if(url.pathname==='/favicon.ico'){res.writeHead(204).end();return;}
  const path=resolve(root,'build','.'+decodeURIComponent(url.pathname));
  if(!path.startsWith(resolve(root,'build')+'/'))throw Error('invalid path');
  res.writeHead(200,{'content-type':mime[extname(path)]||'application/octet-stream','content-security-policy':csp});res.end(await readFile(path));
 }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const profile=await mkdtemp(join(tmpdir(),'flowhub-devices-browser-'));
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--disable-gpu','--disable-site-isolation-trials','--disable-features=IsolateOrigins,site-per-process','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let socket;
const report={scope:'Shipped bundle in opaque iframe with fixture data and packaged macOS artwork helper; not installed-app acceptance.',checks:[],responsive:[],errors:[],screenshots:[]};
try{
 for(let n=0;n<100&&!existsSync(join(profile,'DevToolsActivePort'));n++)await sleep(100);
 const [port]=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n');
 const targets=await fetch('http://127.0.0.1:'+port+'/json/list').then(r=>r.json());
 socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 const pending=new Map(),contexts=new Map();let serial=0,frame;
 socket.addEventListener('message',({data})=>{const r=JSON.parse(data);if(r.method==='Runtime.executionContextCreated')contexts.set(r.params.context.id,r.params.context);if(r.method==='Runtime.executionContextDestroyed')contexts.delete(r.params.executionContextId);if(r.method==='Runtime.executionContextsCleared')contexts.clear();if(r.method==='Runtime.exceptionThrown')report.errors.push(r.params.exceptionDetails.exception?.description||r.params.exceptionDetails.text);if(r.method==='Runtime.consoleAPICalled'&&r.params.type==='error')report.errors.push(r.params.args.map(arg=>arg.value??arg.description??arg.type).join(' '));if(r.method==='Network.requestWillBeSent'){const url=r.params.request.url;if(!url.startsWith(origin)&&!url.startsWith('data:')&&url!=='about:blank')report.errors.push('External request: '+url);}if(pending.has(r.id)){const p=pending.get(r.id);pending.delete(r.id);r.error?p.reject(Error(JSON.stringify(r.error))):p.resolve(r.result);}});
 const send=(method,params={})=>new Promise((resolve,reject)=>{pending.set(++serial,{resolve,reject});socket.send(JSON.stringify({id:serial,method,params}));});
 const evaluate=async(expression,contextId=frame)=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,...(contextId?{contextId}:{})});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
 // Explicitly omit contextId for the parent, even after frame is selected.
 const parent=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result?.value;};
 const wait=async(expression,ms=8000)=>{const start=Date.now();while(Date.now()-start<ms){if(await evaluate(expression))return;await sleep(50);}throw Error('Timed out: '+expression);};
 const check=async(expression,label)=>{if(!await evaluate(expression))throw Error(label);report.checks.push(label);};
 const click=async(selector,focus=true)=>{await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');${focus?'e.focus();':''}e.click()})()`);await sleep(70);};
 // The test iframe fills this headless viewport; CDP movement never moves the system mouse.
 const hover=async selector=>{await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1});const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);await send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await sleep(70);};
 const fill=async(value,selector='input[aria-label="搜索设备"]')=>{await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`);await sleep(70);};
 const size=(width,height=560)=>send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:2,mobile:false});
 const keyboard=async(key,code=key,vk=0,modifiers=0)=>{await send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:vk,modifiers,...(key==='Enter'?{text:'\r'}:key.length===1?{text:key}:{})});await send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk,modifiers});await sleep(80);};
 const capture=async name=>{await writeFile(join(out,name+'.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));report.screenshots.push(name+'.png');};
 const navigate=async(path='/qa')=>{
  frame=undefined;
  const params=new URL(origin+path).searchParams,card=params.get('surface')==='card'||path.startsWith('/ui/widget-card.html'),editor=params.get('surface')==='editor';
  const selector=card?'.widget':editor?'.editor':'.dc-app';
  await send('Page.navigate',{url:origin+path});
  for(let n=0;n<120;n++){
   for(const ctx of contexts.values()){
    if(!ctx.auxData?.isDefault)continue;
    try{if(await evaluate('!!document.querySelector("'+selector+'")',ctx.id)){frame=ctx.id;break;}}catch{}
   }
   if(frame)break;await sleep(50);
  }
  if(!frame)throw Error('No plugin iframe');
  const view=params.get('view'),count=fixture(params.get('scenario')||'').devices.filter(d=>!['bluetooth','usb','display','adb'].includes(view)||d.category===view).length;
  const config=JSON.parse(params.get('cards')||'[]');
  await wait('document.querySelectorAll("[data-device]").length==='+ (editor||card&&config.some(c=>c.id==='devices'&&!c.visible)?0:count));
  await evaluate('document.fonts.ready');await sleep(100);
 };
 const tab=async name=>click('[role=tab][data-tabs-value="'+name+'"]');
 const refresh=async()=>{await parent('window.__qa.snapshot.at=Date.now()');await click('[aria-label="刷新设备"]');await wait('!document.querySelector("[aria-label=刷新设备]").disabled');};
 await send('Page.enable');await send('Runtime.enable');await send('Network.enable');await send('Emulation.setFocusEmulationEnabled',{enabled:true});await size(800);await navigate();
 await wait('document.documentElement.dataset.theme==="light"');
 const geometry=await evaluate(`([...document.querySelectorAll('[data-device]')].map(e=>{const r=e.getBoundingClientRect();return {id:e.dataset.device,visible:r.top>=49&&r.bottom<=innerHeight-26}}))`);
 if(!geometry.every(x=>x.visible))throw Error('800x560 cards are clipped: '+JSON.stringify(geometry));report.checks.push('all nine devices fit 800x560');
 if(artwork.icons.iphone){await wait('document.querySelector("[data-device=iphone] img")?.naturalWidth>0 && document.querySelector("[data-device=iphone] img").src.startsWith("data:image/png")');report.checks.push('packaged macOS iPhone artwork rendered');}
 await wait('document.querySelector("[data-device=pixel] img")?.naturalWidth>0');
 await check('document.querySelector("[data-device=pixel] img").getAttribute("src")==="assets/phone.svg"','unknown Android phone uses bundled category artwork');await capture('devices-light');
 await click('.dc-group-heading .dc-display-settings');
 if(await parent('window.__qa.requests.filter(m=>m==="open_display_settings").length')!==1)throw Error('Missing display settings request');
 report.checks.push('display group settings action dispatches only on click');
 await click('[data-device=dell]');await wait('document.querySelector("dialog").open');
 await wait('!document.querySelector("dialog .dc-display-settings").disabled');
 // DOM click alone does not activate this opaque cross-origin iframe. A CDP
 // pointer click on its inert title focuses the headless frame, not the desktop.
 const detailPoint=await evaluate('(()=>{const r=document.querySelector(".dc-detail-hero h3").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()');
 await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...detailPoint});await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...detailPoint});
 await parent('window.__qa.holdSettings=true');await evaluate('document.querySelector("dialog .dc-display-settings").focus()');await keyboard('Enter','Enter',13);
 if(!await evaluate('document.querySelector("dialog .dc-display-settings").disabled')){
  report.keyboardFailure={frame:await evaluate('({active:document.activeElement.tagName,focused:document.hasFocus(),dialog:document.querySelector("dialog").open})'),parent:await parent('({active:document.activeElement.tagName,requests:window.__qa.requests,holding:window.__qa.holdSettings})')};
  await capture('display-keyboard-debug');
 }
 await check('document.querySelector("dialog .dc-display-settings").disabled','keyboard activation disables settings while opening');
 await evaluate('document.querySelector("dialog .dc-display-settings").click();document.querySelector("dialog .dc-display-settings").click()');
 if(await parent('window.__qa.requests.filter(m=>m==="open_display_settings").length')!==2)throw Error('Duplicate display settings request');
 report.checks.push('pending settings request suppresses repeated activation');
 await parent('window.__qa.holdSettings=false;window.__qa.finishSettings()');await wait('!document.querySelector("dialog .dc-display-settings").disabled');
 await parent('window.__qa.settingsError="QA 无法打开显示器设置，请在系统设置中选择显示器。"');await click('dialog .dc-display-settings');
 await wait('document.querySelector("dialog [role=alert]")?.textContent.includes("QA 无法打开")');
 await check('document.querySelector("dialog").open && document.querySelector(".dc-detail-hero h3").textContent==="DELL U2723QE"','opening failure is visible and preserves the selected display detail');
 await capture('display-settings-error');await parent('window.__qa.settingsError=null');await keyboard('Escape','Escape',27);
 await click('[data-category=usb]');await check('document.querySelectorAll("[data-device]").length===4','USB category filters actual cards');await fill('T7');await refresh();await check('document.querySelector("input").value==="T7" && document.querySelector("[data-category=usb]").getAttribute("aria-pressed")==="true" && document.querySelectorAll("[data-device]").length===1','refresh retains category and search together');await fill('');await click('[data-category=all]');
 await fill('Mouse');await check('document.querySelectorAll("[data-device]").length===1','search filters actual cards');await refresh();await check('document.querySelector("input").value==="Mouse" && document.querySelectorAll("[data-device]").length===1','refresh retains search');
 await evaluate('document.querySelector("input").focus()');
 await click('[data-device=mouse]',false);await wait('document.querySelector("dialog").open');await check('document.querySelector(".dc-detail-hero h3").textContent==="Magic Mouse"','detail follows selected device');
 await check('!document.querySelector("dialog .dc-display-settings")','non-display details do not offer display settings');
 await evaluate(`document.querySelector('dialog footer button:last-child').focus(); window.addEventListener('keydown',event=>window.__qaTabEvent=event,{once:true,capture:true})`);
 await keyboard('Tab','Tab',9);
 await check('window.__qaTabEvent?.defaultPrevented && document.activeElement===document.querySelector("dialog header button")','forward Tab explicitly wraps before leaving the iframe');
 await keyboard('Tab','Tab',9,8);
 await check('document.activeElement===document.querySelector("dialog footer button:last-child")','reverse Tab wraps to the last dialog action');
 for(let n=0;n<5;n++){await keyboard('Tab','Tab',9);await check('document.querySelector("dialog").contains(document.activeElement)','dialog keeps keyboard focus '+n);}
 await keyboard('Escape','Escape',27);await wait('!document.querySelector("dialog").open');await check('document.activeElement.dataset.device==="mouse"','Escape restores original card focus');await fill('');
 await click('[data-device=airpods]');await wait('document.querySelector("dialog").open');await capture('detail-light');
 await parent('window.__qa.snapshot.devices=window.__qa.snapshot.devices.filter(d=>d.id!=="airpods");window.__qa.snapshot.at=Date.now()');
 await wait('document.querySelector("dialog").textContent.includes("设备已离开当前连接列表")',8500);report.checks.push('device removal is explicit while detail stays open');await keyboard('Escape','Escape',27);
 await parent('window.__qa.snapshot='+JSON.stringify(fixture()));await refresh();
 await tab('power');await check('document.querySelector(".dc-power-metrics").textContent.includes("25.4") && !document.querySelector(".dc-power-facts").textContent.includes("25.4")','power readings and adapter specification stay separate');await capture('power-light');
 const help='button[aria-label="功率与采样说明"]';
 const helpExpanded=`document.querySelector(${JSON.stringify(help)}).getAttribute('aria-expanded')==='true'`;
 await hover(help);
 await wait(helpExpanded);
 await check(`document.activeElement!==document.querySelector(${JSON.stringify(help)})`,'pointer-opened help starts without trigger focus');
 await keyboard('Escape','Escape',27);
 await check(`!(${helpExpanded}) && document.activeElement===document.querySelector(${JSON.stringify(help)}) && !document.querySelector('.fh-help__content')`,'one Escape closes pointer-opened help and restores trigger focus');
 await keyboard(' ','Space',32);await wait(helpExpanded);
 await keyboard('Escape','Escape',27);
 await check(`!(${helpExpanded}) && document.activeElement===document.querySelector(${JSON.stringify(help)})`,'one Escape closes keyboard-opened help');
 await evaluate(`document.querySelector('[aria-label="刷新设备"]').focus();document.querySelector(${JSON.stringify(help)}).focus()`);await wait(helpExpanded);
 await keyboard('Escape','Escape',27);
 await check(`!(${helpExpanded})`,'help can reopen on a later focus and still close once');
 await hover(help);await wait(helpExpanded);
 await keyboard('Escape','Escape',27);
 await check(`!(${helpExpanded})`,'help can reopen on later pointer entry and still close once');
 await parent('window.__qa.snapshot.power={externalConnected:true,batteryPresent:false,source:"外接电源",sampledAt:Date.now()}');await refresh();
 await check('document.querySelectorAll(".dc-metric-number.is-unknown").length===3 && document.querySelector(".dc-power").textContent.includes("无内置电池")','missing desktop telemetry never becomes zero');
 await parent('window.__qa.snapshot='+JSON.stringify(fixture('unplugged')));await refresh();await check('document.querySelector(".dc-power").textContent.includes("电池放电") && document.querySelectorAll(".dc-metric-number.is-unknown").length===1','unplugged state drops cached input');
 await parent('window.__qa.snapshot='+JSON.stringify(fixture()));await refresh();await parent('window.__qa.error="QA 扫描超时"');await refresh();await check('document.querySelector("[role=alert]")?.textContent.includes("上次采集结果") && document.querySelector(".dc-power-metrics").classList.contains("is-stale")','failed scan marks cached data as stale');await capture('error-state');
 await parent('window.__qa.error=null');await refresh();
 for(const theme of ['light','dark']){
  await parent(`document.querySelector('iframe').contentWindow.postMessage({type:'flowhub:theme',theme:'${theme}'},'*')`);await wait(`document.documentElement.dataset.theme==='${theme}'`);
  for(const width of [800,640,520,390]){
   await size(width);
   for(const page of ['devices','power','events']){await tab(page);const dimensions=await evaluate(`({theme:'${theme}',page:'${page}',width:innerWidth,scroll:document.documentElement.scrollWidth})`);if(dimensions.scroll>width+1)throw Error('Horizontal overflow '+JSON.stringify(dimensions));report.responsive.push(dimensions);if(width===800&&theme==='dark'&&page!=='events')await capture(page+'-dark');}
   await tab('devices');await click('[data-device=dell]');await wait('document.querySelector("dialog").open');const box=await evaluate('(()=>{const e=document.querySelector("dialog"),r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,overflow:e.scrollWidth-e.clientWidth}})()');if(box.left<0||box.top<0||box.right>width||box.bottom>560||box.overflow>1)throw Error('Display dialog escapes viewport');await keyboard('Escape','Escape',27);
  }
 }
 await size(800);await navigate('/qa?widget=1&device=iphone&pending=1');await wait('document.querySelector("dialog").open');await check('document.querySelector(".dc-detail-hero h3").textContent==="iPhone 15"','widget selection survives an initial pending scan');await keyboard('Escape','Escape',27);
 await navigate('/qa?widget=1&view=power');await wait('document.querySelector("[data-tabs-value=power]").getAttribute("aria-selected")==="true"');report.checks.push('widget supply navigation opens power page');
 await navigate('/qa?widget=1&view=power&legacy=1');await wait('document.querySelector("[data-tabs-value=power]").getAttribute("aria-selected")==="true"');report.checks.push('legacy widget config selection remains compatible');
 await navigate('/qa?widget=1&device=dell');await wait('document.querySelector("dialog").open');await click('dialog .dc-display-settings');
 if(await parent('window.__qa.requests.filter(m=>m==="open_display_settings").length')!==1)throw Error('Missing widget display settings request');
 report.checks.push('widget display detail requests the same settings action');
 await navigate('/qa?scenario=adb');await click('[data-category=adb]');
 await check('document.querySelectorAll("[data-device]").length===3 && document.querySelector(".dc-adb").textContent.includes("未授权") && document.querySelector(".dc-adb").textContent.includes("离线")','ADB category keeps unauthorized and offline devices visible');
 await check('document.querySelector("[data-device=adb-usb] .dc-card-title [data-tone=connected]")?.textContent==="已连接" && document.querySelector("[data-device=adb-offline] .dc-card-title [data-tone=disconnected]")?.textContent==="离线" && document.querySelector("[data-device=adb-usb] .dc-card-value strong.low")?.textContent==="26%" && document.querySelector("[data-device=adb-offline] .dc-card-value")?.textContent==="电量未知"','ADB title contains connection status and marks only real low batteries');
 await evaluate('[...document.querySelectorAll(".dc-adb-actions button")].find(button=>button.textContent==="电量设置").click()');
 await fill('20','.dc-adb-preference input[type=number]');
 await click('.dc-adb-preference .dc-button');
 await wait('!document.querySelector("[data-device=adb-usb] .dc-card-value strong.low")');
 await check('document.querySelector(".dc-adb-preference input").value==="20"','changing the saved threshold immediately updates the low-battery cue');
 await check('!document.querySelector("[aria-label=刷新设备]") && [...document.querySelectorAll("button")].filter(b=>b.getAttribute("aria-label")==="刷新 ADB 设备").length===1','ADB view has a single refresh control');
 await fill('PUBLIC-USB');await check('document.querySelectorAll("[data-device]").length===1','ADB search matches serial numbers');
 const adbRequests=await parent('window.__qa.requests.filter(m=>m==="adb_refresh").length');await click('[aria-label="刷新 ADB 设备"]');
 await check('document.querySelector("input").value==="PUBLIC-USB" && document.querySelector("[data-category=adb]").getAttribute("aria-pressed")==="true"','ADB refresh preserves search and category');
 if(await parent('window.__qa.requests.filter(m=>m==="adb_refresh").length')!==adbRequests+1)throw Error('ADB refresh did not use its dedicated route');report.checks.push('ADB refresh avoids system profiler route');
 await click('[data-device=adb-usb]');await wait('document.querySelector("dialog").open');
 await check('document.querySelector("dialog").textContent.includes("PUBLIC-USB") && document.querySelector("dialog").textContent.includes("Pixel 8 Pro") && !document.querySelector("dialog .dc-display-settings")','ADB detail exposes serial, model and transport without display settings');
 await fill('测试手机','dialog .dc-adb-preference input');
 await parent('window.__qa.preferenceError="QA 保存失败"');
 await click('dialog .dc-adb-preference .dc-button');
 await check('document.querySelector("dialog .dc-adb-preference [role=alert]")?.textContent==="QA 保存失败" && document.querySelector("dialog .dc-adb-preference input").value==="测试手机"','failed alias save preserves the draft and shows the error');
 await parent('window.__qa.preferenceError=null');
 await click('dialog .dc-adb-preference .dc-button');
 await wait('document.querySelector(".dc-detail-hero h3").textContent==="测试手机"');
 await check('document.querySelector("[data-device=adb-usb] .dc-card-title strong").textContent==="测试手机" && document.querySelector("dialog").textContent.includes("PUBLIC-USB")','alias updates the row and detail while retaining the original identity');
 await evaluate('Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async text=>{window.__qaCopied=text}}})');
 await click('dialog footer .dc-button');await check('window.__qaCopied==="PUBLIC-USB"','ADB copy action copies the full serial only');
 const adbFocusPoint=await evaluate('(()=>{const r=document.querySelector(".dc-detail-hero h3").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()');
 await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...adbFocusPoint});await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...adbFocusPoint});
 await evaluate('document.querySelector("dialog footer .dc-button").focus()');await keyboard('Escape','Escape',27);await wait('!document.querySelector("dialog").open');
 await fill('测试手机');
 await check('document.querySelectorAll("[data-device]").length===1 && !!document.querySelector("[data-device=adb-usb]")','ADB search finds saved aliases');
 await fill('');await capture('adb-light');
 for(const theme of ['light','dark'])for(const width of [800,640,520,390]){await size(width);await evaluate(`document.documentElement.dataset.theme='${theme}'`);await sleep(80);await check('document.documentElement.scrollWidth<=innerWidth+1 && [...document.querySelectorAll(".dc-toolbar button,.dc-adb button")].every(e=>{const r=e.getBoundingClientRect();return !r.width || (r.left>=0 && r.right<=innerWidth+1)})','ADB '+theme+' '+width+' layout fits');if(width===800)await capture('adb-'+theme);}
 await parent('window.__qa.snapshot='+JSON.stringify(fixture('adb-error')));await click('[aria-label="刷新 ADB 设备"]');
 await check('document.querySelector(".dc-adb [role=alert]").textContent.includes("上次采集结果") && document.querySelectorAll(".dc-adb .is-stale").length===3','ADB query failure keeps and labels cached rows');
 await parent('window.__qa.error="QA ADB RPC timeout"');await click('[aria-label="刷新 ADB 设备"]');
 await check('document.querySelector(".dc-adb [role=alert]").textContent.includes("RPC timeout") && document.querySelectorAll(".dc-adb .is-stale").length===3','ADB transport rejection is visible instead of leaving a loading or healthy view');
 await click('[data-category=display]');await check('!document.querySelector(".dc-app > .dc-warning") && document.querySelectorAll(".dc-card").length===2 && !document.querySelector(".dc-card.is-stale")','failed ADB-only refresh does not invalidate system devices');
 await navigate('/qa?scenario=adb-empty');await click('[data-category=adb]');await check('document.querySelector(".dc-adb-empty").textContent.includes("没有检测到 ADB 设备")','empty ADB success is explicit');
 await navigate('/qa?scenario=adb-missing');await click('[data-category=adb]');await check('document.querySelector(".dc-adb [role=alert]").textContent.includes("Platform-Tools")','missing ADB has an installation hint rather than a false empty result');
 await navigate('/qa?surface=card&scenario=adb');await click('[data-widget-category=adb]');
 await check('document.querySelectorAll(".device-row").length===3 && document.querySelector(".widget-device-list").textContent.includes("未授权") && document.querySelector(".widget-device-list").textContent.includes("离线")','desktop widget lists ADB states in its own category');
 await parent('window.__qa.snapshot.adbPreferences={aliases:{"adb-usb":"测试手机"},lowBatteryThreshold:30,revision:2}');
 await wait('document.querySelector("[data-device=adb-usb] .device-name").textContent==="测试手机"');
 await check('document.querySelector("[data-device=adb-usb] .device-title [data-tone=connected]")?.textContent==="已连接" && document.querySelector("[data-device=adb-usb] .battery-reading.low")?.textContent==="26%" && document.querySelector("[data-device=adb-offline] .battery-unknown")?.textContent==="电量未知"','desktop widget reads the saved alias and low-battery threshold');
 for(const theme of ['light','dark'])for(const width of [360,280]){await size(width);await evaluate(`document.documentElement.dataset.theme='${theme}'`);await sleep(80);await check('document.documentElement.scrollWidth<=innerWidth+1 && [...document.querySelectorAll(".widget-metric")].every(e=>{const r=e.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth+1})','ADB widget '+theme+' '+width+' fits');if(width===360)await capture('adb-widget-'+theme);}
 await click('[data-device=adb-auth]');if(await parent('window.__qa.navigation?.selection?.deviceId')!=='adb-auth')throw Error('Missing ADB widget detail selection');report.checks.push('desktop ADB card selects its matching detail');
 await size(800);await navigate('/qa?scenario=adb-toolkit');await click('[data-category=adb]');
 await check('document.querySelectorAll("[data-device]").length===1 && document.querySelector("[data-device=adb-usb]").textContent.includes("测试手机")','one Toolkit phone card uses the shared name');
 await fill('100.64.0.2:5555');
 await check('document.querySelectorAll("[data-device]").length===1','search finds a phone by its secondary ADB route');
 await click('[data-device=adb-usb]');await wait('document.querySelector("dialog").open');
 await check('document.querySelectorAll(".dc-adb-connections li").length===3 && document.querySelector(".dc-adb-connections").textContent.includes("EasyTier · 本机转发") && document.querySelector(".dc-adb-connections").textContent.includes("Tailscale · 直连") && document.querySelector(".dc-adb-connections [data-tone=disconnected]").textContent.trim()==="离线" && [...document.querySelectorAll(".dc-adb-connections strong")].some(label=>label.textContent==="USB")','grouped detail shows USB, EasyTier and Tailscale with per-route state');
 await wait('document.querySelector(".dc-detail-hero img")?.naturalWidth>0');
 await check('document.querySelector(".dc-detail-hero img").getAttribute("src")==="assets/phone.svg"','ADB detail renders the bundled phone artwork');
 await check('document.querySelectorAll(".dc-recent-events li").length===1 && document.querySelector(".dc-recent-events li").textContent.includes("Tailscale · 已断开") && !document.querySelector(".dc-recent-events").textContent.includes("100.64")','detail includes the linked route event without exposing the endpoint or including a same-name device');
 await check('document.querySelector(".dc-recent-events").getBoundingClientRect().bottom<=document.querySelector("dialog footer").getBoundingClientRect().top','three-route detail shows its latest event without scrolling on desktop');
 await capture('adb-toolkit-connections');
 await click('dialog footer .dc-button:last-child');await wait('!document.querySelector("dialog").open');
 await check('document.querySelectorAll(".dc-event").length===1 && document.querySelector(".dc-event").textContent.includes("Tailscale · 已断开")','related events opens the event log filtered to the ADB device');
 await click('.dc-events-heading .dc-button');
 await check('document.querySelectorAll(".dc-event").length===5','clearing the device filter restores all events');
 await size(360,320);await navigate('/qa?surface=card&scenario=adb-toolkit');await click('[data-widget-category=adb]');
 await check('document.querySelectorAll("[data-device]").length===1 && document.querySelector("[data-device=adb-usb]").textContent.includes("EasyTier / Tailscale / USB")','desktop widget uses one shared phone row with the available routes');
 await wait('document.querySelector("[data-device=adb-usb] img")?.naturalWidth>0');
 await check('document.querySelector("[data-device=adb-usb] img").getAttribute("src")==="assets/phone.svg"','desktop widget and detail use the same bundled phone artwork');
 await size(800);await navigate('/qa?widget=1&scenario=adb&device=adb-auth');await wait('document.querySelector("dialog").open');await check('document.querySelector("dialog").textContent.includes("未授权") && document.querySelector("dialog").textContent.includes("PUBLIC-AUTH")','widget detail preserves ADB authorization state');
 await check('document.querySelector(".dc-recent-events p").textContent.includes("本次运行暂无连接变化")','device detail explains when no event has been observed');
 await navigate('/qa?scenario=catalog');
 await wait('document.querySelector("[data-device=pixel] img[alt=设备型号参考图片]")?.naturalWidth>0');
 await click('[data-device=pixel]');await wait('document.querySelector("dialog").open');
 await check('document.querySelector(".dc-device-reference").textContent.includes("Test Author") && document.querySelector(".dc-device-reference").textContent.includes("CC BY 4.0")','cached model image carries source attribution in device detail');
 await keyboard('Escape','Escape',27);
 await click('[data-device=keyboard]');await wait('document.querySelector("dialog").open');
 await check('document.querySelector(".dc-keyboard-guide").textContent.includes("Fn + ↑ / ↓") && document.querySelector(".dc-keyboard-guide").textContent.includes("尚未接入软件调节") && document.querySelector(".dc-detail-hero img").getAttribute("src")==="assets/keyboard.svg"','K75 shows useful physical shortcuts and a category illustration without implying software controls');
 await click('.dc-keyboard-guide button');
 if(JSON.stringify(await parent('window.__qa.reference'))!==JSON.stringify({key:'kzzi-k75',kind:'manual'}))throw Error('K75 manual request must send a catalog reference, not a URL');
 report.checks.push('K75 manual dispatch uses the fixed catalog reference');
 await capture('k75-keyboard-detail');
 if(await parent('window.__qa.requests.includes("battery_history")'))throw Error('Collapsed history should not query');
 await click('.dc-battery-history summary');
 await wait('Boolean(document.querySelector(".dc-history-readings li"))');
 await check('document.querySelector(".dc-history-readings").textContent.includes("30%") && document.querySelector(".dc-history-readings").textContent.includes("100%") && document.querySelector(".dc-history-readings").textContent.includes("macOS 配件电源") && document.querySelector(".dc-history-chart path").getAttribute("d").split("M").length===3','battery history shows source, jumps and a break between readings');
 await click('[aria-label="电量日志保留时间"]');
 await click('.dc-history-select [role=option]:last-child');
 await wait('document.querySelector("[aria-label=电量日志保留时间]").textContent.includes("7 天")');
 if(await parent('window.__qa.batteryHours')!==168)throw Error('Seven-day retention did not persist through the history RPC');
 report.checks.push('battery history uses the shared retention control and refreshes the report after save');
 await evaluate('document.querySelector(".dc-battery-history").scrollIntoView({block:"end"})');
 await capture('battery-history');
 await size(360,320);await navigate('/qa?surface=card&scenario=catalog');
 await click('[data-widget-category=usb]');
 await wait('document.querySelector("[data-device=pixel] img[alt=设备型号参考图片]")?.naturalWidth>0');
 report.checks.push('desktop widget renders the same cached model image');
 await size(800);
 await navigate('/ui/index.html');await check('document.querySelector(".dc-group-heading .dc-display-settings").disabled','standalone preview disables system settings');
 await click('[data-category=adb]');await check('document.querySelector(".dc-adb-empty").textContent.includes("没有检测到 ADB 设备") && !document.querySelector(".dc-adb-empty").textContent.includes("正在读取")','standalone ADB preview finishes its empty state without native access');await click('[data-category=all]');
 await click('[data-device=dell]');await wait('document.querySelector("dialog").open');await check('document.querySelector("dialog .dc-display-settings").disabled','standalone display detail also remains read-only');
 // The legacy limit=3 in the parent config must not truncate existing cards.
 await size(360,320);await navigate('/qa?surface=card&scenario=adb');
 await check('document.querySelectorAll("[data-device]").length===12 && document.querySelector(".widget-device-list").scrollHeight>document.querySelector(".widget-device-list").clientHeight','old three-device cards now have all devices in a bounded scrolling list');
 const listPoint=await evaluate('(()=>{const r=document.querySelector(".widget-device-list").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()');
 await send('Input.dispatchMouseEvent',{type:'mouseWheel',...listPoint,deltaY:650,deltaX:0});await sleep(200);
 await check('document.querySelector(".widget-device-list").scrollTop>0 && document.querySelector("[data-device=adb-offline]").getBoundingClientRect().bottom<=innerHeight+1','wheel scroll reaches devices after the first eight without moving the page');
 await send('Input.dispatchMouseEvent',{type:'mouseWheel',...listPoint,deltaY:-1000,deltaX:0});await wait('document.querySelector(".widget-device-list").scrollTop===0');
 await sleep(150); // Let Chromium finish the wheel gesture before the pointer test.
 const edgePoints=await evaluate('(()=>{const a=document.querySelector("[data-order-handle=airpods]").getBoundingClientRect(),b=document.querySelector(".widget-device-list").getBoundingClientRect();return {source:{x:a.left+a.width/2,y:a.top+a.height/2},edge:{x:b.right-35,y:b.bottom-8}}})()');
 await send('Input.dispatchMouseEvent',{type:'mouseMoved',...edgePoints.source});await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...edgePoints.source});
 await send('Input.dispatchMouseEvent',{type:'mouseMoved',buttons:1,...edgePoints.edge});
 await wait('document.querySelector(".widget-device-list").scrollTop>35 && document.querySelector(".is-order-dragging")');
 report.checks.push('dragging near the list edge scrolls to devices outside the visible rows');
 await keyboard('Escape','Escape',27);await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...edgePoints.edge});
 await check('!document.querySelector(".is-order-dragging") && !document.querySelector("[data-drop]") && !document.querySelector(".widget-drag-ghost")','Escape removes the floating card and restores the original slots');
 if(await parent('window.__qa.requests.includes("widget_order_set")'))throw Error('Cancelled drag persisted an order');
 report.checks.push('cancelled edge drag does not write device preferences');
 await click('[data-widget-category=usb]');
 const deviceIds=()=>evaluate('[...document.querySelectorAll("[data-device]")].map(e=>e.dataset.device)');
 const points=await evaluate(`(()=>{
   const rect=id=>document.querySelector('[data-order-item="'+id+'"]').getBoundingClientRect();
   const handle=document.querySelector('[data-order-handle=iphone]').getBoundingClientRect();
   const pixel=rect('pixel'),ssd=rect('ssd'),reader=rect('reader');
   const x=pixel.left+pixel.width/2;
   return {
     source:{x:handle.left+handle.width/2,y:handle.top+handle.height/2},
     originalGap:{x,y:pixel.bottom-5},
     belowSsd:{x,y:ssd.bottom-4},
     aboveReader:{x,y:reader.top+4},
     target:{x,y:pixel.top+5}
   };
 })()`);
 await send('Input.dispatchMouseEvent',{type:'mouseMoved',...points.source});
 await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...points.source});
 await send('Input.dispatchMouseEvent',{type:'mouseMoved',buttons:1,...points.originalGap});
 await check('document.querySelector(".is-order-dragging") && !document.querySelector("[data-drop]")','dragging into the original slot does not suggest a move');
 await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...points.originalGap});
 if(await parent('window.__qa.requests.includes("widget_order_set")'))throw Error('Dropping into the original slot writes a preference');
 await evaluate('window.__qaPointer=[];for(const type of ["pointerdown","pointermove","pointerup","pointercancel","gotpointercapture","lostpointercapture"])document.addEventListener(type,e=>window.__qaPointer.push({type:e.type,target:e.target.closest?.("[data-order-handle]")?.dataset.orderHandle,id:e.pointerId,primary:e.isPrimary,x:e.clientX,y:e.clientY,buttons:e.buttons}),true)');
 await send('Input.dispatchMouseEvent',{type:'mouseMoved',...points.source});await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...points.source});
 await send('Input.dispatchMouseEvent',{type:'mouseMoved',buttons:1,...points.belowSsd});
 await check('document.querySelector(".widget-drag-ghost")?.getAttribute("aria-hidden")==="true" && document.querySelectorAll("[data-device]").length===4 && document.querySelector("[data-order-item=ssd]").style.getPropertyValue("--drag-shift")==="-42px"','a single floating copy follows the pointer while neighbors slide into the vacated space');
 await sleep(190);await capture('widget-drag-lift');
 await evaluate('window.__qaGapMarker=document.querySelector("[data-drop]");window.__qaGapEdge=window.__qaGapMarker?.dataset.drop');
 await send('Input.dispatchMouseEvent',{type:'mouseMoved',buttons:1,...points.aboveReader});
 await check('window.__qaGapMarker && document.querySelector("[data-drop]")===window.__qaGapMarker && window.__qaGapMarker.dataset.drop===window.__qaGapEdge','both halves of neighboring rows use the same insertion marker for their shared gap');
 await send('Input.dispatchMouseEvent',{type:'mouseMoved',buttons:1,...points.target});
 if(!await evaluate('document.querySelectorAll(".is-dragging").length===1 && document.querySelectorAll("[data-drop]").length===1')){report.dragDebug=await evaluate('({events:window.__qaPointer,scrollY,innerHeight,dragging:document.querySelectorAll(".is-dragging").length,drops:document.querySelectorAll("[data-drop]").length})');report.dragPoints=points;report.parentGeometry=await parent('({scrollY,height:innerHeight,frame:document.querySelector("iframe").getBoundingClientRect().toJSON()})');await capture('pointer-debug');throw Error('Pointer drag did not establish a drop target');}
 report.checks.push('pointer capture starts dragging only from the device handle');
 await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...points.target});
 await wait('document.querySelector(".widget-order-notice").textContent==="顺序已保存"');
 await check('!document.querySelector(".widget-drag-ghost")','the floating drag card is removed after drop');
 if(JSON.stringify(await deviceIds())!==JSON.stringify(['iphone','pixel','ssd','reader']))throw Error('Native drag did not persist the USB order');
 report.checks.push('CDP pointer drag from its handle saves the device order without opening detail');
 if(await parent('Boolean(window.__qa.navigation)'))throw Error('Dragging opened a device detail');
 const keyPoint=await evaluate('(()=>{const r=document.querySelector("[data-order-handle=pixel]").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()');
 await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...keyPoint});await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...keyPoint});
 await keyboard('ArrowDown','ArrowDown',40);await wait('!document.querySelector("[data-order-handle=pixel]").disabled');
 if(JSON.stringify(await deviceIds())!==JSON.stringify(['iphone','ssd','pixel','reader']))throw Error('Keyboard ordering failed');
 await check('document.activeElement.dataset.orderHandle==="pixel"','keyboard reorder retains the same device handle focus');
 const saved=await parent('JSON.stringify(window.__qa.snapshot.widgetOrder)');
 await parent('window.__qa.orderError="QA 无法保存设备顺序"');
 await keyboard('ArrowUp','ArrowUp',38);await wait('document.querySelector(".widget-order-error")?.textContent.includes("QA 无法保存")');
 if(await parent('JSON.stringify(window.__qa.snapshot.widgetOrder)')!==saved)throw Error('Failed saving modified the stored order');
 await check('!!document.querySelector("#widgetOrderRetry") && !!document.querySelector("#widgetOrderDiscard")','save failure preserves the proposed order with explicit retry and discard');
 await parent('window.__qa.orderError=null');await click('#widgetOrderRetry');await wait('!document.querySelector(".widget-order-error")');
 if(JSON.stringify(await deviceIds())!==JSON.stringify(['iphone','pixel','ssd','reader']))throw Error('Explicit retry failed');
 report.checks.push('failed preference write retries against the latest revision and leaves unrelated devices intact');
 // A fresh sandbox instance reads the saved host snapshot, not child storage.
 const previousFrame=frame;await parent('document.querySelector("iframe").src="/ui/widget-card.html?reopen=1#flowhubWidgetToken=qa-token"');frame=undefined;
 for(let i=0;i<100&&!frame;i++){for(const ctx of contexts.values()){if(ctx.id===previousFrame||!ctx.auxData?.isDefault)continue;try{if(await evaluate('!!document.querySelector(".widget")',ctx.id)){frame=ctx.id;break;}}catch{}}if(!frame)await sleep(50);}
 if(!frame)throw Error('Reopened widget did not mount');await wait('document.querySelectorAll("[data-device]").length===12');
 await click('[data-widget-category=usb]');if(JSON.stringify(await deviceIds())!==JSON.stringify(['iphone','pixel','ssd','reader']))throw Error('Reopen lost the saved device order');
 report.checks.push('a fresh opaque widget restores saved ordering and categories keep all devices');
 const firstHandle=await evaluate('(()=>{const r=document.querySelector("[data-order-handle=iphone]").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()');
 await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...firstHandle});await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...firstHandle});
 await keyboard('End','End',35);await wait('!document.querySelector("[data-order-handle=iphone]").disabled');
 await check('document.activeElement.dataset.orderHandle==="iphone" && document.activeElement.getBoundingClientRect().bottom<=innerHeight+1 && document.querySelector(".widget-device-list").scrollTop>0','keyboard End keeps the moved handle visible in a short widget');
 await keyboard('Home','Home',36);await wait('!document.querySelector("[data-order-handle=iphone]").disabled');
 await check('document.activeElement.getBoundingClientRect().top>=document.querySelector(".widget-device-list").getBoundingClientRect().top','keyboard Home scrolls the same handle back into view');
 await parent('window.__qa.holdOrder=true');await keyboard('ArrowDown','ArrowDown',40);await click('[data-widget-category=overview]');
 await parent('window.__qa.holdOrder=false;window.__qa.finishOrder()');await wait('!document.querySelector("[data-order-handle=iphone]").disabled');
 await check('document.activeElement.dataset.widgetCategory==="overview" && document.querySelectorAll("[data-device]").length===12','a delayed save preserves the newly chosen category and its focus');
 await click('[data-widget-category=usb]');
 for(const theme of ['light','dark'])for(const width of [280,360]){await size(width,320);await parent(`document.querySelector('iframe').contentWindow.postMessage({type:'flowhub:theme',theme:'${theme}'},'*')`);await sleep(100);await check('document.documentElement.scrollWidth<=innerWidth && document.querySelectorAll("[data-order-handle]").length===4','full-list order handles fit '+theme+' '+width);if(width===360)await capture('widget-order-'+theme);}
 await navigate('/ui/widget-card.html');await check('[...document.querySelectorAll("[data-order-handle]")].every(e=>e.disabled)','standalone widget preview never persists preferences');

 await size(800);await navigate('/qa?widget=1&scenario=k75&device=usb-k75');
 await wait('document.querySelector(".dc-keyboard-mode [role=status]")?.textContent==="Mac 模式"');
 await check('document.querySelector(".dc-keyboard-mode").textContent.includes("0x4023")','USB K75 details display the detected Mac mode and USB release');
 await parent('window.__qa.keyboardMode={status:"read",mode:"windows",usbRelease:"0x4023"}');
 await wait('document.querySelector(".dc-keyboard-mode [role=status]").textContent==="Windows 模式"');
 await parent('window.__qa.keyboardMode={status:"read",mode:"unknown",usbRelease:"0x4024"}');
 await wait('document.querySelector(".dc-keyboard-mode [role=status]").textContent==="模式未知"');
 report.checks.push('mode refresh follows Windows and unknown readings without reopening details');
 await size(280,420);await navigate('/qa?surface=editor');
 await check('!document.querySelector("[data-order-item=keyboard] input").checked && document.querySelector("[data-order-item=devices] input").checked && document.querySelector("[data-order-item=power] input").checked','existing widget config keeps power and devices with keyboard mode opt-in');
 await click('[data-order-item=keyboard] input');
 const cardPoints=await evaluate(`(()=>{const a=document.querySelector('[data-order-handle=keyboard]').getBoundingClientRect(),b=document.querySelector('[data-order-item=power]').getBoundingClientRect();return {start:{x:a.left+a.width/2,y:a.top+a.height/2},end:{x:a.left+a.width/2,y:b.top+8}};})()`);
 await send('Input.dispatchMouseEvent',{type:'mouseMoved',...cardPoints.start});
 await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...cardPoints.start});
 await send('Input.dispatchMouseEvent',{type:'mouseMoved',buttons:1,...cardPoints.end});
 const editorDrag='document.querySelectorAll(".widget-drag-ghost").length===1 && document.querySelectorAll(".editor-cards [data-drop]").length===1';
 if(!await evaluate(editorDrag)){
  report.editorDragDebug={cardPoints,hit:await evaluate(`document.elementFromPoint(${cardPoints.start.x},${cardPoints.start.y})?.outerHTML`),height:await evaluate('innerHeight')};
  await capture('editor-drag-debug');
 }
 await check(editorDrag,'editor drag uses one floating card and one insertion target');
 await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...cardPoints.end});
 await check('document.querySelector(".editor-cards").firstElementChild.dataset.orderItem==="keyboard" && document.querySelector("[data-order-item=keyboard] input").checked && !document.querySelector(".widget-drag-ghost")','dropping reorders cards and preserves each checkbox');
 await evaluate('document.querySelector("[data-order-handle=power]").focus()');
 await keyboard('End','End',35);
 await check('document.querySelector(".editor-cards").lastElementChild.dataset.orderItem==="power" && document.activeElement.dataset.orderHandle==="power"','keyboard sorting preserves the moved handle focus');
 await click('[data-order-item=devices] input');
 await parent(`document.querySelector('iframe').contentWindow.postMessage({type:'flowhub:widget-save',token:'qa-token',id:'save-cards'},'*')`);
 await wait('document.documentElement.scrollWidth<=innerWidth');
 await sleep(100);
 const savedCards=await parent('window.__qa.savedConfig?.cards');
 if(JSON.stringify(savedCards)!==JSON.stringify([{id:'keyboard',visible:true},{id:'devices',visible:false},{id:'power',visible:true}]))throw Error('Saved widget card order or visibility differs from the editor');
 for(const theme of ['light','dark']){
  await parent(`document.querySelector('iframe').contentWindow.postMessage({type:'flowhub:theme',theme:'${theme}'},'*')`);
  await wait('document.documentElement.dataset.theme==='+JSON.stringify(theme));
  await check('document.documentElement.scrollWidth<=innerWidth','editor fits 280px in '+theme);
  await capture('widget-card-editor-'+theme);
 }
 const configParam=encodeURIComponent(JSON.stringify(savedCards));
 await size(280,320);await navigate('/qa?surface=card&scenario=k75&cards='+configParam);
 await wait('document.querySelector("#widgetKeyboardMode")?.textContent==="Mac 模式"');
 await check('[...document.querySelectorAll("[data-widget-card]")].map(card=>card.dataset.widgetCard).join(",")==="keyboard,power" && !document.querySelector(".widget-counts")','reopened widget uses the editor configuration and skips hidden cards');
 await parent('window.__qa.keyboardMode={status:"unavailable"}');
 await wait('document.querySelector("#widgetKeyboardMode").textContent==="无法读取"');
 await parent('window.__qa.snapshot.devices=window.__qa.snapshot.devices.filter(device=>device.id!=="usb-k75")');
 await wait('document.querySelector("#widgetKeyboardMode").textContent==="未检测到有线 K75"');
 await navigate('/qa?surface=editor&cards='+configParam);
 await check('document.querySelector(".editor-cards").firstElementChild.dataset.orderItem==="keyboard" && !document.querySelector("[data-order-item=devices] input").checked','reopened editor restores saved order and disabled cards');

 await size(380,680);await navigate('/qa?widget=1&scenario=usb-tree&view=usb');
 await check('Boolean(document.querySelector("[data-device=usb-k75]").closest("ul").parentElement.querySelector(":scope > [data-device=terminus]") && document.querySelector("[data-device=terminus]").closest("ul").parentElement.querySelector(":scope > [data-device=genesys]"))','USB tree preserves both upstream hubs in a narrow view');
 await click('[data-device=genesys]');
 await check('document.querySelector("[aria-label=直连下游设备]").textContent.includes("Terminus") && document.querySelector("[aria-label=直连下游设备]").textContent.includes("Digital AV Adapter")','hub details list its direct children');
 await evaluate('[...document.querySelectorAll("[aria-label=直连下游设备] button")].find(button=>button.textContent.includes("Digital AV Adapter")).click()');
 await check('document.querySelector(".dc-usb-path h4")?.textContent==="USB-C 模式报告"','adapter detail distinguishes USB Billboard from display output');
 await keyboard('Escape','Escape',27);
 await click('[data-device=usb-k75]');
 await check('[...document.querySelectorAll(".dc-usb-path")].some(section=>section.textContent.includes("Kzzi-K75 5.0"))','USB K75 details link the Bluetooth route as a same-model entry');
 await wait('document.querySelector(".dc-keyboard-presets summary")?.textContent==="有线配置与预设"');
 await click('.dc-keyboard-presets summary');
 await wait('!document.querySelector(".dc-keyboard-actions input")?.disabled');
 await fill('办公室','input[aria-label=预设名称]');
 await evaluate('[...document.querySelectorAll(".dc-keyboard-actions button")].find(button=>button.textContent==="记录当前").click()');
 await wait('document.querySelector("[aria-label=已保存预设]")?.textContent.includes("办公室")');
 await evaluate('[...document.querySelectorAll(".dc-keyboard-actions button")].find(button=>button.textContent==="切换到 Windows").click()');
 await wait('document.querySelector(".dc-keyboard-mode [role=status]").textContent==="Windows 模式"');
 await evaluate('[...document.querySelectorAll("[aria-label=已保存预设] button")].find(button=>button.textContent==="应用").click()');
 await wait('document.querySelector(".dc-keyboard-mode [role=status]").textContent==="Mac 模式"');
 report.checks.push('K75 preset records current state and applies through the guarded switch with readback');
 await click('.dc-keyboard-presets:last-of-type summary');
 await evaluate('[...document.querySelectorAll(".dc-keyboard-presets button")].find(button=>button.textContent==="读取 USB 诊断").click()');
 await wait('document.querySelector(".dc-keyboard-diagnostic")?.textContent.includes("4 / 4")');
 await check('!document.querySelector(".dc-keyboard-diagnostic").textContent.includes("%")','USB diagnostic labels raw power bytes without guessing a battery percentage');
 if(report.errors.length)throw Error(report.errors.join('\n'));
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({checks:report.checks.length,responsive:report.responsive.length,errors:report.errors,output:out}));
}catch(error){report.failure=String(error);await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));throw error;}
finally{socket?.close();chrome.kill('SIGKILL');await new Promise(resolve=>server.close(resolve));await sleep(150);await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:150});}
