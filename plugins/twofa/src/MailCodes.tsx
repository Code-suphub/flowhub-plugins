import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Button,DialogShell,EmptyState,Field,HelpPopover,Input,Select} from '@flowhub/plugin-common/react';
import type {MailAccount,MailProvider,MailStatus,TwofaApi} from './api';

const providers=[{value:'netease',label:'163 邮箱'},{value:'qq',label:'QQ 邮箱'}] satisfies Array<{value:MailProvider;label:string}>;
const providerSuffix:Record<MailProvider,string>={netease:'@163.com',qq:'@qq.com'};
const statusLabels:Record<MailAccount['status'],string>={
  connecting:'连接中',live:'实时接收',polling:'定时检查',offline:'连接中断，正在重试',authorization:'需要更新授权码',
};
const message=(error:unknown)=>error instanceof Error?error.message:'操作失败，请重试';

function MailEditor({api,account,onClose,onSaved}:{api:TwofaApi;account?:MailAccount;onClose():void;onSaved():void}) {
  const [provider,setProvider]=useState<MailProvider>(account?.provider??'netease');
  const [address,setAddress]=useState(account?.address??'');
  const [authorizationCode,setAuthorizationCode]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const input=useRef<HTMLInputElement>(null);
  const suffix=providerSuffix[provider];
  const showSuffix=!address.includes('@');
  function changeProvider(value:string) {
    const current=address.trim();
    if(current.toLowerCase().endsWith(suffix))setAddress(current.slice(0,-suffix.length));
    setProvider(value==='qq'?'qq':'netease');
  }
  async function save(event:FormEvent) {
    event.preventDefault();
    if(busy)return;
    const entered=address.trim();
    if(!entered){setError('请输入邮箱用户名');input.current?.focus();return;}
    const fullAddress=entered.includes('@')?entered:entered+suffix;
    if(!fullAddress.toLowerCase().endsWith(suffix)){
      setError(`当前选择的邮箱需要使用 ${suffix} 地址`);
      input.current?.focus();
      return;
    }
    setBusy(true);setError('');
    try{
      await api.addMail({provider,address:fullAddress,authorizationCode});
      setAuthorizationCode('');onSaved();
    }catch(error){setError(message(error));}
    finally{setBusy(false);}
  }
  return <DialogShell open onOpenChange={open=>{if(!open&&!busy)onClose();}}
    onCancel={event=>{if(busy)event.preventDefault();}} title={account?'更新邮箱授权':'连接邮箱'}
    initialFocusRef={input} className="twofa-dialog" contentClassName="twofa-dialog-content"
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" type="submit" form="mail-form" disabled={busy}>{busy?'保存中…':'连接'}</Button></>}>
    <form id="mail-form" onSubmit={save} className="grid gap-4">
      <Field label="邮箱服务" htmlFor="mail-provider"><Select id="mail-provider" options={providers}
        value={provider} onChange={changeProvider} disabled={busy||!!account}/></Field>
      <Field label="邮箱地址" htmlFor="mail-address">
        <div className="mail-address-field">
          <Input id="mail-address" ref={account?undefined:input} type="text" inputMode="email" autoComplete="username"
            spellCheck={false} required maxLength={254} value={address} onChange={event=>setAddress(event.target.value)}
            disabled={busy||!!account} placeholder="输入邮箱用户名"
            className={showSuffix?'mail-address-with-suffix':undefined} aria-describedby={showSuffix?'mail-address-suffix':undefined}/>
          {showSuffix?<span id="mail-address-suffix" className="mail-address-suffix">{suffix}</span>:null}
        </div>
      </Field>
      <Field label={<span className="inline-flex items-center gap-2">客户端授权码<HelpPopover label="授权码说明">先在邮箱设置中开启 IMAP，再生成客户端授权码。授权码保存在本机钥匙串。</HelpPopover></span>} htmlFor="mail-secret">
        <Input id="mail-secret" ref={account?input:undefined} type="password" autoComplete="new-password" spellCheck={false} required maxLength={128}
          value={authorizationCode} onChange={event=>setAuthorizationCode(event.target.value)} disabled={busy}/>
      </Field>
      {error?<p className="error text-sm" role="alert">{error}</p>:null}
    </form>
  </DialogShell>;
}

