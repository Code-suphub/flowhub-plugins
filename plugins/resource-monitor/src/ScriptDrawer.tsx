import {useEffect,useRef,useState} from 'react';
import {Alert,Descriptions,Drawer,Empty,Switch,Tabs,Tag} from 'antd';
import {AuthorizationRecords,useScriptObserver} from './ScriptObservation';
import {RequestDetails} from './RequestDetails';
import {displayError,errorText,RequestError} from './errors';
import type {DisplayError} from './errors';
import {Button} from '@flowhub/plugin-common/react';
import {AppMark,applicationIdentity,useApplications} from './applications';
import type {Api,ScriptActivity,ScriptNode} from './types';

const date=(at:number)=>at?new Date(at).toLocaleTimeString():'未读取';
export function ScriptDrawer({api,onClose,selectedEventId}:{api:Api;onClose:()=>void;selectedEventId?:string}) {
  const native=useScriptObserver(api);
  const [legacyData,setData]=useState<ScriptActivity>();
  const [legacyError,setError]=useState<DisplayError>('');
  const [legacyLoading,setLoading]=useState(false);
  const [filter,setFilter]=useState(selectedEventId?'authorizations':'all');
  const observer=native.observer;
  const data=observer?{at:observer.at,records:observer.records,error:observer.error,stale:!observer.at||Date.now()-observer.at>20000}:legacyData;
  const error=native.error||legacyError,loading=native.loading||legacyLoading;
  const [expanded,setExpanded]=useState<string>();
  const refresh=useRef<()=>void>(()=>{});
  const records=data?.records??[];
  const applications=useApplications(api,records.flatMap(record=>[record.source,...record.chain,...(record.responsible?[record.responsible]:[])].filter((item):item is NonNullable<typeof item>=>!!item)));
  const nodeName=(node:ScriptNode)=>node.appPath?applicationIdentity(node,applications).name:node.name;
  useEffect(()=>{if(selectedEventId)setFilter('authorizations');},[selectedEventId]);
  useEffect(()=>{
    if(!native.legacy)return;
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
  },[api,native.legacy]);
  const visible=records.filter(record=>filter==='all'||record.running);
  const stale=!!data&&(!!data.error||data.stale||Date.now()-data.at>20000);
  return <Drawer title="脚本来源" open placement="right" onClose={onClose} size="large" styles={{wrapper:{width:'min(620px,100vw)'},body:{padding:16},header:{padding:16}}} className="script-drawer">
    <p className="muted text-xs mb-3">{api.preview?'只读预览 · 模拟记录。':''}查看系统认证窗口与脚本来源线索。脚本运行不代表请求了授权，同时出现也不能证明它是弹窗发起方。</p>
    {observer?<div className="flex items-center justify-between gap-3 mb-3"><label className="flex items-center gap-2 text-xs"><Switch aria-label="自动观察与右上角提示" checked={observer.enabled} disabled={api.preview||!observer.supported||!observer.available||native.changing} loading={native.changing} onChange={value=>void native.configure({enabled:value})}/>自动观察与右上角提示</label><span className="muted text-xs">{!observer.supported?'当前系统不支持':!observer.available?'监控插件未启用':observer.enabled?'后台每秒观察':'观察已暂停'}</span></div>:native.legacy?<Alert type="info" title="自动观察暂不可用，显示原有的每 5 秒采样记录；请使用新版 FlowHub。" className="mb-3"/>:null}
    {observer?.keychainNames!==undefined?<div className="mb-3">
      <label className="flex items-center gap-2 text-xs"><Switch aria-label="识别钥匙串请求应用" aria-describedby="keychain-names-help" checked={observer.keychainNames} disabled={api.preview||!observer.supported||!observer.available||native.changing} onChange={value=>void native.configure({keychainNames:value})}/>识别钥匙串请求应用</label>
      <p id="keychain-names-help" className="muted text-xs mt-1">需授予 FlowHub 辅助功能权限。只从系统钥匙串弹窗的静态提示提取应用名，跳过密码框和其他输入控件。</p>
    </div>:null}
    <div className="flex items-center justify-between gap-2 mb-3"><span className="muted text-xs">{data?.at?`${date(data.at)} 采样${stale?' · 数据可能已过期':''}`:'正在读取脚本活动…'}</span><Button size="sm" className="compact-button" disabled={loading} onClick={()=>observer?void native.refresh():refresh.current()}>{loading?'读取中…':'刷新记录'}</Button></div>
    {error||data?.error?<Alert type="warning" showIcon title={errorText(error||data?.error)} description={error instanceof RequestError?<RequestDetails error={error}/>:undefined} className="mb-3"/>:null}
    <Tabs activeKey={observer?filter:filter==='authorizations'?'all':filter} onChange={setFilter} items={[...(observer?[{key:'authorizations',label:`认证窗口 (${observer.observations.length})`}]:[]),{key:'all',label:`脚本记录 (${records.length})`},{key:'running',label:`本次可见 (${records.filter(r=>r.running).length})`}]}/>
    {filter==='authorizations'&&observer?<AuthorizationRecords api={api} observations={observer.observations} selectedEventId={selectedEventId} stale={stale} enabled={observer.enabled}/>:<>
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
    })}</div></>}
    <p className="muted text-xs mt-4">{observer?'宿主每秒观察；关闭抽屉后继续，暂停开关可停止观察。脚本和认证窗口记录各保留最近 30 分钟、最多 64 条，重启 FlowHub 后清空。':'每 5 秒采样；记录保留最近 30 分钟、最多 64 条，重载采集服务后清空。'} 同一进程更新原记录，不重复累加。短暂活动仍可能遗漏。不采集截图、脚本正文、密码或完整命令行。</p>
  </Drawer>;
}
