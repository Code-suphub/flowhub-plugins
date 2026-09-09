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
