import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {webcrypto} from 'node:crypto';
const bundle=await build({entryPoints:[new URL('../src/api.ts',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'esm'});
const {createApi}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
function fixture(t,surface='detail') {
  const bus=new EventTarget(),messages=[],timers=new Map();let clock=1000,sequence=0,throwSend=false;
  t.mock.method(globalThis,'setTimeout',fn=>{const id=++sequence;timers.set(id,fn);return id;});
  t.mock.method(globalThis,'clearTimeout',id=>timers.delete(id));
  t.mock.method(Date,'now',()=>clock);
  const parent={postMessage(message){if(throwSend)throw Error('transport closed');messages.push(message);}};
  const host={document:{body:{dataset:{surface}},hidden:false},location:{hash:'#flowhubWidgetToken=private-token'},parent,crypto:webcrypto,addEventListener:bus.addEventListener.bind(bus),removeEventListener:bus.removeEventListener.bind(bus)};
  const receive=data=>{const event=new Event('message');Object.assign(event,{source:parent,data});bus.dispatchEvent(event);};
  const api=createApi(host);
  receive({type:'flowhub:widget-init',token:'private-token',context:{config:{}}});
  t.after(()=>api.dispose());
  return {api,host,messages,timers,failSend(){throwSend=true;},timeout(){clock+=20000;const [id,fn]=timers.entries().next().value;timers.delete(id);fn();},
    response(message,result,error){receive({type:surface==='main'?'flowhub:response':'flowhub:widget-result',token:'private-token',id:message.id,result,error});},
    events(){return messages.filter(m=>m.method==='diagnostic_event'||m.params?.method==='diagnostic_event').map(m=>surface==='main'?m.params:m.params.params);}};
}
test('timeouts, late replies and recovery are recorded once without query, paths or error text',async t=>{
  const f=fixture(t),params={query:'private project',path:'/private/file',token:'private-operation-token'};
  const pending=f.api.invoke('ranking_snapshot',params),request=f.messages.at(-1),rejected=assert.rejects(pending,/超时/);
  f.host.document.hidden=true;f.timeout();await rejected;
  assert.deepEqual(f.events(),[{code:'timeout',method:'ranking_snapshot',surface:'detail',elapsedMs:20000,hidden:true,hiddenAtStart:false}]);
  f.response(request,{at:1});assert.equal(f.events().at(-1).code,'late_response');
  f.host.document.hidden=false;const retry=f.api.invoke('ranking_snapshot',params),retryRequest=f.messages.at(-1);
  f.response(retryRequest,{at:2});await retry;assert.equal(f.events().at(-1).code,'recovered');
  const next=f.api.invoke('ranking_snapshot',params);f.response(f.messages.at(-1),{at:3});await next;
  assert.equal(f.events().filter(e=>e.code==='recovered').length,1);
  const serialized=JSON.stringify(f.events());for(const secret of ['private project','/private/file','private-operation-token','private-token'])assert.equal(serialized.includes(secret),false);
  assert.equal(f.timers.size,0);
});
test('status transport send failure cancels its timer and cannot recursively log errors',async t=>{
  const f=fixture(t,'card');f.failSend();await assert.rejects(f.api.status(),/无法连接/);
  assert.equal(f.timers.size,0);f.api.dispose();assert.equal(f.timers.size,0);
});
test('RPC error text is shown to the caller while diagnostics include only the method and failure class',async t=>{
  const f=fixture(t,'main'),pending=f.api.invoke('group_detail',{groupId:'private-app'}),request=f.messages.at(-1);
  f.response(request,undefined,'private raw error /private/path');await assert.rejects(pending,/private raw error/);
  assert.equal(f.events().at(-1).code,'response_error');assert.equal(f.events().at(-1).method,'group_detail');
  assert.equal(f.events().at(-1).reason,'request_failed');
  assert.equal(JSON.stringify(f.events()).includes('private'),false);assert.equal(f.timers.size,0);
});
test('expected host suspension and lost backend connections have distinct diagnostic reasons',async t=>{
  const f=fixture(t,'card');
  for(const [error,reason] of [['Error: 组件刷新已暂停','paused'],['插件进程已退出，请重新加载','backend_closed']]){
    const request=f.api.status();f.response(f.messages.at(-1),undefined,error);await assert.rejects(request);
    assert.equal(f.events().at(-1).reason,reason);
  }
});
