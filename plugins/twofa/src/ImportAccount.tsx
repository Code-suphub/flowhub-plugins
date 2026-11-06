import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Button,DialogShell,Field,HelpPopover,Input} from '@flowhub/plugin-common/react';
import {demoImportUri,type Account,type ImportPreview,type TwofaApi} from './api';
import {readQrImage} from './qr-image';

export function ImportAccount({api,accounts,onClose,onSaved}:{api:TwofaApi;accounts:Account[];onClose():void;onSaved():Promise<void>}) {
  const [uri,setUri]=useState(api.preview?demoImportUri:''),[preview,setPreview]=useState<ImportPreview|null>(null),[name,setName]=useState('');
  const [phase,setPhase]=useState<'parse'|'save'|'image'|null>(null),[error,setError]=useState('');
  const fileInput=useRef<HTMLInputElement>(null);
  const input=useRef<HTMLInputElement>(null),pending=useRef(false),saving=useRef(false),alive=useRef(true),request=useRef(0),composing=useRef(false),imeEnded=useRef(-Infinity);
  useEffect(()=>()=>{alive.current=false;request.current++;},[]);
  const duplicate=accounts.some(account=>account.name===name.trim()),busy=phase!==null;
  function close(){if(saving.current)return;request.current++;onClose();}
  async function selectImage(file:File|undefined){
    if(!file || api.preview || pending.current)return;
    const id=++request.current;pending.current=true;setPhase('image');setPreview(null);setName('');setError('');
    try {
      const decoded=await readQrImage(file);if(!alive.current || request.current!==id)return;
      const metadata=await api.previewImport(decoded);
      if(alive.current && request.current===id){setUri(decoded);setPreview(metadata);setName(metadata.name);}
    }catch(reason){if(alive.current && request.current===id)setError(reason instanceof Error?reason.message:'图片识别失败，请重试');}
    finally{pending.current=false;if(alive.current && request.current===id)setPhase(null);}
  }
  async function submit(event:FormEvent){
    event.preventDefault();if(pending.current || composing.current || performance.now()-imeEnded.current<80)return;
    if(!uri.trim()){setError('请粘贴 otpauth://totp/ 开头的验证器链接');return;}
    if(preview && (api.preview || !name.trim() || duplicate))return;
    const id=++request.current;pending.current=true;saving.current=Boolean(preview);setPhase(preview?'save':'parse');setError('');
    try {
      if(!preview){const result=await api.previewImport(uri.trim());if(alive.current && request.current===id){setPreview(result);setName(result.name);}}
      else {await api.importAccount(uri.trim(),name.trim());if(alive.current && request.current===id){setUri('');await onSaved();onClose();}}
    } catch(error){if(alive.current && request.current===id)setError(error instanceof Error?error.message:'导入失败，请重试');}
    finally{pending.current=false;saving.current=false;if(alive.current && request.current===id)setPhase(null);}
  }
  return <DialogShell open title="导入验证器账户" className="twofa-import-dialog" contentClassName="twofa-dialog-content" initialFocusRef={input}
    onOpenChange={open=>{if(!open)close();}} onCancel={event=>{if(saving.current || composing.current || performance.now()-imeEnded.current<80)event.preventDefault();}}
    footer={<><Button disabled={phase==='save'} onClick={close}>取消</Button>{preview?<Button disabled={busy} onClick={()=>{setPreview(null);setError('');}}>重新解析</Button>:null}<Button variant="primary" type="submit" form="twofa-import-form" disabled={busy || Boolean(preview && (api.preview || duplicate || !name.trim()))}>{phase==='image'?'识别中…':phase==='parse'?'解析中…':phase==='save'?'导入中…':preview?'确认导入':'解析链接'}</Button></>}>
    <form id="twofa-import-form" className="grid gap-4" onSubmit={submit} onCompositionStartCapture={()=>{composing.current=true;}} onCompositionEndCapture={()=>{composing.current=false;imeEnded.current=performance.now();}} onKeyDownCapture={event=>{if(event.key==='Enter' && event.repeat)event.preventDefault();if(event.nativeEvent.isComposing || event.nativeEvent.keyCode===229){imeEnded.current=performance.now();event.stopPropagation();}}}>
      <Field label={<span className="inline-flex items-center gap-2">验证器链接<HelpPopover label="验证器链接说明">粘贴 otpauth://totp/ 链接，在本机解析。支持 SHA1、SHA256、SHA512，6–8 位和 15–120 秒周期。解析不保存账户。</HelpPopover></span>} htmlFor="twofa-import-uri">
        <Input id="twofa-import-uri" ref={input} type="password" autoComplete="off" spellCheck={false} maxLength={8192} value={uri} disabled={busy} placeholder="otpauth://totp/…" onChange={event=>{setUri(event.target.value);setPreview(null);setName('');setError('');}}/>
      </Field>
      <div className="twofa-image-import"><Button disabled={busy || api.preview} onClick={()=>fileInput.current?.click()}>选择二维码图片</Button><span className="muted text-xs">PNG / JPEG · 最大 8 MiB</span><input ref={fileInput} type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" aria-label="二维码图片" hidden disabled={busy || api.preview} onChange={event=>{const file=event.target.files?.[0];event.target.value='';void selectImage(file);}}/></div>
      <p className="muted text-xs">图片仅在本机识别，不上传；请先裁剪为单个二维码。识别后仍需核对并确认导入。</p>
      {preview?<><div className="twofa-import-summary"><span className="muted text-xs">已解析 · 尚未保存</span><p className="mt-2 break-words text-sm">{preview.issuer || '未提供发行方'}</p><p className="muted mt-1 text-xs">{preview.algorithm} · {preview.digits} 位 · 每 {preview.period} 秒更新</p></div>
        <Field label="账户名称" htmlFor="twofa-import-name"><Input id="twofa-import-name" value={name} maxLength={80} disabled={busy} aria-invalid={duplicate || !name.trim()} onChange={event=>setName(event.target.value)}/></Field>
        {duplicate?<p role="alert" className="error text-sm">该名称已存在，请修改名称；原账户会保留。</p>:null}</>:null}
      {api.preview?<p className="muted text-xs">只读模拟预览：仅支持当前示例链接，不会导入账户。</p>:<p className="muted text-xs">确认后加密保存在本机。同名账户不会被覆盖。</p>}
      {error?<p role="alert" className="error text-sm">{error}</p>:null}
    </form>
  </DialogShell>;
}
