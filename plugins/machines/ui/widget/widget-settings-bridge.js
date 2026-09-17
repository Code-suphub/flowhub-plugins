(() => {
  if(!new URLSearchParams(location.search).has('widgetSettings'))return;
  document.body.classList.add('widget-settings');
  let initialize;window.machineSettingsReady=new Promise(resolve=>initialize=resolve);
  const pending=new Map(),token=new URLSearchParams(location.hash.slice(1)).get('flowhubWidgetToken');let seq=0;
  const send=data=>parent.postMessage({...data,token},'*');
  const original=window.FlowHubPlugin?.invoke||window.__TAURI__?.core?.invoke;
  const preview=parent===window;
  const navigate=()=>{location.href='widget-detail.html'+location.hash;};
  const nav=document.createElement('nav');nav.className='settings-navigation';nav.innerHTML='<button type="button">监控曲线</button><button type="button" aria-current="page">设置</button>';nav.firstElementChild.onclick=navigate;document.body.prepend(nav);
  window.FlowHubPlugin={invoke:async(method,request)=>{if(method!=='machines_api')throw Error('此页面只支持机器设置');if(preview&&original)return original(method,request);await window.machineSettingsReady;return new Promise((resolve,reject)=>{const id=String(++seq),timer=setTimeout(()=>{pending.delete(id);reject(Error('配置请求超时'));},125000);pending.set(id,{resolve,reject,timer});send({type:'flowhub:widget-rpc',id,params:{action:'machineSettings',request}});});}};
  window.addEventListener('message',event=>{if(event.source!==parent||event.data?.token!==token)return;const d=event.data;if(d.type==='flowhub:widget-init'){window.machineSettingsContext=d.context;initialize(d.context);}if(d.type==='flowhub:widget-result'){const p=pending.get(d.id);if(!p)return;pending.delete(d.id);clearTimeout(p.timer);d.error?p.reject(Error(d.error)):p.resolve(d.result);}});
  if(preview)initialize({config:{row:new URLSearchParams(location.search).get('row')}});else send({type:'flowhub:widget-ready'});
})();
