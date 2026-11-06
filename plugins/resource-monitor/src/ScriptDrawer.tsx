import {useEffect,useRef,useState} from 'react';
import {Alert,Descriptions,Drawer,Empty,Tabs,Tag} from 'antd';
import {RequestDetails} from './RequestDetails';
import {displayError,errorText,RequestError} from './errors';
import type {DisplayError} from './errors';
import {Button} from '@flowhub/plugin-common/react';
import {AppMark,applicationIdentity,useApplications} from './applications';
import type {Api,ScriptActivity,ScriptNode} from './types';

const date=(at:number)=>at?new Date(at).toLocaleTimeString():'未读取';
export function ScriptDrawer({api,onClose}:{api:Api;onClose:()=>void}) {
  const [data,setData]=useState<ScriptActivity>();
  const [error,setError]=useState<DisplayError>('');
  const [loading,setLoading]=useState(false);
  const [filter,setFilter]=useState('all');
  const [expanded,setExpanded]=useState<string>();
  const refresh=useRef<()=>void>(()=>{});
  const records=data?.records??[];
  const applications=useApplications(api,records.flatMap(record=>[record.source,...record.chain,...(record.responsible?[record.responsible]:[])].filter((item):item is NonNullable<typeof item>=>!!item)));
  const nodeName=(node:ScriptNode)=>node.appPath?applicationIdentity(node,applications).name:node.name;
  useEffect(()=>{
    let alive=true,running=false,timer:ReturnType<typeof setTimeout>|undefined;
    async function read(){
      if(running||document.hidden)return;
      running=true;clearTimeout(timer);setLoading(true);
      try {
        const next=await api.invoke<ScriptActivity>('script_activity');
        if(alive){setData(previous=>!previous||(next.revision??next.at)>=(previous.revision??previous.at)?next:previous);setError('');}
      } catch(reason){if(alive)setError(displayError(reason));}
      finally{running=false;if(alive){setLoading(false);timer=setTimeout(read,5000);}}
    }
    refresh.current=()=>void read();
    const visible=()=>{if(!document.hidden)void read();};
    void read();document.addEventListener('visibilitychange',visible);
    return()=>{alive=false;clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
  },[api]);
  const visible=records.filter(record=>filter==='all'||record.running);
  const stale=!!data&&(!!data.error||data.stale||Date.now()-data.at>20000);
  return <Drawer title="脚本来源" open placement="right" onClose={onClose} size="large" styles={{wrapper:{width:'min(620px,100vw)'},body:{padding:16},header:{padding:16}}} className="script-drawer">
    <p className="muted text-xs mb-3">{api.preview?'只读预览 · 模拟记录。':''}查看 AppleScript / 自动操作的来源线索。脚本运行不代表正在请求管理员授权。</p>
    <div className="flex items-center justify-between gap-2 mb-3"><span className="muted text-xs">{data?.at?`${date(data.at)} 采样${stale?' · 数据可能已过期':''}`:'正在读取脚本活动…'}</span><Button size="sm" className="compact-button" disabled={loading} onClick={()=>refresh.current()}>{loading?'读取中…':'刷新记录'}</Button></div>
    {error||data?.error?<Alert type="warning" showIcon title={errorText(error||data?.error)} description={error instanceof RequestError?<RequestDetails error={error}/>:undefined} className="mb-3"/>:null}
    <Tabs activeKey={filter} onChange={setFilter} items={[{key:'all',label:`近期记录 (${records.length})`},{key:'running',label:`本次采样可见 (${records.filter(r=>r.running).length})`}]}/>
    {!visible.length&&!loading?<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filter==='running'?'本次采样未发现脚本工具':'尚未记录到脚本活动'}/>:null}
    <div className="script-records">{visible.map(record=>{
      const sourceName=record.source?applicationIdentity(record.source,applications).name:'来源未确认';
      const open=expanded===record.id;
      return <section key={record.id} className="script-record">
        <button className="script-record-toggle" aria-expanded={open} aria-label={`${sourceName} · ${record.process.name} · PID ${record.process.pid}`} onClick={()=>setExpanded(open?undefined:record.id)}>
          <AppMark name={record.source?sourceName:'?'} application={record.source?.appPath?applications[record.source.appPath]:undefined}/>
          <span className="script-record-summary"><strong>{sourceName}</strong><span className="muted text-xs">{record.process.name} · PID {record.process.pid} · {date(record.process.started/1000)} 启动</span></span>
          <span className="script-record-state"><Tag color={record.running&&!stale?'blue':undefined}>{stale?'待核实':record.running?'运行中':'最近未见'}</Tag><span className="muted text-xs">{open?'收起':'启动链 ↓'}</span></span>
        </button>
        <p className="muted text-xs mt-2">{record.source?.evidence??'父链或应用来源不足以确认'} · 最近采集 {date(record.lastSeen)}</p>
        {open?<div className="script-record-detail">
          <h3 className="text-xs mb-2">采集到的启动链</h3>
          <ol className="script-chain">{record.chain.map(node=><li key={`${node.pid}:${node.started}`}><div className="flex items-center gap-2"><strong>{nodeName(node)}</strong><span className="muted text-xs">PID {node.pid} · {node.uid===0?'root':`UID ${node.uid}`}</span></div><p className="path muted text-xs mt-1">{node.executable}</p></li>)}</ol>
          {record.chainNote?<p className="muted text-xs mt-2">{record.chainNote}</p>:null}
          {record.responsible&&!record.chain.some(node=>node.pid===record.responsible?.pid&&node.started===record.responsible.started)?<div className="script-responsibility"><strong className="text-xs">系统责任归属：{nodeName(record.responsible)} · PID {record.responsible.pid}</strong><p className="path muted text-xs mt-1">{record.responsible.executable}</p><p className="muted text-xs mt-1">这是系统提供的另一条来源线索，不代表直接父进程。</p></div>:null}
          <Descriptions size="small" column={1} items={[{key:'first',label:'首次采集',children:new Date(record.firstSeen).toLocaleString()},{key:'last',label:'最近采集',children:new Date(record.lastSeen).toLocaleString()}]}/>
        </div>:null}
      </section>;
    })}</div>
    <p className="muted text-xs mt-4">每 5 秒采样；仅保留本次采集服务运行期间最近 30 分钟、最多 64 条记录，重载后清空。短于采样间隔的活动可能遗漏；“最近未见”表示进程已退出或本次不可读取。仅记录进程与来源元数据，不读取脚本正文、密码或完整命令行。</p>
  </Drawer>;
}
