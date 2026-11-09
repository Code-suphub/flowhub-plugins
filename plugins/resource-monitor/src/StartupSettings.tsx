import {useEffect,useRef,useState} from 'react';
import {Alert,Drawer,Empty,Modal,Tag} from 'antd';
import {Button} from '@flowhub/plugin-common/react';
import {displayError,errorText,RequestError} from './errors';
import type {DisplayError} from './errors';
import {RequestDetails} from './RequestDetails';
import type {Api,StartupRow,StartupSnapshot} from './types';

const states={enabled:'已开启',disabled:'已关闭',unknown:'暂无法核实'};
const homebrew='Homebrew · 当前用户登录服务';
const sources={mysql:homebrew,postgresql:homebrew,onedrive:'OneDrive Launcher · 登录项',vivo:'vivo 办公套件 · 当前用户服务'};
type RootAccess='checking'|'ready'|'authorize'|'upgrade';
type Selection={row:StartupRow;action:'policy'|'stop'};

export function StartupSettings({api,scope,rootAccess,onAuthorize,onStopped,onClose}:{
  api:Api;scope?:string;rootAccess:RootAccess;onAuthorize:()=>void;onStopped:()=>void;onClose:()=>void;
}){
  const [data,setData]=useState<StartupSnapshot>();
  const [error,setError]=useState<DisplayError>('');
  const [notice,setNotice]=useState<{text:string;warning:boolean}>();
  const [selected,setSelected]=useState<Selection>();
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(false);
  const alive=useRef(false),pending=useRef(false),operating=useRef(false);

  async function refresh(){
    if(pending.current||operating.current)return;
    pending.current=true;setLoading(true);
    try{
      const next=await api.invoke<StartupSnapshot>('startup_snapshot');
      if(alive.current){setData(next);setError('');}
    }catch(reason){if(alive.current){setData(undefined);setError(displayError(reason));}}
    finally{pending.current=false;if(alive.current)setLoading(false);}
  }

  useEffect(()=>{
    alive.current=true;void refresh();
    const focus=()=>void refresh();
    window.addEventListener('focus',focus);
    return()=>{alive.current=false;window.removeEventListener('focus',focus);};
  },[api]);

  async function change(){
    if(api.preview||!selected||pending.current||operating.current)return;
    const {row,action}=selected;
    const revision=action==='stop'?row.stopRevision:row.revision;
    if(!revision||row.system&&rootAccess!=='ready')return;
    const enabled=row.state==='disabled';
    operating.current=true;setBusy(true);setError('');setNotice(undefined);
    let failure:DisplayError='';
    try{
      const target={id:row.id,revision,confirmed:true};
      if(action==='stop'){
        await api.invoke('startup_stop',target);
        if(alive.current){setNotice({text:`${row.name} 后台服务已停止，自启动仍保持关闭。`,warning:false});onStopped();}
      }else{
        const result=await api.invoke<{enabled:boolean;processChanged:boolean}>('startup_set',{...target,enabled});
        if(alive.current)setNotice({text:result.processChanged?'自启动设置已更新，操作期间原服务进程发生变化，请核实运行状态。':result.enabled?'已恢复自启动。':'已关闭自启动，当前服务可继续运行。',warning:result.processChanged});
      }
    }catch(reason){failure=displayError(reason);}
    finally{
      operating.current=false;
      if(alive.current){setSelected(undefined);await refresh();if(alive.current){if(failure)setError(failure);setBusy(false);}}
    }
  }

  async function openSettings(){
    if(api.preview||operating.current)return;
    operating.current=true;setBusy(true);setError('');
    try{await api.invoke('login_items_settings');}
    catch(reason){if(alive.current)setError(displayError(reason));}
    finally{operating.current=false;if(alive.current)setBusy(false);}
  }

  const rows=data?.rows.filter(row=>!scope||(scope==='vivo'?row.kind==='vivo':row.id===scope))??[];
  const restoring=selected?.row.state==='disabled';
  const stopping=selected?.action==='stop';
  const inactive=api.preview||loading||busy||!!selected;
  return <Drawer open title="自启动" width={540} zIndex={1400} onClose={()=>{if(!busy&&!selected)onClose();}} closable={!busy&&!selected} maskClosable={!busy&&!selected} keyboard={!busy&&!selected} className="startup-drawer">
    <div className="flex items-center justify-between gap-2 mb-3">
      <p className="muted text-xs">更改自启动只影响后续加载，当前进程可继续运行。</p>
      <Button size="sm" disabled={loading||busy||!!selected} onClick={()=>void refresh()}>{loading?'读取中…':'刷新'}</Button>
    </div>
    {error?<Alert type="warning" showIcon className="mb-3" title={errorText(error)} description={error instanceof RequestError?<RequestDetails error={error}/>:undefined}/>:null}
    {notice?<Alert type={notice.warning?'warning':'success'} showIcon className="mb-3" title={notice.text}/>:null}
    <div className="grid gap-3">{rows.map(row=>{
      const database=row.kind==='mysql'||row.kind==='postgresql';
      const canShowStop=database&&row.state==='disabled'&&row.loaded;
      return <article className="background-service-record" key={row.id}>
      <div className="flex flex-wrap items-center gap-2"><strong>{row.name}</strong><Tag color={row.state==='enabled'?'green':undefined}>{states[row.state]}</Tag>
        {database&&row.loaded!==undefined?<Tag>{row.loaded?'服务已加载':'服务未加载'}</Tag>:null}
        {row.pid?<Tag>PID {row.pid}</Tag>:null}
      </div>
      <p className="muted text-xs mt-1">{row.system?'vivo 办公套件 · 系统服务（root）':row.blockedReason?'vivo 办公套件 · macOS 登录窗口':sources[row.kind]} · {row.id}</p>
      {canShowStop||row.keepAlive?<Alert className="mt-2" type="warning" showIcon
        title={row.keepAlive?'服务启用了 KeepAlive，结束实例后会被重新拉起。':'服务仍在当前会话中，结束实例后仍可能被重新拉起。'}
        description={canShowStop?(row.stopRevision?'要完全停止这条服务，请选择「停止后台服务」。':'暂无法核验停止条件，请刷新后再试。'):'要停止这条服务，请先关闭自启动，再选择「停止后台服务」。'}/>:null}
      <div className="flex flex-wrap items-center justify-end gap-2 mt-2">
        {row.blockedReason?<span className="muted text-xs">{row.blockedReason}</span>
          :row.kind==='onedrive'?<Button size="sm" disabled={inactive} onClick={()=>void openSettings()}>前往登录项设置</Button>
          :row.system&&rootAccess!=='ready'?(rootAccess==='authorize'?<Button size="sm" disabled={inactive} onClick={onAuthorize}>授权系统服务</Button>
            :<span className="muted text-xs">{rootAccess==='upgrade'?'更新 FlowHub 后可授权配置':'正在核实系统服务权限'}</span>)
          :<Button size="sm" disabled={inactive||!row.revision} onClick={()=>setSelected({row,action:'policy'})}>{row.state==='disabled'?'恢复自启动':'关闭自启动'}</Button>}
        {canShowStop?<Button size="sm" disabled={inactive||!row.stopRevision} onClick={()=>setSelected({row,action:'stop'})}>停止后台服务</Button>:null}
      </div>
    </article>;})}</div>
    {!rows.length?<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading?'正在读取自启动设置…':error?'暂无法读取自启动设置':'没有找到可核验的自启动登记'}/>:null}
    <Modal open={!!selected} title={stopping?`停止 ${selected?.row.name} 后台服务？`:`${restoring?'恢复':'关闭'} ${selected?.row.name??''} 自启动？`} zIndex={1600} onCancel={()=>{if(!busy)setSelected(undefined);}} onOk={()=>void change()} okText={stopping?'确认停止':restoring?'确认恢复':'确认关闭'} cancelText="取消" confirmLoading={busy} closable={!busy} mask={{closable:!busy}} keyboard={!busy} okButtonProps={{disabled:api.preview||loading||selected?.row.system===true&&rootAccess!=='ready',danger:stopping}} cancelButtonProps={{disabled:busy}}>
      <p className="mb-2">{stopping?'从当前登录会话卸载这条服务。现有数据库连接会断开，自启动保持关闭。':restoring?'允许系统后续按原配置加载这条服务，当前不会立即启动。':'禁止系统后续加载这条服务，当前进程和连接可继续运行。'}</p>
      <p className="muted text-xs">{selected?.row.id} · {selected?.row.system?'系统（root）':'当前用户'}</p>
    </Modal>
  </Drawer>;
}
