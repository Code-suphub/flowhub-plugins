(() => {
  // Sandboxed custom-scheme frames may not expose secure-context randomUUID.
  if (!crypto.randomUUID) crypto.randomUUID = () => {
    const bytes=crypto.getRandomValues(new Uint8Array(16));
    bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
    const hex=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  };
  if(window.parent===window)return;
  const pending=new Map();
  window.addEventListener('message',event=>{
    if(event.source!==window.parent || event.data?.type!=='flowhub:response')return;
    const request=pending.get(event.data.id);if(!request)return;
    pending.delete(event.data.id);clearTimeout(request.timer);
    event.data.error?request.reject(new Error(event.data.error)):request.resolve(event.data.result);
  });
  window.FlowHubPlugin={invoke(method,params){
    return new Promise((resolve,reject)=>{
      const id=Array.from(crypto.getRandomValues(new Uint32Array(4)),value=>value.toString(16).padStart(8,'0')).join(''),timer=setTimeout(()=>{pending.delete(id);reject(new Error('插件宿主响应超时'));},125000);
      pending.set(id,{resolve,reject,timer});window.parent.postMessage({type:'flowhub:request',id,method,params},'*');
    });
  }};
})();
