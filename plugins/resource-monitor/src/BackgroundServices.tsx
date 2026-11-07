import {useEffect,useRef,useState} from 'react';
import {Alert,Descriptions,Drawer,Empty,Modal,Tag} from 'antd';
import {Button,Input} from '@flowhub/plugin-common/react';
import {RequestDetails} from './RequestDetails';
import {displayError,errorText,RequestError} from './errors';
import type {DisplayError} from './errors';
import type {Api,BackgroundService,ServicePlan,ServiceSnapshot} from './types';
import {serviceInScope} from './service-model';
export {restartLabel,sameServiceProcess} from './service-model';

export function useBackgroundServices(api:Api,active:boolean){
  const [data,setData]=useState<ServiceSnapshot>(),[error,setError]=useState<DisplayError>('');
  const reading=useRef<Promise<void>|undefined>(undefined),operations=useRef(0),latest=useRef<()=>Promise<void>>(async()=>{});
  useEffect(()=>{
    if(!active)return;
    let alive=true,timer:ReturnType<typeof setTimeout>|undefined;
    async function read(){
      clearTimeout(timer);if(reading.current)return reading.current;
      if(operations.current||document.hidden){timer=setTimeout(()=>void read(),5000);return;}
      const pending=(async()=>{try{const value=await api.invoke<ServiceSnapshot>('services_snapshot');if(alive){setData(value);setError('');}}
      catch(reason){if(alive)setError(displayError(reason));}
      finally{reading.current=undefined;if(alive)timer=setTimeout(()=>void read(),5000);}})();
      reading.current=pending;return pending;
    }
    latest.current=read;void read();
    const visible=()=>{if(!document.hidden)void read();};document.addEventListener('visibilitychange',visible);
    return()=>{alive=false;clearTimeout(timer);document.removeEventListener('visibilitychange',visible);latest.current=async()=>{};};
  },[api,active]);
  async function withOperation<T,>(action:()=>Promise<T>):Promise<T>{
    operations.current++;
    try{await reading.current;return await action();}
    finally{operations.current--;}
  }
  return {data,error,refresh:()=>latest.current(),withOperation};
}

