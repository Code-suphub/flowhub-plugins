/// <reference types="vite/client" />

type Status={phase:string;revision:number|null;remoteRevision?:number|null;error?:{message:string}|null};

/** Standalone development preview only; no credentials or native host bridge. */
export function showSyncStatus(){
  const output=document.createElement('p');
  output.setAttribute('role','status');
  output.dataset.plasmicSyncStatus='';
  Object.assign(output.style,{maxWidth:'380px',padding:'12px',margin:'0',font:'12px/1.6 system-ui',color:'var(--fh-muted,#64748b)',boxSizing:'border-box'});
  output.textContent='正在连接自动同步服务…';
  document.body.append(output);
  let active=true,eventReceived=false;
  const render=(status:Status)=>{
    if(!active)return;
    const revision=status.revision===null?'':` · revision ${status.revision}`;
    output.dataset.phase=status.phase;
    if(status.error)output.textContent=`${status.phase==='disabled'?'自动同步未开启':'同步暂停，保留上次预览'}${revision}。${status.error.message}`;
    else if(status.phase==='ready')output.textContent=`自动同步已开启${revision} · Plasmic 保存后自动刷新`;
    else if(status.phase==='syncing')output.textContent=`正在同步 Plasmic${status.remoteRevision?` · revision ${status.remoteRevision}`:''}…`;
    else if(status.phase==='disabled')output.textContent='自动同步已关闭';
    else output.textContent=`正在检查 Plasmic${revision}…`;
  };
  const update=(status:Status)=>{eventReceived=true;render(status);};
  import.meta.hot?.on('flowhub:plasmic-sync',update);
  const controller=new AbortController();
  void fetch('/__plasmic/status',{signal:controller.signal}).then(response=>{
    if(!response.ok)throw Error('status');return response.json();
  }).then(status=>{if(!eventReceived)render(status);}).catch(()=>{
    if(active&&!eventReceived)render({phase:'error',revision:null,error:{message:'开发服务连接中断，请重新启动 plasmic:host。'}});
  });
  import.meta.hot?.dispose(()=>{
    active=false;controller.abort();import.meta.hot?.off('flowhub:plasmic-sync',update);output.remove();
  });
}
