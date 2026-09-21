import {createRoot} from 'react-dom/client';

import {App} from './App';
import {createApi, type HostContext} from './api';
import './styles.css';

const api = createApi(window);
const root = createRoot(document.getElementById('root')!);

function render(context: HostContext = {}) {
  root.render(<App api={api} context={context}/>);
}

if (window.FlowHubWidget) window.FlowHubWidget.onInit(render);
else render();

window.addEventListener('pagehide', () => {root.unmount(); api.dispose();}, {once: true});
