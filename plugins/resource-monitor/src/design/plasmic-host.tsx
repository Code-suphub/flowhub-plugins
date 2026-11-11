import {createRoot} from 'react-dom/client';
import {PlasmicCanvasHost,registerComponent} from '@plasmicapp/host';
import {Button} from '@flowhub/plugin-common/react';
import {ResourceCardStudio} from './ResourceCardStudio';
import '../styles.css';
import '../../../common/ui/flowhub-common.css';

registerComponent(ResourceCardStudio,{
  name:'FlowHubResourceCard',displayName:'FlowHub · 应用资源卡片',
  importPath:'../design/ResourceCardStudio',importName:'ResourceCardStudio',
  description:'使用项目真实 React 卡片，所有数据和操作仅在 Studio 内存中模拟。',
  props:{
    title:{type:'string',defaultValue:'应用资源'},
    showFootprint:{type:'boolean',defaultValue:true},
    showRss:{type:'boolean',defaultValue:false},
    showAccounting:{type:'boolean',defaultValue:false},
    display:{type:'choice',options:['all','top'],defaultValue:'all'},
    limit:{type:'number',defaultValue:5,min:3,max:10},
    theme:{type:'choice',options:['light','dark'],defaultValue:'light'}
  },
  defaultStyles:{width:'380px',height:'340px'}
});
registerComponent(Button,{
  name:'FlowHubButton',displayName:'FlowHub · 公共按钮',
  importPath:'@flowhub/plugin-common/react',importName:'Button',
  props:{children:{type:'slot',defaultValue:[{type:'text',value:'按钮'}]},variant:{type:'choice',options:['primary','secondary','ghost'],defaultValue:'secondary'},size:{type:'choice',options:['sm','md'],defaultValue:'sm'},disabled:'boolean'}
});

// A dedicated dev entry; no design SDK or canvas host is loaded by card-main.
createRoot(document.getElementById('root')!).render(<PlasmicCanvasHost/>);
