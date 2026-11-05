import {App,Theme} from './App';
import {Editor} from './Widget';
import {mountSurface} from './mount';
import './styles.css';

const surface=document.body.dataset.surface;
mountSurface((api,context)=><Theme>{surface==='editor'?<Editor api={api} context={context}/>:<App api={api} context={context}/>}</Theme>);