export function MailCodes({api}:{api:TwofaApi}) {
  const [data,setData]=useState<MailStatus>();
  const [editor,setEditor]=useState<{account?:MailAccount}>();
  const [remove,setRemove]=useState<MailAccount>();
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
  const [loadError,setLoadError]=useState('');
  const [revision,refresh]=useState(0);
  useEffect(()=>{
    let alive=true,reading=false;
    async function tick(){
      if(document.hidden||reading)return;
      reading=true;
      try{const next=await api.mailStatus();if(alive){setData(next);setLoadError('');}}
      catch(error){if(alive)setLoadError(message(error));}
      finally{reading=false;}
    }
    void tick();
    const timer=setInterval(()=>void tick(),2000);
    document.addEventListener('visibilitychange',tick);
    return()=>{alive=false;clearInterval(timer);document.removeEventListener('visibilitychange',tick);};
  },[api,revision]);

  async function copy(id:string) {
    setError('');setNotice('');
    try{await api.copyMail(id);setNotice('验证码已复制');}
    catch(error){setError(message(error));refresh(value=>value+1);}
  }
  async function disconnect() {
    if(!remove||busy)return;
    setBusy(true);setError('');
    try{await api.removeMail(remove);setRemove(undefined);refresh(value=>value+1);}
    catch(error){setError(message(error));}
    finally{setBusy(false);}
  }

  return <>
    <div className="twofa-toolbar">
      <span className="muted text-xs">{data?.accounts.length??0} 个邮箱</span>
      <HelpPopover label="邮件验证码说明">后台检查已连接的收件箱。近期验证码可在 FlowHub 启动器的验证码分类中按回车复制。</HelpPopover>
      <div className="twofa-toolbar-actions"><Button variant="primary" disabled={api.preview} onClick={()=>setEditor({})}>＋ 连接邮箱</Button></div>
    </div>
    {api.preview?<p className="twofa-preview" role="status">只读预览 · 请在 FlowHub 中连接邮箱</p>:null}
    {error?<p className="error mb-3 text-sm" role="alert">{error}</p>:null}
    {notice?<p className="muted mb-3 text-sm" role="status">{notice}</p>:null}
    {loadError?<p className="error mb-3 text-sm" role="alert">{loadError}</p>:!data?<p className="muted text-sm">正在读取邮箱连接…</p>:null}
    {data?.accounts.length?<ul className="mail-list" aria-label="已连接邮箱">
      {data.accounts.map(account=><li className="mail-row" key={account.address}>
        <div className="mail-label"><strong>{account.address}</strong><span className="muted">{statusLabels[account.status]}</span></div>
        <div className="flex flex-wrap gap-1"><Button size="sm" onClick={()=>setEditor({account})}>更新授权</Button><Button size="sm" onClick={()=>setRemove(account)}>断开</Button></div>
      </li>)}
    </ul>:null}
    {data?.codes.length?<ul className="mail-list mt-4" aria-label="最近收到的验证码">
      {data.codes.map(code=><li className="mail-row" key={code.id}>
        <div className="mail-label"><strong>{code.title}</strong><span className="muted">{code.issuer} · {new Date(code.receivedAt).toLocaleTimeString()}</span></div>
        <Button size="sm" aria-label={`复制 ${code.title} 的验证码`} onClick={()=>void copy(code.id)}>复制验证码</Button>
      </li>)}
    </ul>:data?<EmptyState size="compact" className="twofa-empty" title={data.accounts.length?'暂无近期验证码':'连接邮箱后接收验证码'}/>:null}
    {editor?<MailEditor api={api} account={editor.account} onClose={()=>setEditor(undefined)} onSaved={()=>{setEditor(undefined);refresh(value=>value+1);}}/>:null}
    <DialogShell open={!!remove} onOpenChange={open=>{if(!open&&!busy)setRemove(undefined);}} title="断开邮箱"
      className="twofa-dialog" footer={<><Button disabled={busy} onClick={()=>setRemove(undefined)}>取消</Button><Button disabled={busy} variant="danger" onClick={()=>void disconnect()}>{busy?'断开中…':'断开邮箱'}</Button></>}>
      <p className="break-words text-sm">停止接收「{remove?.address}」的验证码，并删除本机保存的授权码。</p>
    </DialogShell>
  </>;
}
