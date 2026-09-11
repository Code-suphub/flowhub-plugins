(() => {
  if(parent===window)return;
  const pending=new Map();
  addEventListener('message',event=>{
    if(event.source!==parent||event.data?.type!=='flowhub:response')return;
    const p=pending.get(event.data.id);if(!p)return;clearTimeout(p.timer);pending.delete(event.data.id);
    event.data.error?p.reject(Error(event.data.error)):p.resolve(event.data.result);
  });
  window.FlowHubPlugin={invoke(method,params={}){return new Promise((resolve,reject)=>{
    const id=Array.from(crypto.getRandomValues(new Uint32Array(4)),v=>v.toString(16)).join('-');
    const timer=setTimeout(()=>{pending.delete(id);reject(Error('宿主响应超时，请重载插件'));},125000);
    pending.set(id,{resolve,reject,timer});parent.postMessage({type:'flowhub:request',id,method,params},'*');
  });}};
})();
