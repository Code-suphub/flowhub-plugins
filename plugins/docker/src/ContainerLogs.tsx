import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Button,Checkbox,HelpPopover,Input,Textarea} from '@flowhub/plugin-common/react';
import type {ManagementApi} from './api';
import {emptyLogs,type LogState} from './log-state';

export function ContainerLogs({api,context,id,available,busy,cached,onRemember,onNotice}:{api:ManagementApi;context:string;id:string;available:boolean;busy:boolean;cached?:LogState;onRemember(context:string,id:string,state:LogState):void;onNotice(text:string):void}) {
  const initial=useRef(cached || emptyLogs()).current;
  const [text,setText]=useState(initial.text),[query,setQuery]=useState(initial.query),[auto,setAuto]=useState(initial.auto),[tail,setTail]=useState(initial.tail);
  const [updatedAt,setUpdatedAt]=useState(initial.updatedAt),[error,setError]=useState(initial.error),[loading,setLoading]=useState(false);
  const output=useRef<HTMLTextAreaElement>(null),scroll=useRef(initial.scrollTop),alive=useRef(true),pending=useRef(false),request=useRef(0),busyRef=useRef(busy);
  busyRef.current=busy;
  const latest=useRef<LogState>(initial);latest.current={text,query,auto,tail,updatedAt,error,scrollTop:scroll.current};
  const refresh=useCallback(async()=>{
    if(!available || pending.current || busyRef.current)return;
    const revision=++request.current;pending.current=true;setLoading(true);
    try {
      const response=await api.invoke<{text:string}>('logs',{id,context});
      if(!alive.current || revision!==request.current)return;
      if(typeof response.text!=='string' || response.text.length>1_100_000)throw Error('日志响应无效或超过显示上限，请使用日志命令查看');
      setText(response.text);setUpdatedAt(Date.now());setError('');
    } catch(reason){if(alive.current && revision===request.current)setError(reason instanceof Error?reason.message:'日志读取失败，请重试');}
    finally{if(alive.current && revision===request.current){pending.current=false;setLoading(false);}}
  },[api,context,id,available]);
  useEffect(()=>{
    alive.current=true;pending.current=false;setLoading(false);if(!document.hidden)void refresh();
    return()=>{alive.current=false;request.current++;onRemember(context,id,latest.current);};
  },[refresh,context,id,onRemember]);
  useEffect(()=>{
    const visible=()=>{if(!document.hidden && (auto || !latest.current.updatedAt))void refresh();};
    document.addEventListener('visibilitychange',visible);
    const timer=auto?window.setInterval(()=>{if(!document.hidden)void refresh();},3000):undefined;
    return()=>{document.removeEventListener('visibilitychange',visible);if(timer!==undefined)window.clearInterval(timer);};
  },[auto,refresh]);
  useLayoutEffect(()=>{
    const node=output.current;if(!node)return;
    if(tail)node.scrollTop=node.scrollHeight;else node.scrollTop=scroll.current;
    scroll.current=node.scrollTop;latest.current.scrollTop=node.scrollTop;
  },[text,tail]);
  useEffect(()=>{onRemember(context,id,latest.current);},[text,query,auto,tail,updatedAt,error,context,id,onRemember]);
  const visible=useMemo(()=>{const needle=query.toLowerCase();return needle?text.split('\n').filter(line=>line.toLowerCase().includes(needle)).join('\n'):text;},[text,query]);
  function copyCommand(){
    const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
    const command='docker --context '+quote(context)+' logs --tail 300 --timestamps '+quote(id);
    if(!navigator.clipboard?.writeText){onNotice(command);return;}
    void navigator.clipboard.writeText(command).then(()=>onNotice('已复制日志命令'),()=>onNotice('无法复制，请手动复制日志命令。'));
  }
  return <div className="docker-logs">
    <div className="docker-log-tools"><Input type="search" aria-label="过滤日志" placeholder="过滤日志内容" value={query} onChange={event=>setQuery(event.target.value)}/><Checkbox checked={auto} onChange={setAuto} label="每 3 秒刷新" disabled={!available}/><Checkbox checked={tail} onChange={setTail} label="跟随最新"/><Button size="sm" disabled={loading || busy || !available} onClick={()=>void refresh()}>刷新日志</Button><Button size="sm" onClick={copyCommand}>复制日志命令</Button><HelpPopover label="日志范围说明">显示最近 300 行，stdout 与 stderr 分段展示，最多各读取 512 KiB。自动刷新为轮询；向上滚动会暂停跟随，原文和筛选留在当前页面内存中。</HelpPopover></div>
    <div className="docker-log-status"><span role="status">{loading?'正在读取日志…':updatedAt?'更新于 '+new Date(updatedAt).toLocaleTimeString():'尚未读取日志'}{query?' · '+visible.split('\n').filter(Boolean).length+' 行匹配':''}</span>{!tail?<Button size="sm" onClick={()=>setTail(true)}>回到最新</Button>:null}</div>
    {error || !available?<div className="docker-log-error" role="alert"><span>{!available?'容器已不在当前列表中。':error}{text?' 当前显示上次成功读取的日志。':''}</span>{available?<Button size="sm" disabled={loading || busy} onClick={()=>void refresh()}>重试日志</Button>:null}</div>:null}
    <Textarea ref={output} readOnly aria-label="容器运行日志" value={visible} placeholder={loading?'正在读取日志…':query?'暂无匹配日志':'暂无日志'} className="docker-log-output" onScroll={event=>{const node=event.currentTarget;scroll.current=node.scrollTop;latest.current.scrollTop=node.scrollTop;const follows=node.scrollHeight-node.clientHeight-node.scrollTop<=12;setTail(previous=>previous===follows?previous:follows);onRemember(context,id,{...latest.current,tail:follows});}}/>
  </div>;
}
