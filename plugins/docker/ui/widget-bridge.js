(() => {
  let context, handler, sequence=0;
  const pending=new Map(), token=new URLSearchParams(location.hash.slice(1)).get('flowhubWidgetToken');
  const send=data=>parent.postMessage({...data,token},'*');
  window.FlowHubWidget={
    onInit(fn){handler=fn;if(context)handler(context);},
    editor(fn){this.validate=fn;},
    navigate(action,selection){send({type:'flowhub:widget-navigate',action,selection});},
    invoke(params){return new Promise((resolve,reject)=>{
      const id=String(++sequence),timer=setTimeout(()=>{pending.delete(id);reject(Error('插件响应超时，请刷新核实容器状态'));},125000);
      pending.set(id,{resolve,reject,timer});send({type:'flowhub:widget-rpc',id,params});
    });}
  };
  addEventListener('message',event=>{
    if(event.source!==parent||!token||event.data?.token!==token)return;
    const d=event.data;
    if(d.type==='flowhub:widget-init'){context=d.context;handler?.(context);}
    if(d.type==='flowhub:widget-result'){const p=pending.get(d.id);if(!p)return;pending.delete(d.id);clearTimeout(p.timer);d.error?p.reject(Error(d.error)):p.resolve(d.result);}
    if(d.type==='flowhub:widget-save'){
      try{const config=FlowHubWidget.validate?.();if(!config)throw Error('配置尚未准备好');send({type:'flowhub:widget-config',id:d.id,config});}
      catch(e){send({type:'flowhub:widget-config',id:d.id,error:e.message});}
    }
  });
  if(parent!==window)send({type:'flowhub:widget-ready'});
  else fetch('widget-preview.json').then(r=>r.json()).then(data=>{context={config:{project:'*'},snapshot:data.snapshot,preview:true};handler?.(context);}).catch(()=>{document.body.textContent='无法加载组件预览';});
})();
