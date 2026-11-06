import {useRef,useState,type FormEvent} from 'react';
import {Button,DialogShell,Field,Input} from '@flowhub/plugin-common/react';
import type {ManagementApi} from './api';

export function ResourceCreate({kind,context,api,readOnly,onClose,onBusy,onSaved}:{kind:'volume'|'network';context:string;api:ManagementApi;readOnly:boolean;onClose():void;onBusy(value:boolean):void;onSaved():Promise<void>}) {
  const [name,setName]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),pending=useRef(false),input=useRef<HTMLInputElement>(null),composing=useRef(false);
  const valid=/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/.test(name);
  async function submit(event:FormEvent){event.preventDefault();if(pending.current || readOnly || !valid || composing.current)return;pending.current=true;setBusy(true);onBusy(true);setError('');
    try{await api.invoke(kind+'_create',{context,name,confirmed:true});await onSaved();onClose();}catch(reason){setError(reason instanceof Error?reason.message:'创建失败，请重试');}finally{pending.current=false;setBusy(false);onBusy(false);}
  }
  return <DialogShell className="docker-create-dialog" open title={'新建'+(kind==='volume'?'卷':'网络')} description={kind==='volume'?'创建一个本地命名卷，用于持久保存容器数据。':'创建一个本地 bridge 网络，供容器之间连接。'} initialFocusRef={input} onOpenChange={open=>{if(!open&&!pending.current)onClose();}} onCancel={event=>{if(pending.current)event.preventDefault();}} contentClassName="docker-create-content" footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button type="submit" form="docker-create-resource" variant="primary" disabled={busy || readOnly || !valid}>{busy?'创建中…':'创建'+(kind==='volume'?'卷':'网络')}</Button></>}>
    <form id="docker-create-resource" onSubmit={submit} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=true;window.setTimeout(()=>{composing.current=false;},80);}} onKeyDown={event=>{if(event.key==='Enter'&&(event.repeat || event.nativeEvent.isComposing))event.preventDefault();}}>
      <Field label="名称" htmlFor="docker-new-name"><Input ref={input} id="docker-new-name" value={name} maxLength={128} autoComplete="off" disabled={busy} placeholder={kind==='volume'?'例如 app-data':'例如 app-network'} onChange={event=>setName(event.target.value)} aria-describedby="docker-new-name-help"/></Field>
      <p id="docker-new-name-help" className="docker-muted">2–128 位字母、数字、点、下划线或连字符，以字母或数字开头。环境：{context}</p>
      {error?<p className="docker-error" role="alert">{error}</p>:null}
    </form>
  </DialogShell>;
}
