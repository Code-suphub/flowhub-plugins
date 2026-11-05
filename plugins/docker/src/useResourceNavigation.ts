import {useLayoutEffect,useRef,useState,type RefObject} from 'react';
import type {Scope,Selection} from './api';

export type DetailTab='overview'|'logs'|'terminal';
export interface BrowseView {scope:Scope;selection:Selection|null;query:string;tab:DetailTab}
interface Snapshot {context:string;view:BrowseView;listTop:number;detailTop:number;pageTop:number;focus:{key:string;zone:'list'|'detail'}|null}
export function resourceKey(selection:Selection|null):string {
  if(!selection)return 'none';
  if(selection.kind==='container')return 'container:'+selection.id;
  if(selection.kind==='project')return 'project:'+selection.project;
  if(selection.kind==='image')return JSON.stringify(['image',selection.id,selection.reference]);
  return 'images';
}
const viewKey=(view:BrowseView)=>JSON.stringify([view.scope,resourceKey(view.selection),view.query,view.tab]);

export function useResourceNavigation({context,view,apply,disabled,ready,list,detail}: {context:string;view:BrowseView;apply(view:BrowseView):void;disabled:boolean;ready:boolean;list:RefObject<HTMLElement|null>;detail:RefObject<HTMLElement|null>}) {
  const [history,setHistory]=useState<Snapshot[]>([]);
  const pending=useRef<{kind:'open'|'back';context:string;view:string;snapshot?:Snapshot;active:Element|null}|null>(null);
  const entries=history.filter(entry=>entry.context===context);
  const listNode=()=>window.matchMedia('(max-width: 620px)').matches?list.current?.querySelector<HTMLElement>('.docker-resource-list'):list.current;
  useLayoutEffect(()=>{setHistory([]);pending.current=null;},[context]);
  useLayoutEffect(()=>{
    const target=pending.current;if(!target)return;
    if(target.context!==context || target.view!==viewKey(view)){pending.current=null;return;}
    const active=document.activeElement;
    if(active!==document.body && active!==target.active && !detail.current?.querySelector('[data-docker-navigation]')?.contains(active)){pending.current=null;return;}
    if(target.kind==='open'){
      const title=detail.current?.querySelector<HTMLElement>('[data-docker-detail-title]');
      const focus=title || list.current?.querySelector<HTMLInputElement>('input[type="search"]');
      pending.current=null;focus?.focus({preventScroll:true});if(detail.current)detail.current.scrollTop=0;
      if(focus && window.matchMedia('(max-width: 620px)').matches)focus.scrollIntoView({block:'start'});
      return;
    }
    const snapshot=target.snapshot!;
    if(snapshot.focus?.zone==='detail' && !ready)return;
    const pane=listNode();if(pane)pane.scrollTop=snapshot.listTop;
    if(detail.current)detail.current.scrollTop=snapshot.detailTop;
    const zone=snapshot.focus?.zone==='detail'?detail.current:list.current;
    const node=Array.from(zone?.querySelectorAll<HTMLElement>('[data-docker-select]') || []).find(node=>node.dataset.dockerSelect===snapshot.focus?.key);
    pending.current=null;
    const focus=node || list.current?.querySelector<HTMLInputElement>('input[type="search"]');
    focus?.focus({preventScroll:true});
    if(window.matchMedia('(max-width: 620px)').matches){window.scrollTo({top:snapshot.pageTop});focus?.scrollIntoView({block:'nearest'});}
  });
  function change(next:BrowseView,origin?:HTMLElement){
    if(disabled || viewKey(next)===viewKey(view))return;
    const active=document.activeElement;
    const snapshot:Snapshot={context,view:{...view},listTop:listNode()?.scrollTop || 0,detailTop:detail.current?.scrollTop || 0,pageTop:window.scrollY,focus:origin?{key:resourceKey(next.selection),zone:detail.current?.contains(origin)?'detail':'list'}:null};
    setHistory([...entries.slice(-19),snapshot]);
    pending.current={kind:'open',context,view:viewKey(next),active:origin || active};
    apply(next);
  }
  return {canBack:entries.length>0,change,
    select:(selection:Selection|null,origin?:HTMLElement)=>{if(resourceKey(selection)!==resourceKey(view.selection))change({...view,selection,tab:'overview'},origin);},
    clear:()=>{setHistory([]);pending.current=null;},
    back:()=>{const snapshot=entries.at(-1);if(disabled || !snapshot)return;setHistory(entries.slice(0,-1));pending.current={kind:'back',context,view:viewKey(snapshot.view),snapshot,active:document.activeElement};apply(snapshot.view);},
  };
}
