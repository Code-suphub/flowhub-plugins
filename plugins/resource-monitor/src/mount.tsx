import type {ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {createApi} from './api';
import type {Api,Context} from './types';

// Both IIFEs keep the same host protocol and editor registration timing.
export function mountSurface(content:(api:Api,context:Context)=>ReactNode) {
  const api=createApi(window),root=createRoot(document.getElementById('root')!);
  const render=(context:Context={})=>flushSync(()=>root.render(content(api,context)));
  const unsubscribe=api.subscribe(render);
  const surface=document.body.dataset.surface;
  if(surface==='main'||surface==='editor'||window.parent===window)render();
  else root.render(<p>正在连接 FlowHub…</p>);
  api.ready();
  window.addEventListener('pagehide',()=>{unsubscribe();root.unmount();api.dispose();},{once:true});
}
