import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Empty,Tag} from 'antd';
import {RequestDetails} from './RequestDetails';
import {applicationIdentity,useApplications} from './applications';
import {displayError,errorText,RequestError} from './errors';
import type {DisplayError} from './errors';
import type {Api,ScriptObserver,ScriptObservation} from './types';

export function useScriptObserver(api:Api){
  const [observer,setObserver]=useState<ScriptObserver>(),[error,setError]=useState<DisplayError>(''),[legacy,setLegacy]=useState(false),[loading,setLoading]=useState(false),[changing,setChanging]=useState(false);
  const mounted=useRef(true),reading=useRef(false),configuring=useRef(false),latest=useRef<()=>Promise<void>>(async()=>{});
  useEffect(()=>{
    mounted.current=true;let alive=true,native=false,timer:ReturnType<typeof setTimeout>|undefined;
    async function read(){
      clearTimeout(timer);if(reading.current||document.hidden){if(alive)timer=setTimeout(()=>void read(),1000);return;}
      reading.current=true;if(alive)setLoading(true);
      try{
        const next=await api.invoke<ScriptObserver>('script_observer_status');
        if(!next||typeof next.supported!=='boolean'||!Array.isArray(next.records)||!Array.isArray(next.observations))throw Error('自动观察需要新版 FlowHub。');
        native=true;if(alive){setObserver(previous=>previous&&(previous.revision??0)>(next.revision??0)?previous:next);setError('');}
      }catch(reason){if(alive){if(!native){setLegacy(true);return;}setError(displayError(reason));}}
      finally{reading.current=false;if(alive){setLoading(false);if(native)timer=setTimeout(()=>void read(),1000);}}
    }
    latest.current=read;void read();const visible=()=>{if(!document.hidden)void read();};document.addEventListener('visibilitychange',visible);
    return()=>{alive=false;mounted.current=false;clearTimeout(timer);document.removeEventListener('visibilitychange',visible);latest.current=async()=>{};};
  },[api]);
  async function configure(settings:Partial<Pick<ScriptObserver,'enabled'|'keychainNames'>>){
    if(api.preview||configuring.current)return;configuring.current=true;setChanging(true);setError('');
    try{const next=await api.invoke<ScriptObserver>('script_observer_config',settings);if(mounted.current)setObserver(previous=>previous&&(previous.revision??0)>(next.revision??0)?previous:next);}
    catch(reason){if(mounted.current)setError(displayError(reason));}
    finally{configuring.current=false;if(mounted.current)setChanging(false);}
  }
  return {observer,error,legacy,loading,changing,configure,refresh:()=>latest.current()};
}
export function AuthorizationRecords({api,observations,selectedEventId,stale,enabled}:{api:Api;observations:ScriptObservation[];selectedEventId?:string;stale:boolean;enabled:boolean}){
  const [id,setId]=useState(selectedEventId),[event,setEvent]=useState<ScriptObservation>(),[error,setError]=useState<DisplayError>(''),[loading,setLoading]=useState(false);
  const [replaying, setReplaying] = useState(false);
  const request=useRef(0);
  const records=event?.candidates??[];
  const applications=useApplications(api,records.flatMap(record=>[record.source,...record.chain].filter((value):value is NonNullable<typeof value>=>!!value)));
  useEffect(()=>{if(selectedEventId)setId(selectedEventId);},[selectedEventId]);
  useEffect(()=>{
    let alive=true;const sequence=++request.current;setEvent(undefined);setError('');setLoading(false);setReplaying(false);
    if(id){setLoading(true);void api.invoke<ScriptObservation>('script_observer_event',{id})
      .then(next=>{if(alive&&sequence===request.current)setEvent(next);})
      .catch(reason=>{if(alive&&sequence===request.current)setError(displayError(reason));})
      .finally(()=>{if(alive&&sequence===request.current)setLoading(false);});}
    return()=>{alive=false;request.current++;};
  },[api,id]);
  async function replay(eventId: string) {
    const sequence = request.current;
    setReplaying(true);
    setError('');
    try {
      await api.invoke('script_observer_replay', {id: eventId});
    } catch (reason) {
      if (sequence === request.current) setError(displayError(reason));
    } finally {
      if (sequence === request.current) setReplaying(false);
    }
  }
  return <div className="script-records">
    {!observations.length?<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未观察到系统认证窗口"/>:null}
    {observations.map(item=><section className="script-record" key={item.id}>
      <button className="script-record-toggle" aria-expanded={id===item.id} onClick={()=>setId(id===item.id?undefined:item.id)}><span className="script-record-summary"><strong>{item.requestApp?`钥匙串访问 · ${item.requestApp}`:'系统认证窗口 · 来源待核实'}</strong><span className="muted text-xs">{new Date(item.firstSeen).toLocaleTimeString()} · 窗口 {item.windowId} · {item.candidateCount} 条同时段脚本线索</span></span><Tag color={item.visible&&!stale?'blue':undefined}>{stale?'待核实':item.visible?'可见':'最近未见'}</Tag></button>
      {id===item.id?<div className="script-record-detail">
        <p className="muted text-xs mb-2">{item.requestApp?'应用名取自系统钥匙串弹窗。脚本线索单独列出。':'窗口由系统 SecurityAgent 展示。下面仅为当时的脚本线索，不是已确认的发起方。'}</p>
        {loading?<p role="status">正在读取当时的启动链…</p>:null}
        {error?<Alert type="warning" title={errorText(error)} description={error instanceof RequestError?<RequestDetails error={error}/>:undefined}/>:null}
        {event?.id === item.id && event.canReplay && !api.preview ? <Button size="small" className="mb-2" disabled={!enabled} loading={replaying} onClick={() => void replay(item.id)}>重看右上角提示</Button> : null}
        {event?.id===item.id&&!records.length&&!item.requestApp?<p className="muted text-xs">没有采集到可关联的脚本；可能由应用直接请求认证，或脚本已退出。</p>:null}
                {records.map(record=><details className="mt-2" key={record.id} open={records.length === 1}><summary className="text-xs">{record.source?applicationIdentity(record.source,applications).name:'来源未确认'} · {record.process.name} · PID {record.process.pid}</summary><ol className="script-chain mt-2">{record.chain.map(node=><li key={`${node.pid}:${node.started}`}><strong>{node.appPath?applicationIdentity(node,applications).name:node.name} · PID {node.pid}</strong><p className="path muted text-xs">{node.executable}</p></li>)}</ol>{record.chainNote?<p className="muted text-xs">{record.chainNote}</p>:null}</details>)}
        {item.candidateCount>8?<p className="muted text-xs mt-2">同时段线索较多，仅保留其中 8 条。</p>:null}
      </div>:null}
    </section>)}
    {id&&!observations.some(item=>item.id===id)?<Alert type="info" title="选中的记录已过期或已被上限淘汰。"/>:null}
  </div>;
}
