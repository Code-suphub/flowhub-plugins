import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {App,Theme} from './App';
import {Card,Editor} from './Widget';
import {createApi} from './api';
import type {Context} from './types';
import './styles.css';

const api=createApi(window),root=createRoot(document.getElementById('root')!);
const surface=document.body.dataset.surface;
function render(context:Context={}) {
  flushSync(()=>root.render(<Theme>{surface==='card'?<Card api={api} context={context}/>:surface==='editor'?<Editor api={api} context={context}/>:<App api={api} context={context}/>}</Theme>));
}
api.subscribe(render);
if(surface==='main'||surface==='editor'||window.parent===window)render();
else root.render(<p>正在连接 FlowHub…</p>);
api.ready();
window.addEventListener('pagehide',()=>{root.unmount();api.dispose();},{once:true});
