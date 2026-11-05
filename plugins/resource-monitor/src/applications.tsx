import {useEffect,useRef,useState} from 'react';
import type {Api,SourceOrigin,Presentation} from './types';
import {createApplicationMetadataRequests,isNativeApplicationIcon,type ApplicationInfo,type ApplicationMap} from './application-metadata';
export type {ApplicationInfo} from './application-metadata';
import pythonIcon from './icons/python.svg';
import postgresqlIcon from './icons/postgresql.svg';
import mysqlIcon from './icons/mysql.svg';
import tmuxIcon from './icons/tmux.svg';
import redisIcon from './icons/redis.svg';
import androidIcon from './icons/android.svg';

const builtinIcons=new Map(Object.entries({python:pythonIcon,postgresql:postgresqlIcon,mysql:mysqlIcon,tmux:tmuxIcon,redis:redisIcon,android:androidIcon}));

type AppGroup={name:string;appPath?:string|null;source?:string;origin?:SourceOrigin|null;presentation?:Presentation|null};
const emptyApplications:ApplicationMap={};

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
  const [state,setState]=useState(()=>({api,applications:emptyApplications}));
  const requests=useRef<ReturnType<typeof createApplicationMetadataRequests>|null>(null);
  const preview=api.preview;
  const pathsKey=JSON.stringify([...new Set(groups.flatMap(group=>[group.appPath,group.origin?.appPath,...(group.presentation?.sources??[]).map(source=>source.appPath)].filter((path):path is string=>!!path)))].sort());
  useEffect(()=>{
    const current=createApplicationMetadataRequests(api,applications=>setState({api,applications}));
    requests.current=current;
    setState({api,applications:emptyApplications});
    return()=>{current.dispose();requests.current=null;};
  },[api]);
  useEffect(()=>{requests.current?.setPaths(preview?[]:JSON.parse(pathsKey) as string[]);},[api,preview,pathsKey]);
  return state.api===api?state.applications:emptyApplications;
}

export function applicationIcon(iconKey?:string|null,application?:ApplicationInfo,failed:readonly string[]=[]) {
  const native=[application?.relatedApplication?.iconUrl,application?.iconUrl].filter(isNativeApplicationIcon);
  const builtin=builtinIcons.get(iconKey??'')??'';
  return [...native,builtin].find(url=>url&&!failed.includes(url))??'';
}

export function AppMark({name,application,iconKey}:{name:string;application?:ApplicationInfo;iconKey?:string|null}) {
  const [failed,setFailed]=useState<string[]>([]);
  const url=applicationIcon(iconKey,application,failed);
  return <span className={'app-mark'+(url?' has-icon':'')} aria-hidden="true">{url?<img src={url} alt="" onError={()=>setFailed(previous=>previous.includes(url)?previous:[...previous,url])}/>:name.slice(0,1).toUpperCase()}</span>;
}
