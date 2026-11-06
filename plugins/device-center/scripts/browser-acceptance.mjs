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
const out=resolve(process.argv[2]||join(root,'screenshots'));
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
   const widget=url.searchParams.get('widget')==='1';
   const context={config:{powerIntervalSeconds:5},selection:{deviceId:url.searchParams.get('device')||undefined,view:url.searchParams.get('view')||undefined}};
   const source=widget?'widget-detail.html#flowhubWidgetToken=qa-token':'index.html';
   if(url.searchParams.get('pending')==='1')context.pending=true;
   if(url.searchParams.get('legacy')==='1'){context.config.selection=context.selection;delete context.selection;}
   res.writeHead(200,{'content-type':mime['.html']});
   res.end('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style><script src="/qa-host.js?context='+encodeURIComponent(JSON.stringify(context))+'"></script><iframe id="plugin" sandbox="allow-scripts" src="/ui/'+source+'"></iframe>');return;
  }
  if(url.pathname==='/qa-host.js'){
   const context=JSON.parse(url.searchParams.get('context'));
   res.writeHead(200,{'content-type':mime['.js']});
   res.end(`window.__qa={snapshot:${JSON.stringify(fixture())},artwork:${JSON.stringify(artwork)},error:null,requests:[]};
   let pending=${Boolean(context.pending)};
   window.addEventListener('message',event=>{const frame=document.querySelector('iframe');if(event.source!==frame.contentWindow)return;const m=event.data;if(m.type==='flowhub:theme-ready'){frame.contentWindow.postMessage({type:'flowhub:theme',theme:'light'},'*');return;}if(m.type==='flowhub:widget-ready'){frame.contentWindow.postMessage({type:'flowhub:widget-init',token:'qa-token',context:${JSON.stringify(context)}},'*');return;}if(!['flowhub:request','flowhub:widget-rpc'].includes(m.type))return;const widget=m.type==='flowhub:widget-rpc',method=widget?m.params.method:m.method;window.__qa.requests.push(method);const reply={type:widget?'flowhub:widget-result':'flowhub:response',token:widget?'qa-token':undefined,id:m.id};
   if(method==='open_display_settings'){if(window.__qa.settingsError)reply.error=window.__qa.settingsError;else reply.result={opened:true};if(window.__qa.holdSettings){window.__qa.finishSettings=()=>frame.contentWindow.postMessage(reply,'*');return;}frame.contentWindow.postMessage(reply,'*');return;}
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
 socket.addEventListener('message',({data})=>{const r=JSON.parse(data);if(r.method==='Runtime.executionContextCreated')contexts.set(r.params.context.id,r.params.context);if(r.method==='Runtime.executionContextDestroyed')contexts.delete(r.params.executionContextId);if(r.method==='Runtime.executionContextsCleared')contexts.clear();if(r.method==='Runtime.exceptionThrown')report.errors.push(r.params.exceptionDetails.exception?.description||r.params.exceptionDetails.text);if(r.method==='Network.requestWillBeSent'){const url=r.params.request.url;if(!url.startsWith(origin)&&!url.startsWith('data:')&&url!=='about:blank')report.errors.push('External request: '+url);}if(pending.has(r.id)){const p=pending.get(r.id);pending.delete(r.id);r.error?p.reject(Error(JSON.stringify(r.error))):p.resolve(r.result);}});
 const send=(method,params={})=>new Promise((resolve,reject)=>{pending.set(++serial,{resolve,reject});socket.send(JSON.stringify({id:serial,method,params}));});
 const evaluate=async(expression,contextId=frame)=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,...(contextId?{contextId}:{})});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
 // Explicitly omit contextId for the parent, even after frame is selected.
 const parent=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result?.value;};
 const wait=async(expression,ms=8000)=>{const start=Date.now();while(Date.now()-start<ms){if(await evaluate(expression))return;await sleep(50);}throw Error('Timed out: '+expression);};
 const check=async(expression,label)=>{if(!await evaluate(expression))throw Error(label);report.checks.push(label);};
 const click=async(selector,focus=true)=>{await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');${focus?'e.focus();':''}e.click()})()`);await sleep(70);};
 // The test iframe fills this headless viewport; CDP movement never moves the system mouse.
 const hover=async selector=>{await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1});const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);await send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await sleep(70);};
 const fill=async value=>{await evaluate(`(()=>{const e=document.querySelector('input[aria-label="搜索设备"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`);await sleep(70);};
 const size=(width,height=560)=>send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:2,mobile:false});
 const keyboard=async(key,code=key,vk=0,modifiers=0)=>{await send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:vk,modifiers,...(key==='Enter'?{text:'\r'}:key.length===1?{text:key}:{})});await send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk,modifiers});await sleep(80);};
 const capture=async name=>{await writeFile(join(out,name+'.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));report.screenshots.push(name+'.png');};
 const navigate=async(path='/qa')=>{frame=undefined;await send('Page.navigate',{url:origin+path});for(let n=0;n<120;n++){for(const ctx of contexts.values()){if(!ctx.auxData?.isDefault)continue;try{if(await evaluate('!!document.querySelector(".dc-app")',ctx.id)){frame=ctx.id;break;}}catch{}}if(frame)break;await sleep(50);}if(!frame)throw Error('No React iframe');await wait('document.querySelectorAll("[data-device]").length===9');await evaluate('document.fonts.ready');await sleep(100);};
 const tab=async name=>click('[role=tab][data-tabs-value="'+name+'"]');
 const refresh=async()=>{await parent('window.__qa.snapshot.at=Date.now()');await click('[aria-label="刷新设备"]');await wait('!document.querySelector("[aria-label=刷新设备]").disabled');};
 await send('Page.enable');await send('Runtime.enable');await send('Network.enable');await send('Emulation.setFocusEmulationEnabled',{enabled:true});await size(800);await navigate();
 await wait('document.documentElement.dataset.theme==="light"');
 const geometry=await evaluate(`([...document.querySelectorAll('[data-device]')].map(e=>{const r=e.getBoundingClientRect();return {id:e.dataset.device,visible:r.top>=49&&r.bottom<=innerHeight-26}}))`);
 if(!geometry.every(x=>x.visible))throw Error('800x560 cards are clipped: '+JSON.stringify(geometry));report.checks.push('all nine devices fit 800x560');
 if(artwork.icons.iphone){await wait('document.querySelector("[data-device=iphone] img")?.naturalWidth>0');report.checks.push('packaged macOS iPhone artwork rendered');}
 await check('!!document.querySelector("[data-device=pixel] svg") && !document.querySelector("[data-device=pixel] img")','unknown Android phone uses category artwork');await capture('devices-light');
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
 await navigate('/ui/index.html');await check('document.querySelector(".dc-group-heading .dc-display-settings").disabled','standalone preview disables system settings');
 await click('[data-device=dell]');await wait('document.querySelector("dialog").open');await check('document.querySelector("dialog .dc-display-settings").disabled','standalone display detail also remains read-only');
 if(report.errors.length)throw Error(report.errors.join('\n'));
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({checks:report.checks.length,responsive:report.responsive.length,errors:report.errors,output:out}));
}catch(error){report.failure=String(error);await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));throw error;}
finally{socket?.close();chrome.kill('SIGKILL');await new Promise(resolve=>server.close(resolve));await sleep(150);await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:150});}
