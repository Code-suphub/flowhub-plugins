import {useEffect,useMemo,useState,type CSSProperties} from 'react';
import {Card} from '../Card';
import {defaultRankingOrder,sampleSnapshot,statusFrom} from '../model';
import type {Api,Config,RankingOrder} from '../types';

/** Studio has no host bridge, device access, credentials or production storage.
 * Its controls only update this component's ephemeral demonstration state. */
export function ResourceCardStudio({title='应用资源',showFootprint=true,showRss=false,showAccounting=false,display='all',limit=5,className,theme='light'}:Config&{className?:string;theme?:'light'|'dark'}){
  const [config,setConfig]=useState<Config>({title,showFootprint,showRss,showAccounting,display,limit});
  useEffect(()=>setConfig({title,showFootprint,showRss,showAccounting,display,limit}),[title,showFootprint,showRss,showAccounting,display,limit]);
  const api=useMemo<Api>(()=>{
    const snapshot=statusFrom(sampleSnapshot());
    let sorting:RankingOrder=defaultRankingOrder;
    return {
      preview:false,widget:true,
      async status(){return {...snapshot,at:Date.now(),sorting};},
      async invoke<T>(method:string,params:Record<string,unknown>={}){
        if(method==='application_metadata')return {applications:[]} as T;
        if(method==='set_view_preferences'){
          sorting=params.sorting as RankingOrder;
          return {sorting} as T;
        }
        throw Error('Studio 示例不执行原生请求');
      },
      async saveCardConfig(patch){setConfig(previous=>({...previous,...patch}));},
      navigate(){},subscribe(){return()=>{};},editor(){},ready(){},dispose(){}
    };
  },[]);
  return <div className={className} data-theme={theme} style={{maxWidth:'100%',position:'relative'} as CSSProperties}>
    <Card api={api} context={{config,canSaveConfig:true}} frameStyle={{height:'100%'}}/>
  </div>;
}
