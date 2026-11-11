import {useEffect,useRef,useState} from 'react';
import {Alert,Drawer,Empty,Modal,Tag} from 'antd';
import {Button,HelpPopover} from '@flowhub/plugin-common/react';
import {displayError,errorText,RequestError,type DisplayError} from './errors';
import {RequestDetails} from './RequestDetails';
import type {Api,FinderExtension} from './types';

const states={enabled:'已启用',disabled:'已停用',default:'由系统决定',unknown:'状态无法核实'};

export function FinderExtensions({api,appPath,onClose,onChanged}:{
  api:Api; appPath?:string; onClose:()=>void; onChanged:()=>void;
}) {
  const [data,setData]=useState<FinderExtension[]>();
  const [error,setError]=useState<DisplayError>('');
  const [notice,setNotice]=useState<{text:string;warning:boolean}>();
  const [selected,setSelected]=useState<{row:FinderExtension;enabled:boolean}>();
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const alive=useRef(false);
  const pending=useRef(false);

  async function read() {
    const result=await api.invoke<{rows:FinderExtension[]}>('finder_extensions_snapshot');
    if(alive.current)setData(result.rows);
  }

  async function refresh() {
    if(pending.current)return;
    pending.current=true;
    setLoading(true);
    setError('');
    try {await read();}
    catch(reason) {
      if(alive.current){setData(undefined);setError(displayError(reason));}
    } finally {
      pending.current=false;
      if(alive.current)setLoading(false);
    }
  }

  useEffect(()=>{
    alive.current=true;
    void refresh();
    return()=>{alive.current=false;};
  },[api]);

  async function apply() {
    if(api.preview||pending.current||!selected?.row.revision)return;
    const {row,enabled}=selected;
    pending.current=true;
    setBusy(true);
    setError('');
    setNotice(undefined);
    try {
      const result=await api.invoke<{enabled:boolean;runningCount:number|null}>('finder_extension_set',{
        id:row.id,revision:row.revision,enabled,confirmed:true,
      });
      if(alive.current){
        const running=result.runningCount;
        setNotice({warning:!enabled&&running!==0,text:enabled?'已启用，macOS 将按需加载。':
          running===0?'已停用，当前无运行实例。':running===null?'已停用，暂无法核实实例是否已退出。':`已停用，仍检测到 ${running} 个运行实例。`});
        if(!enabled)onChanged();
      }
    } catch(reason) {
      if(alive.current)setError(displayError(reason));
    } finally {
      try {if(alive.current)await read();}
      catch(reason) {if(alive.current){setData(undefined);setError(previous=>previous||displayError(reason));}}
      pending.current=false;
      if(alive.current){setBusy(false);setSelected(undefined);}
    }
  }

  const rows=data?.filter(row=>!appPath||row.appPath===appPath)??[];
  const close=()=>{if(!busy&&!selected)onClose();};
  const inactive=api.preview||busy||loading||!!selected;
  return <Drawer open title="访达扩展" size="min(520px, 100vw)" zIndex={1400} onClose={close}
    closable={!busy&&!selected} mask={{closable:!busy&&!selected}} keyboard={!busy&&!selected} className="finder-extensions-drawer">
    <div className="flex items-center justify-between gap-2 mb-3">
      <div className="flex items-center gap-2"><span className="muted text-xs">当前用户 · Finder Sync</span>
        <HelpPopover label="访达扩展和自启动的区别">访达扩展有独立开关，应用退出后也可能运行。停用会关闭所选扩展的访达菜单、图标或状态标记。</HelpPopover>
      </div>
      <Button size="sm" disabled={loading||busy||!!selected} onClick={()=>void refresh()}>{loading?'读取中…':'刷新'}</Button>
    </div>
    {error?<Alert type="warning" showIcon className="mb-3" title={errorText(error)}
      description={error instanceof RequestError?<RequestDetails error={error}/>:undefined}/>:null}
    {notice?<Alert type={notice.warning?'warning':'success'} showIcon className="mb-3" title={notice.text}/>:null}
    <div className="grid gap-3">{rows.map(row=><article className="background-service-record" key={row.id+row.bundlePath}>
      <div className="flex flex-wrap items-center gap-2">
        <strong>{row.name}</strong>
        <Tag color={row.state==='enabled'?'green':undefined}>{states[row.state]}</Tag>
        <Tag>{row.runningCount===null?'运行状态未知':row.runningCount>0?`运行中 · ${row.runningCount}`:'未运行'}</Tag>
      </div>
      <p className="path muted text-xs mt-1">{row.appPath} · {row.id}</p>
      <div className="flex flex-wrap items-center justify-end gap-2 mt-2">
        {!row.revision&&!api.preview?<span className="muted text-xs">登记有多份或状态无法核验</span>:null}
        {row.state==='disabled'&&(row.runningCount??0)>0?<Button size="sm" disabled={inactive||!row.revision}
          onClick={()=>setSelected({row,enabled:false})}>结束残留实例</Button>:null}
        <Button size="sm" disabled={inactive||!row.revision}
          onClick={()=>setSelected({row,enabled:row.state==='disabled'})}>{row.state==='disabled'?'启用':'停用'}</Button>
      </div>
    </article>)}</div>
    {!rows.length?<Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={loading?'正在读取访达扩展…':error?'暂无法读取访达扩展':appPath?'此应用没有已登记的访达扩展':'没有找到已登记的访达扩展'}/>:null}
    <Modal open={!!selected} className="finder-extension-review" title={selected?.enabled?`启用 ${selected.row.name}？`:`关闭 ${selected?.row.name??''} 的访达扩展？`}
      zIndex={1600} onCancel={()=>{if(!busy)setSelected(undefined);}} onOk={()=>void apply()}
      okText={selected?.enabled?'确认启用':'确认关闭'} cancelText="取消" confirmLoading={busy}
      closable={!busy} keyboard={!busy} mask={{closable:!busy}} cancelButtonProps={{disabled:busy}}
      okButtonProps={{danger:!selected?.enabled,disabled:api.preview||loading}}>
      <p>{selected?.enabled?'允许 macOS 后续加载此访达扩展。':'关闭此扩展在访达中的功能，并请求其当前运行实例退出。'}</p>
      <p className="path muted text-xs mt-2">{selected?.row.id}</p>
    </Modal>
  </Drawer>;
}
