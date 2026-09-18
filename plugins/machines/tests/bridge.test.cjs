const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('sandbox bridge correlates replies and supplies UUIDs without secure-context APIs',async()=>{
  let listener,sent;const parent={postMessage(message){sent=message;}};
  const window={parent,addEventListener(type,fn){listener=fn;}};
  const crypto={getRandomValues:require('node:crypto').webcrypto.getRandomValues.bind(require('node:crypto').webcrypto)};
  vm.runInNewContext(fs.readFileSync('ui/plugin-bridge.js','utf8'),{window,crypto,Uint8Array,Uint32Array,setTimeout,clearTimeout});
  assert.match(crypto.randomUUID(),/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const result=window.FlowHubPlugin.invoke('health',{});assert.equal(sent.method,'health');
  listener({source:{},data:{type:'flowhub:response',id:sent.id,result:'forged'}});
  listener({source:parent,data:{type:'flowhub:response',id:sent.id,result:'ok'}});
  assert.equal(await result,'ok');
});

test('React widget bridge announces ready only after its editor is registered',()=>{
  let listener;
  const sent=[];
  const parent={postMessage(message){sent.push(message);}};
  const currentScript={dataset:{flowhubReady:'editor'}};
  const window={parent,addEventListener(type,fn){listener=fn;}};
  const context={window,parent,document:{currentScript},location:{hash:''},URLSearchParams,setTimeout,clearTimeout,fetch(){throw Error('embedded widget must not fetch preview data');}};
  vm.runInNewContext(fs.readFileSync('ui/widget/widget-bridge.js','utf8'),context);
  context.FlowHubWidget=window.FlowHubWidget;

  assert.deepEqual(sent,[],'ready must wait for the React editor callback');
  const config={view:'machine',row:'demo',metrics:['cpu'],showCountry:true,showExpiry:false};
  window.FlowHubWidget.editor(()=>config);
  assert.equal(sent.length,1);
  assert.equal(sent[0].type,'flowhub:widget-ready');

  listener({source:parent,data:{type:'flowhub:widget-save',id:'save-1',token:null}});
  assert.equal(sent.length,2);
  assert.equal(sent[1].type,'flowhub:widget-config');
  assert.equal(sent[1].id,'save-1');
  assert.deepEqual(JSON.parse(JSON.stringify(sent[1].config)),config);
});
