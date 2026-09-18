import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('机器组件编辑器缺少 #root 挂载节点');
}

createRoot(rootElement).render(<App />);
