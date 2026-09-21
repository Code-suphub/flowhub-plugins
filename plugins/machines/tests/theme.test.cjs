const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function setup(hosted=false,blocked=false){
  const listeners={},messages=[],storage=new Map(),media={matches:false,addEventListener(_,fn){this.change=fn;}};
  const document={documentElement:{dataset:{},style:{}}};
  const window={addEventListener:(n,f)=>listeners[n]=f,dispatchEvent:e=>listeners[e.type]?.(e)};
  window.parent=hosted?{postMessage:m=>messages.push(m)}:window;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../common/ui/flowhub-theme.js'),'utf8'),{window,document,Event,matchMedia:()=>media,localStorage:{getItem:k=>storage.get(k),setItem(k,v){if(blocked)throw Error('denied');storage.set(k,v);}}});
  return {window,document,media,listeners,storage,messages};
}
test('standalone theme remembers choice and follows system changes',()=>{
  const s=setup();assert.equal(s.document.documentElement.dataset.theme,'light');
  s.media.matches=true;s.media.change();assert.equal(s.document.documentElement.dataset.theme,'dark');
  s.window.FlowHubTheme.set('light');assert.equal(s.storage.get('flowhub.theme'),'light');
  s.media.change();assert.equal(s.document.documentElement.dataset.theme,'light');
  s.listeners.storage({key:'flowhub.theme',newValue:'dark'});assert.equal(s.document.documentElement.dataset.theme,'dark');
  s.listeners.storage({key:null,newValue:null});assert.equal(s.window.FlowHubTheme.get(),'system');
});
test('embedded surfaces accept only parent theme messages and do not override the host',()=>{
  const s=setup(true);assert.equal(s.messages[0].type,'flowhub:theme-ready');
  const data={type:'flowhub:theme',theme:'dark',preference:'system'};
  s.listeners.message({source:{},data});assert.equal(s.document.documentElement.dataset.theme,'light');
  s.listeners.message({source:s.window.parent,data});assert.equal(s.document.documentElement.dataset.theme,'dark');
  s.window.FlowHubTheme.set('light');s.media.change();assert.equal(s.document.documentElement.dataset.theme,'dark');
  s.listeners.message({source:s.window.parent,data:{...data,theme:'invalid'}});assert.equal(s.document.documentElement.dataset.theme,'dark');
});
test('storage denial does not prevent standalone switching',()=>{
  const s=setup(false,true);s.window.FlowHubTheme.set('dark');assert.equal(s.document.documentElement.dataset.theme,'dark');
});
