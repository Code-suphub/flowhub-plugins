import {createRoot} from 'react-dom/client';
import {App} from './App';
import {createApi} from './api';
import './styles.css';

const api = createApi(window);
const root = createRoot(document.getElementById('root')!);
root.render(<App api={api} />);
window.addEventListener('pagehide', () => { root.unmount(); api.dispose(); }, {once: true});
