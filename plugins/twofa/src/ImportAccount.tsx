import {useEffect,useRef,useState,type FormEvent,type ClipboardEvent} from 'react';
import {Button,DialogShell,Field,HelpPopover,Input} from '@flowhub/plugin-common/react';
import {demoImportUri,type Account,type ImportPreview,type TwofaApi} from './api';
import {readQrImage} from './qr-image';

export function ImportAccount({api,accounts,onClose,onSaved}:{api:TwofaApi;accounts:Account[];onClose():void;onSaved():Promise<void>}) {
  const [uri,setUri]=useState(api.preview?demoImportUri:''),[preview,setPreview]=useState<ImportPreview|null>(null),[name,setName]=useState('');
  const [phase,setPhase]=useState<'parse'|'save'|'image'|'capture'|null>(null),[error,setError]=useState(''),[hint,setHint]=useState('');
  const fileInput=useRef<HTMLInputElement>(null),nameInput=useRef<HTMLInputElement>(null),restoreInput=useRef(false);
  const input=useRef<HTMLInputElement>(null),pending=useRef(false),saving=useRef(false),capturing=useRef(false),alive=useRef(true),request=useRef(0),composing=useRef(false),imeEnded=useRef(-Infinity);
  useEffect(()=>()=>{alive.current=false;request.current++;},[]);
  const duplicate=accounts.some(account=>account.name===name.trim()),busy=phase!==null;
  useEffect(()=>{if(!busy && restoreInput.current){restoreInput.current=false;(preview?nameInput:input).current?.focus();}},[busy,preview]);
  function close(){if(saving.current || capturing.current)return;request.current++;onClose();}
  async function recognize(read:()=>Promise<File|null>,phase:'image'|'capture'){
    if(api.preview || pending.current)return;
    const id=++request.current;pending.current=true;capturing.current=phase==='capture';setPhase(phase);setPreview(null);setName('');setError('');setHint('');
    try {
      const file=await read();if(!alive.current || request.current!==id)return;
      if(!file){setHint('已取消屏幕框选，未保存账户');return;}
      const decoded=await readQrImage(file);if(!alive.current || request.current!==id)return;
      const metadata=await api.previewImport(decoded);
      if(alive.current && request.current===id){setUri(decoded);setPreview(metadata);setName(metadata.name);}
    }catch(reason){if(alive.current && request.current===id)setError(reason instanceof Error?reason.message:'图片识别失败，请重试');}
    finally{pending.current=false;capturing.current=false;if(alive.current && request.current===id){restoreInput.current=true;setPhase(null);}}
  }
  function selectImage(file:File|undefined){if(file)void recognize(async()=>file,'image');}
  function pasteImage(event:ClipboardEvent){
    const items=Array.from(event.clipboardData.items??[]).filter(item=>item.kind==='file' && item.type.startsWith('image/'));
    const files=items.length?items.map(item=>item.getAsFile()).filter((file):file is File=>Boolean(file)):Array.from(event.clipboardData.files??[]).filter(file=>file.type.startsWith('image/'));
    if(!files.length)return;
    event.preventDefault();if(pending.current)return;
    if(api.preview){setError('只读预览不读取剪贴板图片，请在 FlowHub 中粘贴');return;}
    if(files.length!==1){setError('一次只识别一张图片，请单独复制二维码');return;}
    selectImage(files[0]);
  }
  function captureScreen(){
    if(!api.captureScreen)return;
    void recognize(async()=>{
      const result=await api.captureScreen!();if(result.cancelled)return null;
      const image=result.image;
      if(!image || image.length>2_800_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image))throw Error('框选图片无效，请重试或截图后粘贴');
      let bytes:Uint8Array<ArrayBuffer>;try{bytes=Uint8Array.from(atob(image),char=>char.charCodeAt(0));}catch{throw Error('框选图片无效，请重试');}
      return new File([bytes],'screen-qr.png',{type:'image/png'});
    },'capture');
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
    onOpenChange={open=>{if(!open)close();}} onCancel={event=>{if(saving.current || capturing.current || composing.current || performance.now()-imeEnded.current<80)event.preventDefault();}}
    footer={<><Button disabled={phase==='save' || phase==='capture'} onClick={close}>取消</Button>{preview?<Button disabled={busy} onClick={()=>{setPreview(null);setError('');}}>重新解析</Button>:null}<Button variant="primary" type="submit" form="twofa-import-form" disabled={busy || Boolean(preview && (api.preview || duplicate || !name.trim()))}>{phase==='capture'?'框选中…':phase==='image'?'识别中…':phase==='parse'?'解析中…':phase==='save'?'导入中…':preview?'确认导入':'解析链接'}</Button></>}>
    <form id="twofa-import-form" className="grid gap-4" onSubmit={submit} onPasteCapture={pasteImage} onCompositionStartCapture={()=>{composing.current=true;}} onCompositionEndCapture={()=>{composing.current=false;imeEnded.current=performance.now();}} onKeyDownCapture={event=>{if(event.key==='Enter' && event.repeat)event.preventDefault();if(event.nativeEvent.isComposing || event.nativeEvent.keyCode===229){imeEnded.current=performance.now();event.stopPropagation();}}}>
      <Field label={<span className="inline-flex items-center gap-2">验证器链接<HelpPopover label="验证器链接说明">粘贴 otpauth://totp/ 链接，在本机解析。支持 SHA1、SHA256、SHA512，6–8 位和 15–120 秒周期。解析不保存账户。</HelpPopover></span>} htmlFor="twofa-import-uri">
        <Input id="twofa-import-uri" ref={input} type="password" autoComplete="off" spellCheck={false} maxLength={8192} value={uri} disabled={busy} placeholder="otpauth://totp/…" onChange={event=>{setUri(event.target.value);setPreview(null);setName('');setError('');}}/>
      </Field>
      <div className="twofa-image-import"><Button disabled={busy || api.preview} onClick={()=>fileInput.current?.click()}>选择二维码图片</Button><Button disabled={busy || api.preview || !api.captureScreen} onClick={captureScreen}>扫描屏幕二维码</Button><span className="muted text-xs">PNG / JPEG · 最大 8 MiB</span><input ref={fileInput} type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" aria-label="二维码图片" hidden disabled={busy || api.preview} onChange={event=>{const file=event.target.files?.[0];event.target.value='';void selectImage(file);}}/></div>
      <div tabIndex={0} role="group" aria-label="粘贴二维码图片" className="twofa-paste-zone">在此按 ⌘V 粘贴二维码图片，也可粘贴到链接输入框。</div>
      <p className="muted text-xs">图片仅在本机识别，不上传。屏幕扫描需要 macOS 屏幕录制权限；请将二维码放到可见位置，直接拖动框选，Esc 取消。</p>
      {hint?<p className="muted text-xs" role="status">{hint}</p>:null}
      {preview?<><div className="twofa-import-summary"><span className="muted text-xs">已解析 · 尚未保存</span><p className="mt-2 break-words text-sm">{preview.issuer || '未提供发行方'}</p><p className="muted mt-1 text-xs">{preview.algorithm} · {preview.digits} 位 · 每 {preview.period} 秒更新</p></div>
        <Field label="账户名称" htmlFor="twofa-import-name"><Input ref={nameInput} id="twofa-import-name" value={name} maxLength={80} disabled={busy} aria-invalid={duplicate || !name.trim()} onChange={event=>setName(event.target.value)}/></Field>
        {duplicate?<p role="alert" className="error text-sm">该名称已存在，请修改名称；原账户会保留。</p>:null}</>:null}
      {api.preview?<p className="muted text-xs">只读模拟预览：仅支持当前示例链接，不会导入账户。</p>:<p className="muted text-xs">确认后加密保存在本机。同名账户不会被覆盖。</p>}
      {error?<p role="alert" className="error text-sm">{error}</p>:null}
    </form>
  </DialogShell>;
}
