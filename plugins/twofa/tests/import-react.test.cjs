const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {buildSync}=require('esbuild');
const {JSDOM}=require('jsdom');
const plugin=path.resolve(__dirname,'..');
const code=buildSync({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{App}from'./src/App';import{createApi,demoImportUri}from'./src/api';window.demoImportUri=demoImportUri;window.previewApi=()=>createApi(window);window.mount=api=>createRoot(document.getElementById('root')).render(React.createElement(App,{api}));`,resolveDir:plugin,loader:'tsx'},jsx:'automatic',bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'},alias:{react:path.join(plugin,'node_modules/react'),'react-dom':path.join(plugin,'node_modules/react-dom')},logLevel:'silent'}).outputFiles[0].text;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(predicate){for(let i=0;i<150;i++){if(predicate())return;await delay(10);}assert.ok(predicate(),'2FA UI did not settle');}
const metadata={name:'demo@example.com',issuer:'Example',algorithm:'SHA256',digits:8,period:60};
async function imageFixture(s){const {pixels,publicUri}=require('./qr-fixture.cjs'),QRCode=require('qrcode'),png=await QRCode.toBuffer(publicUri,{width:300}),frame=pixels(publicUri,false,300);s.w.File.prototype.arrayBuffer=async()=>Uint8Array.from(png).buffer;s.w.Image=class{set src(value){if(value)queueMicrotask(()=>this.onload?.());}};s.w.HTMLCanvasElement.prototype.getContext=()=>({fillRect(){},drawImage(){},getImageData(){return {data:frame.data};}});return {png,publicUri,file:new s.w.File([png],'public.png',{type:'image/png'})};}
function paste(s,files=[],text=''){const event=new s.w.Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{items:files.map(file=>({kind:'file',type:file.type,getAsFile:()=>file})),files,getData:()=>text}});s.w.document.querySelector('#twofa-import-uri').dispatchEvent(event);return event;}
function setup(t,{preview=false}={}){
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  w.HTMLElement.prototype.scrollIntoView=function(){};
  w.HTMLElement.prototype.getBoundingClientRect=()=>({x:10,y:10,left:10,top:10,right:130,bottom:42,width:120,height:32});
  const calls=[],copies=[],accounts=[{name:'Legacy',issuer:'Old'}];
  Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async value=>{copies.push(value);}}});
  const api={preview:false,list:async()=>accounts.map(row=>({...row})),code:async name=>({name,code:accounts.find(row=>row.name===name)?.digits===8?'12345678':'123456',remaining:55,period:60}),
    previewImport:async uri=>{calls.push({method:'parse',uri});return {...metadata};},
    importAccount:async(uri,name)=>{calls.push({method:'import',uri,name});accounts.push({...metadata,name});},
    save:async row=>{calls.push({method:'save',...row});const index=accounts.findIndex(account=>account.name===row.previous);if(index>=0)accounts.splice(index,1,{...row});},remove:async()=>{},dispose(){}};
  w.eval(code);const actual=preview?w.previewApi():api;w.mount(actual);t.after(()=>w.close());
  const button=(label)=>[...w.document.querySelectorAll('button,[role="menuitem"]')].find(node=>node.textContent===label);
  const fill=(selector,value)=>{const node=w.document.querySelector(selector);Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new w.Event('input',{bubbles:true}));};
  const submit=()=>w.document.querySelector('#twofa-import-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  const open=async()=>{await wait(()=>button('导入账户'));const trigger=button('导入账户');trigger.focus();trigger.click();await wait(()=>w.document.querySelector('#twofa-import-uri'));return trigger;};
  return {w,api,accounts,calls,copies,button,fill,submit,open,uri:()=>w.demoImportUri};
}
test('mail tab adds the provider suffix to a username and uses the protected host copy API',async t=>{
  const s=setup(t);
  const now=Date.now();
  let connected=false;
  s.api.mailStatus=async()=>connected?{
    accounts:[{provider:'netease',address:'example@163.com',status:'live'}],
    codes:[{id:'mail-fixture',title:'example.test',issuer:'163 邮箱 · 邮件验证码',receivedAt:now,expiresAt:now+300000}],
  }:{accounts:[],codes:[]};
  s.api.addMail=async account=>{
    assert.equal(account.provider,'netease');
    assert.equal(account.address,'example@163.com');
    assert.equal(account.authorizationCode,'fixtureOnly');
    connected=true;
  };
  s.api.copyMail=async id=>s.calls.push({method:'copyMail',id});
  await wait(()=>s.button('邮件验证码'));
  s.button('邮件验证码').click();
  await wait(()=>s.button('＋ 连接邮箱'));
  s.button('＋ 连接邮箱').click();
  await wait(()=>s.w.document.querySelector('#mail-address'));
  assert.equal(s.w.document.querySelector('#mail-address-suffix').textContent,'@163.com');
  s.fill('#mail-address','example');s.fill('#mail-secret','fixtureOnly');
  s.w.document.querySelector('#mail-form').dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));
  await wait(()=>s.button('复制验证码'));
  assert.equal(s.w.document.querySelector('#mail-secret'),null);
  s.button('复制验证码').click();
  await wait(()=>s.calls.some(call=>call.id==='mail-fixture'));
  assert.deepEqual(s.copies,[]);
});
test('switching mail providers preserves the username and a pasted full address is used once',async t=>{
  const s=setup(t);
  s.api.mailStatus=async()=>({accounts:[],codes:[]});
  s.api.addMail=async account=>s.calls.push({provider:account.provider,address:account.address});
  await wait(()=>s.button('邮件验证码'));
  s.button('邮件验证码').click();
  await wait(()=>s.button('＋ 连接邮箱'));
  s.button('＋ 连接邮箱').click();
  await wait(()=>s.w.document.querySelector('#mail-address'));
  s.fill('#mail-address','example@163.com');
  await wait(()=>!s.w.document.querySelector('#mail-address-suffix'));
  s.w.document.querySelector('#mail-provider').click();
  await wait(()=>[...s.w.document.querySelectorAll('[role="option"]')].some(node=>node.textContent==='QQ 邮箱'));
  [...s.w.document.querySelectorAll('[role="option"]')].find(node=>node.textContent==='QQ 邮箱').click();
  await wait(()=>s.w.document.querySelector('#mail-address-suffix')?.textContent==='@qq.com');
  assert.equal(s.w.document.querySelector('#mail-address').value,'example');
  s.fill('#mail-address','other@163.com');s.fill('#mail-secret','fixtureOnly');
  const form=s.w.document.querySelector('#mail-form');
  form.dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));
  await wait(()=>s.w.document.querySelector('[role="alert"]')?.textContent.includes('@qq.com'));
  assert.deepEqual(s.calls,[]);
  s.fill('#mail-address','other@qq.com');
  form.dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));
  await wait(()=>s.calls.length===1);
  assert.deepEqual(s.calls,[{provider:'qq',address:'other@qq.com'}]);
});
test('import previews first, rejects duplicate names locally, and saves only the renamed account',async t=>{
  const s=setup(t);await s.open();s.fill('#twofa-import-uri',s.uri());s.submit();await wait(()=>s.w.document.querySelector('#twofa-import-name'));
  assert.equal(s.calls.filter(call=>call.method==='import').length,0);assert.match(s.w.document.querySelector('dialog').textContent,/SHA256 · 8 位 · 每 60 秒/);
  s.fill('#twofa-import-name','Legacy');await wait(()=>s.button('确认导入').disabled);s.submit();assert.equal(s.calls.filter(call=>call.method==='import').length,0);
  s.fill('#twofa-import-name','Work');await wait(()=>!s.button('确认导入').disabled);s.submit();s.submit();await wait(()=>!s.w.document.querySelector('dialog[open]') && s.w.document.querySelector('[aria-label="Work验证码"]')?.textContent==='1234 5678');
  assert.equal(s.calls.filter(call=>call.method==='import').length,1);assert.equal(s.calls.find(call=>call.method==='import').name,'Work');assert.equal(s.accounts[0].name,'Legacy');
  s.w.document.querySelector('[aria-label="复制 Work 验证码"]').click();await wait(()=>s.copies.length);assert.equal(s.copies[0],'12345678');
});
test('cancelled parsing ignores late replies and restores the import trigger',async t=>{
  const s=setup(t);let resolve;s.api.previewImport=()=>new Promise(done=>{resolve=done;});const trigger=await s.open();s.fill('#twofa-import-uri',s.uri());s.submit();await wait(()=>resolve);s.button('取消').click();resolve({...metadata});
  await wait(()=>!s.w.document.querySelector('dialog[open]') && s.w.document.activeElement===trigger);assert.equal(s.accounts.length,1);
});
test('failed parsing and import preserve the draft; pending saving cannot close or submit twice',async t=>{
  const s=setup(t);let fail=true,finish;s.api.previewImport=async()=>{if(fail)throw new s.w.Error('链接参数无效');return {...metadata};};
  await s.open();s.fill('#twofa-import-uri',s.uri());s.submit();await wait(()=>s.w.document.querySelector('[role="alert"]'));assert.equal(s.w.document.querySelector('#twofa-import-uri').value,s.uri());
  fail=false;s.submit();await wait(()=>s.button('确认导入'));s.api.importAccount=()=>{s.calls.push({method:'import'});return new Promise((_,reject)=>{finish=()=>reject(new s.w.Error('该名称已存在，请修改名称'));});};
  s.submit();s.button('取消').click();s.submit();await wait(()=>finish);assert.ok(s.w.document.querySelector('dialog[open]'));assert.equal(s.calls.filter(call=>call.method==='import').length,1);finish();
  await wait(()=>s.w.document.querySelector('[role="alert"]')?.textContent.includes('该名称已存在'));assert.equal(s.w.document.querySelector('#twofa-import-uri').value,s.uri());assert.equal(s.w.document.querySelector('#twofa-import-name').value,metadata.name);
});
test('changing the URI invalidates the preview and IME or held Enter never confirms an import',async t=>{
  const s=setup(t);await s.open();s.fill('#twofa-import-uri',s.uri());const input=s.w.document.querySelector('#twofa-import-uri');input.dispatchEvent(new s.w.CompositionEvent('compositionstart',{bubbles:true}));s.submit();assert.equal(s.calls.length,0);
  input.dispatchEvent(new s.w.CompositionEvent('compositionend',{bubbles:true}));s.submit();assert.equal(s.calls.length,0);await delay(90);s.submit();await wait(()=>s.button('确认导入'));
  const name=s.w.document.querySelector('#twofa-import-name');assert.equal(name.dispatchEvent(new s.w.KeyboardEvent('keydown',{key:'Enter',repeat:true,bubbles:true,cancelable:true})),false);assert.equal(s.calls.filter(call=>call.method==='import').length,0);
  s.fill('#twofa-import-uri',s.uri()+'&bad=1');await wait(()=>!s.w.document.querySelector('#twofa-import-name'));assert.ok(s.button('解析链接'));assert.equal(s.calls.filter(call=>call.method==='import').length,0);
});
test('standalone preview parses only the public example and cannot import',async t=>{
  const s=setup(t,{preview:true});await s.open();assert.equal(s.w.document.querySelector('#twofa-import-uri').value,s.uri());s.submit();await wait(()=>s.button('确认导入'));assert.equal(s.button('确认导入').disabled,true);s.submit();assert.equal(s.calls.length,0);
  s.fill('#twofa-import-uri','otpauth://totp/Other?secret=NOTREAL');s.submit();await wait(()=>s.w.document.querySelector('[role="alert"]'));assert.match(s.w.document.querySelector('[role="alert"]').textContent,/仅解析示例链接/);
});
test('editing an imported account keeps its algorithm, period and digits when its secret is blank',async t=>{
  const s=setup(t);s.accounts[0]={...metadata,name:'Work'};await wait(()=>s.w.document.querySelector('[aria-label="Work更多操作"]'));s.w.document.querySelector('[aria-label="Work更多操作"]').click();await wait(()=>s.button('编辑'));s.button('编辑').click();await wait(()=>s.w.document.querySelector('#account-name'));
  s.fill('#account-name','Renamed');s.w.document.querySelector('#account-form').dispatchEvent(new s.w.Event('submit',{bubbles:true,cancelable:true}));await wait(()=>s.calls.some(call=>call.method==='save'));const saved=s.calls.find(call=>call.method==='save');assert.equal(saved.algorithm,'SHA256');assert.equal(saved.digits,8);assert.equal(saved.period,60);assert.equal(saved.secret,'');assert.equal(saved.previous,'Work');
});
test('account cards keep service identity, accessible expiry and direct code copy together; search still matches issuer',async t=>{
  const s=setup(t);s.accounts.splice(0,1,{name:'Work',issuer:'GitHub',digits:8,period:60},{name:'Personal',issuer:'Cloudflare'});
  await wait(()=>s.w.document.querySelectorAll('.account-row').length===2 && s.w.document.querySelector('[aria-label="Work验证码"]')?.textContent==='1234 5678');
  const card=s.w.document.querySelector('.account-row');assert.equal(card.querySelector('strong').textContent,'GitHub');assert.match(card.textContent,/Work/);
  const expiry=card.querySelector('[role="progressbar"]');assert.equal(expiry.getAttribute('aria-valuemax'),'60');assert.ok(Number(expiry.getAttribute('aria-valuenow'))>0);
  s.w.document.querySelector('[aria-label="复制 Work 验证码"]').click();await wait(()=>s.copies.length);assert.equal(s.copies[0],'12345678');
  s.fill('[aria-label="搜索账户"]','cloudflare');await wait(()=>s.w.document.querySelectorAll('.account-row').length===1);assert.match(s.w.document.querySelector('.account-row').textContent,/Personal/);
});
test('image selection decodes locally, previews without saving, and confirms only after renaming',async t=>{
  const {pixels,publicUri}=require('./qr-fixture.cjs');const QRCode=require('qrcode');const png=await QRCode.toBuffer(publicUri,{width:300});
  const s=setup(t),frame=pixels(publicUri,false,300);s.w.File.prototype.arrayBuffer=async()=>Uint8Array.from(png).buffer;
  s.w.Image=class {set src(value){if(value)queueMicrotask(()=>this.onload?.());}};
  s.w.HTMLCanvasElement.prototype.getContext=()=>({fillRect(){},drawImage(){},getImageData(){return {data:frame.data};}});
  await s.open();const input=s.w.document.querySelector('[aria-label="二维码图片"]');Object.defineProperty(input,'files',{value:[new s.w.File([png],'public.png',{type:'image/png'})],configurable:true});input.dispatchEvent(new s.w.Event('change',{bubbles:true}));
  await wait(()=>s.button('确认导入'));assert.equal(s.calls[0].uri,publicUri);assert.equal(s.calls.filter(call=>call.method==='import').length,0);
  s.fill('#twofa-import-name','QR public');s.submit();await wait(()=>s.calls.some(call=>call.method==='import'));assert.equal(s.calls.find(call=>call.method==='import').name,'QR public');
});
test('invalid images keep accounts unchanged and readonly preview cannot select image files',async t=>{
  const s=setup(t);await s.open();const input=s.w.document.querySelector('[aria-label="二维码图片"]');Object.defineProperty(input,'files',{value:[new s.w.File(['x'],'bad.png',{type:'image/png'})]});s.w.File.prototype.arrayBuffer=async()=>Uint8Array.of(1,2,3).buffer;input.dispatchEvent(new s.w.Event('change',{bubbles:true}));
  await wait(()=>s.w.document.querySelector('[role="alert"]'));assert.match(s.w.document.querySelector('[role="alert"]').textContent,/PNG|JPEG/);assert.equal(s.calls.length,0);assert.equal(s.accounts.length,1);
  const p=setup(t,{preview:true});await p.open();assert.equal(p.button('选择二维码图片').disabled,true);assert.equal(p.w.document.querySelector('[aria-label="二维码图片"]').disabled,true);
});
test('image paste previews locally and does not save; text paste remains a normal edit',async t=>{
  const s=setup(t),fixture=await imageFixture(s);await s.open();assert.equal(paste(s,[],'normal text').defaultPrevented,false);assert.equal(s.calls.length,0);
  assert.equal(paste(s,[fixture.file]).defaultPrevented,true);await wait(()=>s.button('确认导入'));assert.equal(s.calls[0].uri,fixture.publicUri);assert.equal(s.calls.filter(c=>c.method==='import').length,0);await wait(()=>s.w.document.activeElement===s.w.document.querySelector('#twofa-import-name'));
});
test('multiple pasted images and readonly preview never invoke image or capture requests',async t=>{
  const s=setup(t),fixture=await imageFixture(s);await s.open();paste(s,[fixture.file,fixture.file]);await wait(()=>s.w.document.querySelector('[role="alert"]'));assert.match(s.w.document.querySelector('[role="alert"]').textContent,/一张图片/);assert.equal(s.calls.length,0);
  const p=setup(t,{preview:true});await p.open();assert.equal(p.button('扫描屏幕二维码').disabled,true);paste(p,[fixture.file]);await wait(()=>p.w.document.querySelector('[role="alert"]'));assert.match(p.w.document.querySelector('[role="alert"]').textContent,/只读预览/);assert.equal(p.calls.length,0);
});
test('screen capture is explicit and deduplicated; cancellation restores focus without creating an account',async t=>{
  const s=setup(t);let finish,count=0;s.api.captureScreen=()=>{count++;return new Promise(resolve=>{finish=resolve;});};await s.open();assert.equal(count,0);s.button('扫描屏幕二维码').click();s.button('扫描屏幕二维码').click();await wait(()=>finish);assert.equal(count,1);assert.equal(s.button('取消').disabled,true);assert.equal(s.button('框选中…').disabled,true);finish({cancelled:true});await wait(()=>s.w.document.querySelector('dialog [role="status"]')?.textContent.includes('已取消屏幕框选'));assert.equal(s.calls.length,0);assert.equal(s.accounts.length,1);await wait(()=>s.w.document.activeElement===s.w.document.querySelector('#twofa-import-uri'));
});
test('captured PNG shares preview and save flow; permission and malformed-image errors preserve the URI draft',async t=>{
  const s=setup(t),fixture=await imageFixture(s);s.api.captureScreen=async()=>({image:fixture.png.toString('base64')});await s.open();s.button('扫描屏幕二维码').click();await wait(()=>s.button('确认导入'));assert.equal(s.calls[0].uri,fixture.publicUri);assert.equal(s.calls.filter(c=>c.method==='import').length,0);s.fill('#twofa-import-name','Screen public');s.submit();await wait(()=>s.calls.some(c=>c.method==='import'));assert.equal(s.calls.find(c=>c.method==='import').name,'Screen public');
  await wait(()=>!s.w.document.querySelector('dialog[open]'));await s.open();s.fill('#twofa-import-uri','retained draft');s.api.captureScreen=async()=>{throw new s.w.Error('需要屏幕录制权限');};s.button('扫描屏幕二维码').click();await wait(()=>s.w.document.querySelector('[role="alert"]'));assert.equal(s.w.document.querySelector('#twofa-import-uri').value,'retained draft');s.api.captureScreen=async()=>({image:'PRIVATE_INVALID_IMAGE'});s.button('扫描屏幕二维码').click();await wait(()=>s.w.document.querySelector('[role="alert"]')?.textContent.includes('图片无效'));assert.ok(!s.w.document.querySelector('dialog').textContent.includes('PRIVATE_INVALID_IMAGE'));
});
