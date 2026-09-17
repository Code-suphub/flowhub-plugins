(() => {
  let init,handler;const pending=new Map();let sequence=0;
  const token=new URLSearchParams(location.hash.slice(1)).get('flowhubWidgetToken');
  const send=value=>parent.postMessage({...value,token},'*');
  window.FlowHubWidget={
    onInit(fn){handler=fn;if(init)fn(init);},
    editor(fn){this.validate=fn;},
    invoke(params){return new Promise((resolve,reject)=>{const id=String(++sequence),timer=setTimeout(()=>{pending.delete(id);reject(Error('插件响应超时'));},125000);pending.set(id,{resolve,reject,timer});send({type:'flowhub:widget-rpc',id,params});});}
  };
  window.addEventListener('message',event=>{
    if(event.source!==parent)return;const d=event.data;if(!d||d.token!==token)return;
    if(d?.type==='flowhub:widget-init'){init=d.context;handler?.(init);}
    if(d?.type==='flowhub:widget-result'){const p=pending.get(d.id);if(p){clearTimeout(p.timer);pending.delete(d.id);d.error?p.reject(Error(d.error)):p.resolve(d.result);}}
    if(d?.type==='flowhub:widget-save'){try{const config=FlowHubWidget.validate?.();if(!config)throw Error('组件配置尚未准备好');send({type:'flowhub:widget-config',id:d.id,config});}catch(e){send({type:'flowhub:widget-config',id:d.id,error:String(e.message||e)});}}
  });
  if(parent!==window)send({type:'flowhub:widget-ready'});
  else fetch('widget-preview.json').then(r=>r.json()).then(data=>{init={config:{},snapshot:data.snapshot,preview:true};handler?.(init);});
})();
