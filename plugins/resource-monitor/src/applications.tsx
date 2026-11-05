import {useEffect,useRef,useState} from 'react';
import type {Api,SourceOrigin,Presentation} from './types';
import pythonIcon from './icons/python.svg';
import postgresqlIcon from './icons/postgresql.svg';
import mysqlIcon from './icons/mysql.svg';
import tmuxIcon from './icons/tmux.svg';
import redisIcon from './icons/redis.svg';
import androidIcon from './icons/android.svg';

const builtinIcons=new Map(Object.entries({python:pythonIcon,postgresql:postgresqlIcon,mysql:mysqlIcon,tmux:tmuxIcon,redis:redisIcon,android:androidIcon}));

export interface ApplicationInfo {path:string;name:string;bundleId:string;iconUrl:string;relatedApplication?:{path:string;name:string;bundleId:string;iconUrl:string;evidence:string}|null}
type ApplicationMap=Record<string,ApplicationInfo>;
type AppGroup={name:string;appPath?:string|null;source?:string;origin?:SourceOrigin|null;presentation?:Presentation|null};

export function sourceNames(sources:readonly SourceOrigin[],applications:ApplicationMap) {
  return [...new Set(sources.map(source=>(source.appPath?applications[source.appPath]?.name:undefined)||source.name))].join('、');
}

export function applicationIdentity(group:AppGroup,applications:ApplicationMap) {
  const app=group.appPath?applications[group.appPath]:undefined;
  const originApp=group.origin?.appPath?applications[group.origin.appPath]:undefined;
  const originName=originApp?.name||group.origin?.name;
  const related=app?.relatedApplication;
  const componentName=app?.path.split('/').at(-1)?.replace(/\.app$/i,'')||group.name;
  const ownName=related&&app?.name===related.name?componentName:app?.bundleId==='com.vivo.pcsuite'&&app.name==='pcsuite'?'vivo办公套件':app?.name||group.name;
  const name=group.presentation?.name||(related?`${related.name} · ${ownName}`:ownName);
  const sources=[...new Map([...(group.presentation?.sources??[]),...(group.origin?[group.origin]:[])].map(source=>[source.appPath||source.name,source])).values()];
  const sourceText=sourceNames(sources,applications);
  const description=group.presentation?.name?'独立服务 · 按启动实例操作':
    group.presentation?.services?.length?'包含后台服务 · 按启动实例查看':
    app?.bundleId==='com.vivo.pcsuite'?'vivo 手机连接与同步服务':
    !group.origin&&sourceText?`来源线索：${sourceText} · 独立任务`:
    group.origin?`来源线索：${originName} · ${group.source||'独立任务'}`:
    related?`${related.name} 的辅助应用 · 独立运行`:
    !group.appPath&&['mds','mds_stores'].includes(group.name)?'Spotlight 文件搜索索引 · 系统服务，建议保留':group.source||'';
  return {name,description,app,originName,related,sourceText};
}

export function useApplications(api:Api,groups:readonly {appPath?:string|null;origin?:SourceOrigin|null;presentation?:Presentation|null}[]) {
  const [applications,setApplications]=useState<ApplicationMap>({});
  const requested=useRef(new Set<string>());const generation=useRef(0);
  const pathsKey=JSON.stringify([...new Set(groups.flatMap(group=>[group.appPath,group.origin?.appPath,...(group.presentation?.sources??[]).map(source=>source.appPath)].filter((path):path is string=>!!path)))].sort());
  useEffect(()=>{generation.current++;requested.current.clear();setApplications({});return()=>{generation.current++;};},[api]);
  useEffect(()=>{
    if(api.preview)return;
    const paths=(JSON.parse(pathsKey) as string[]).filter(path=>!requested.current.has(path));
    if(!paths.length)return;
    paths.forEach(path=>requested.current.add(path));
    const revision=generation.current;
    for(let start=0;start<paths.length;start+=64){
      const batch=paths.slice(start,start+64);
      void api.invoke<{applications:ApplicationInfo[]}>('application_metadata',{paths:batch}).then(result=>{
        if(revision!==generation.current)return;
        const allowed=new Set(batch);
        setApplications(previous=>({...previous,...Object.fromEntries(result.applications.filter(app=>allowed.has(app.path)).map(app=>[app.path,app]))}));
      }).catch(()=>{/* Older hosts keep the existing name/initial without polling a failing API. */});
    }
  },[api,pathsKey]);
  return applications;
}

export function applicationIcon(iconKey?:string|null,application?:ApplicationInfo,failed:readonly string[]=[]) {
  const native=[application?.relatedApplication?.iconUrl,application?.iconUrl].filter((url):url is string=>!!url&&url.startsWith('data:image/png;base64,'));
  const builtin=builtinIcons.get(iconKey??'')??'';
  return [...native,builtin].find(url=>url&&!failed.includes(url))??'';
}

export function AppMark({name,application,iconKey}:{name:string;application?:ApplicationInfo;iconKey?:string|null}) {
  const [failed,setFailed]=useState<string[]>([]);
  const url=applicationIcon(iconKey,application,failed);
  return <span className={'app-mark'+(url?' has-icon':'')} aria-hidden="true">{url?<img src={url} alt="" onError={()=>setFailed(previous=>previous.includes(url)?previous:[...previous,url])}/>:name.slice(0,1).toUpperCase()}</span>;
}
