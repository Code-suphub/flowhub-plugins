import {createRoot} from 'react-dom/client';
import {ResourceCardStudio} from './ResourceCardStudio';
import {showSyncStatus} from './sync-status';
import '../styles.css';
const theme=new URLSearchParams(location.search).get('theme')==='dark'?'dark':'light';
document.documentElement.dataset.theme=theme;
createRoot(document.getElementById('root')!).render(<div style={{width:'min(380px,100vw)',height:340}}><ResourceCardStudio className="h-full w-full" theme={theme} showFootprint showRss/></div>);
showSyncStatus();
