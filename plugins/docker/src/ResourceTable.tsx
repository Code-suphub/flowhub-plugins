import {useMemo,useState} from 'react';
import {Checkbox,DataTable,Pagination,Select,type DataTableColumn} from '@flowhub/plugin-common/react';
import type {Container,ImageSummary,NetworkSummary,Scope,Selection,VolumeSummary} from './api';
import {filterContainers,imageLabel,imageReference,statusLabels} from './model';
import {resourceKey} from './useResourceNavigation';
import {ResourceIcon} from './ResourceIcon';

interface Row {key:string;name:string;secondary:string;kind:string;state:string;detail:string;selection:Selection;project?:string;references?:number}
export function ResourceTable({scope,containers,images,volumes,networks,query,onlyIssues,onSelect}:{scope:Scope;containers:Container[];images:ImageSummary[];volumes:VolumeSummary[];networks:NetworkSummary[];query:string;onlyIssues:boolean;onSelect(selection:Selection,origin?:HTMLElement):void}) {
  const [sort,setSort]=useState('name'),[unused,setUnused]=useState(false),[pages,setPages]=useState<Record<string,number>>({});
  const rows=useMemo(()=>{
    const needle=query.trim().toLowerCase();let rows:Row[];
    if(scope==='images')rows=images.map(row=>({key:row.ID+imageReference(row),name:imageLabel(row),secondary:row.ID.slice(0,24),kind:'镜像',state:row.Size,detail:row.CreatedSince,selection:{kind:'image',id:row.ID,reference:imageReference(row)}}));
    else if(scope==='volumes')rows=volumes.map(row=>({key:row.name,name:row.name,secondary:row.scope,kind:row.driver,state:row.references?'已引用':'未引用',detail:`${row.references} 个容器`,references:row.references,selection:{kind:'volume',name:row.name}}));
    else if(scope==='networks')rows=networks.map(row=>({key:row.id,name:row.name,secondary:row.id.slice(0,16),kind:row.driver,state:row.references?'已引用':'未引用',detail:row.ipam.map(ipam=>ipam.subnet).filter(Boolean).join(' · ') || row.scope,references:row.references,selection:{kind:'network',id:row.id}}));
    else rows=filterContainers(containers,scope,query,onlyIssues).map(row=>({key:row.id,name:row.name,secondary:row.id.slice(0,12),kind:row.image,state:row.state==='running'&&row.status.includes('unhealthy')?'健康检查失败':statusLabels[row.state] || row.state,detail:row.ports || '—',project:row.project,selection:{kind:'container',id:row.id}}));
    return rows.filter(row=>(!needle || [row.name,row.secondary,row.kind,row.project || ''].join(' ').toLowerCase().includes(needle)) && (!(scope==='volumes'||scope==='networks') || !unused || row.references===0)).sort((a,b)=>sort==='state'&&scope!=='images'?a.state.localeCompare(b.state) || a.name.localeCompare(b.name):a.name.localeCompare(b.name));
  },[scope,containers,images,volumes,networks,query,onlyIssues,sort,unused]);
  const key=JSON.stringify([scope,query,sort,unused,onlyIssues]),page=Math.min(pages[key] || 1,Math.max(1,Math.ceil(rows.length/25))),visible=rows.slice((page-1)*25,page*25);
  const nameColumn:DataTableColumn<Row>={key:'name',header:'名称',render:row=><button type="button" className="docker-resource-row" data-docker-select={resourceKey(row.selection)} onClick={event=>onSelect(row.selection,event.currentTarget)}><span className="docker-resource-symbol"><ResourceIcon kind={scope}/></span><span className="docker-resource-copy"><strong>{row.name}</strong><small>{row.secondary}</small></span></button>};
  const columns:DataTableColumn<Row>[]=[nameColumn,{key:'kind',header:scope==='volumes'||scope==='networks'?'驱动':scope==='images'?'类型':'镜像',render:row=><span className="docker-table-text">{row.kind}</span>},{key:'state',header:scope==='images'?'大小':'状态',render:row=><span className={'docker-table-status'+(row.state==='运行中'||row.state==='已引用'?' is-active':['重启中','异常','健康检查失败'].includes(row.state)?' is-warning':'')}>{row.state}</span>}];
  if(scope==='all'||scope==='standalone')columns.push({key:'project',header:'项目',render:row=>row.project?<button type="button" className="docker-table-project" data-docker-select={resourceKey({kind:'project',project:row.project})+':from:'+row.key} onClick={event=>onSelect({kind:'project',project:row.project!},event.currentTarget)}>{row.project}</button>:<span className="docker-muted">独立容器</span>});
  if(scope==='images')columns.splice(1,1);
  columns.push({key:'detail',header:scope==='images'?'创建时间':scope==='volumes'?'引用':scope==='networks'?'子网 / 范围':'端口',render:row=><span className="docker-table-text">{row.detail}</span>});
  return <div className="docker-resource-list" aria-label={scope==='images'?'镜像列表':scope==='volumes'?'卷列表':scope==='networks'?'网络列表':'资源列表'}>
    <div className="docker-table-options"><span className="docker-muted">{rows.length} 项</span>{scope==='volumes'||scope==='networks'?<Checkbox checked={unused} onChange={setUnused} label="仅未引用"/>:null}{scope!=='images'?<Select ariaLabel="资源排序" value={sort} onChange={setSort} options={[{value:'name',label:'按名称'},{value:'state',label:'按状态'}]}/>:null}</div>
    <DataTable columns={columns} rows={visible} getRowKey={row=>row.key} caption="Docker 资源" emptyState={query || unused?'没有匹配的资源':'暂无资源'} className="docker-resource-table"/>
    {rows.length>25?<Pagination page={page} pages={Math.ceil(rows.length/25)} onChange={next=>setPages(previous=>Object.fromEntries([...Object.entries(previous).filter(([entry])=>entry!==key).slice(-7),[key,next]]))}/>:null}
  </div>;
}