export function BackgroundServices({api,data,error,scope,onClose,onRefresh,onChanged,onAuthorize,withOperation}:{api:Api;data?:ServiceSnapshot;error:DisplayError;scope?:{appPath?:string;ids?:string[];name?:string};onClose:()=>void;onRefresh:()=>Promise<void>;onChanged:()=>void;onAuthorize:()=>void;withOperation:<T>(action:()=>Promise<T>)=>Promise<T>}){
  const [query,setQuery]=useState(''),[plan,setPlan]=useState<ServicePlan>(),[busy,setBusy]=useState(false),[failure,setFailure]=useState<DisplayError>(''),[notice,setNotice]=useState('');
  const [expires,setExpires]=useState(0),[remaining,setRemaining]=useState(0);
  const alive=useRef(true),operating=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{if(!plan)return;const tick=()=>setRemaining(Math.max(0,Math.ceil((expires-Date.now())/1000)));tick();const timer=setInterval(tick,500);return()=>clearInterval(timer);},[plan,expires]);
  async function prepare(service:BackgroundService,action:'stop'|'resume'){
    if(api.preview||operating.current)return;operating.current=true;setBusy(true);setFailure('');setNotice('');
    try{const value=await withOperation(()=>api.invoke<ServicePlan>('service_preview',{id:service.id,action}));if(alive.current){setPlan(value);setExpires(Date.now()+value.expiresIn*1000);}}
    catch(reason){if(alive.current)setFailure(displayError(reason));}
    finally{operating.current=false;if(alive.current)setBusy(false);}
  }
  async function execute(){
    if(!plan||remaining<=0||api.preview||operating.current)return;operating.current=true;setBusy(true);setFailure('');
    try{const result=await withOperation(()=>api.invoke<{ok:boolean;message:string}>('service_confirm',{token:plan.token,confirmed:true}));if(alive.current){setNotice(result.message);setPlan(undefined);onChanged();await onRefresh();}}
    catch(reason){if(alive.current){setFailure(displayError(reason));setPlan(undefined);}}
    finally{operating.current=false;if(alive.current)setBusy(false);}
  }
  const all=data?.services??[],needle=query.trim().toLocaleLowerCase();
  const scoped=all.filter(service=>serviceInScope(service,scope));
  const rows=scoped.filter(service=>!needle||[service.name,service.label,service.program,service.domain,service.identity?.pid?.toString()].some(text=>text?.toLocaleLowerCase().includes(needle)));
  const shownError=failure||error;
  return <Drawer open title={scope?.name?`${scope.name} · 后台服务`:'后台服务'} width={720} zIndex={1400} onClose={()=>{if(!busy&&!plan)onClose();}} closable={!busy&&!plan} maskClosable={!busy&&!plan} keyboard={!busy&&!plan} className="background-service-drawer">
    <Alert type="info" showIcon title="停止后台服务与结束进程不同" description="停止会暂停所选 launchd 服务在当前会话中的自动拉起，并请求其管理的进程退出；不修改永久自启设置。重启、重新登录或应用自行重新注册后可能再次运行。已暂停的服务保留在此列表，可恢复启动。" className="mb-3"/>
    {api.preview?<Alert type="info" title="只读预览，不执行服务操作。" className="mb-3"/>:null}
    {shownError?<Alert type="warning" showIcon title={errorText(shownError)} description={shownError instanceof RequestError?<RequestDetails error={shownError}/>:undefined} className="mb-3" action={/授权|升级|未连接|连接系统/.test(errorText(shownError))?<Button size="sm" onClick={onAuthorize}>检查授权</Button>:<Button size="sm" onClick={()=>{setFailure('');void onRefresh();}}>刷新列表</Button>}/>:null}
    {notice?<Alert type="success" showIcon title={notice} className="mb-3"/>:null}
    <div className="flex items-center gap-2 mb-3"><Input value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索服务名称、PID 或路径" aria-label="搜索后台服务"/><Button size="sm" disabled={busy} onClick={()=>void onRefresh()}>刷新</Button></div>
    <p className="muted text-xs mb-3">仅列出可核验的第三方 LaunchDaemon / LaunchAgent；系统核心服务和 FlowHub 自身受保护。未标注不代表不会被其他守护程序重新拉起。</p>
    <div className="grid gap-3">{rows.map(service=><article className="background-service-record" key={service.id}>
      <div className="flex flex-wrap items-center gap-2"><strong className="min-w-0 flex-1">{service.name}</strong><Tag color={service.paused?'orange':service.identity?'green':undefined}>{service.paused?'已暂停':service.identity?'运行中':'已登记，等待触发'}</Tag></div>
      <div className="muted text-xs mt-1">{service.label} · {service.domain}{service.identity?` · PID ${service.identity.pid}`:''}</div>
      <div className="text-xs mt-2">{service.paused?`原启动规则：${service.restartHint}（当前已暂停）`:service.restartHint}{service.domain==='system'?' · 系统级服务，停止会影响使用它的所有用户。':''}</div>
      <details className="text-xs mt-2"><summary>配置与范围</summary><div className="path muted mt-1">程序：{service.program}<br/>配置：{service.plistPath}</div></details>
      {service.blockedReason?<p className="warning text-xs mt-2">{service.blockedReason}</p>:null}
      <div className="flex justify-end mt-2">{service.paused?<Button size="sm" disabled={api.preview||busy||!!plan||!service.canResume} onClick={()=>void prepare(service,'resume')}>恢复启动</Button>:<Button size="sm" variant="danger" disabled={api.preview||busy||!!plan||!service.canStop} onClick={()=>void prepare(service,'stop')}>停止后台服务</Button>}</div>
    </article>)}</div>
    {!rows.length?<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={data?'当前范围没有可管理的后台服务':error?'服务列表暂不可读取':'正在读取后台服务…'}/>:null}
    <Modal title={plan?.action==='stop'?'停止这个后台服务？':'恢复这个后台服务？'} open={!!plan} zIndex={1600} confirmLoading={busy} closable={!busy} mask={{closable:!busy}} keyboard={!busy} onCancel={()=>{if(!busy)setPlan(undefined);}} onOk={()=>void execute()} okText={remaining<=0?'确认已过期':plan?.action==='stop'?'确认停止服务':'确认恢复启动'} cancelText="取消" okButtonProps={{danger:plan?.action==='stop',disabled:api.preview||remaining<=0}} cancelButtonProps={{disabled:busy}}>
      <Alert type="warning" showIcon title={plan?.action==='stop'?'将暂停该服务并请求其管理的进程退出，相关连接、同步或后台任务可能中断。':'将按原配置重新登记服务，可能启动进程、网络连接或后台任务。'} className="mb-3"/>
      {plan?<Descriptions column={1} size="small" items={[{key:'label',label:'服务',children:plan.service.label},{key:'domain',label:'范围',children:plan.service.domain},{key:'pid',label:'当前 PID',children:plan.service.identity?.pid??'未运行'},{key:'program',label:'程序',children:<span className="path">{plan.service.program}</span>},{key:'path',label:'配置文件',children:<span className="path">{plan.service.plistPath}</span>}]}/>:null}
      <p className="muted text-xs mt-3">仅操作上面的服务。退出延迟或已脱离服务管理的子进程需单独核对；不按应用归组扩大范围。不修改永久自启设置。停止后可从“后台服务”恢复；若所属应用更新配置或程序，需要从应用自身恢复。</p>
      {failure?<Alert type="error" title={errorText(failure)} description={failure instanceof RequestError?<RequestDetails error={failure}/>:undefined}/>:null}
    </Modal>
  </Drawer>;
}
