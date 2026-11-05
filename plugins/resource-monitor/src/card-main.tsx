import {Card} from './Card';
import {mountSurface} from './mount';
import './styles.css';

// Native markup consumes FlowHub's CSS variables directly; no antd Theme needed.
mountSurface((api,context)=><Card api={api} context={context}/>);
