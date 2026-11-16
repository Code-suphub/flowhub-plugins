import {useEffect,useRef,useState,type PointerEvent} from 'react';
import {Button,DialogShell,HelpPopover,Input,Textarea} from '@flowhub/plugin-common/react';
import type {Api} from './api';
import {PhoneRecovery} from './PhoneRecovery';

type Phone={id:string;name:string;canRecover?:boolean;connected?:boolean;route?:string;busy?:boolean;health?:{version?:string;accessibilityConnected?:boolean;batteryExempt?:boolean;vendorFreezeExemption?:string}};
type Frame={id:string;image:string;width:number;height:number;rotation:number;capturedAt:number;route:string};
type Point={x:number;y:number};
export function phonePoint(x:number,y:number,rect:{left:number;top:number;width:number;height:number},width:number,height:number):Point|null {
 if(rect.width<=0||rect.height<=0||x<rect.left||y<rect.top||x>=rect.left+rect.width||y>=rect.top+rect.height)return null;
 return {x:Math.min(width-1,Math.floor((x-rect.left)*width/rect.width)),y:Math.min(height-1,Math.floor((y-rect.top)*height/rect.height))};
}

function Viewer({api,phone,onClose}:{api:Api;phone:Phone;onClose:()=>void}) {
 const [frame,setFrame]=useState<Frame|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[text,setText]=useState('');
 const [connecting,setConnecting]=useState(true),[ready,setReady]=useState(false),[actionError,setActionError]=useState('');
 const alive=useRef(true),acting=useRef(false),framePending=useRef<Promise<void>|null>(null),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const operation=useRef<Promise<unknown>|null>(null);
 const latest=useRef<Frame|null>(null),down=useRef<{point:Point;frame:Frame;at:number}|null>(null);
 useEffect(()=>{
  alive.current=true;
  async function poll() {
   if(!alive.current)return;
   if(document.hidden||acting.current){timer.current=setTimeout(()=>void poll(),500);return;}
   const request=(async()=>{
    try{const next=await api.request<Frame>('phone_frame',{id:phone.id});if(alive.current){latest.current=next;setFrame(next);setReady(true);setError('');}}
    catch(e){if(alive.current){latest.current=null;setFrame(null);setReady(false);setError(e instanceof Error?e.message:'画面暂不可用');}}
   })();framePending.current=request;await request;framePending.current=null;
   if(alive.current)timer.current=setTimeout(()=>void poll(),latest.current?400:2500);
  }
  const connected=api.request<Phone>('phone_connect',{id:phone.id}).then(()=>{if(alive.current){setConnecting(false);void poll();}}).catch(e=>{if(alive.current){setConnecting(false);setError(e instanceof Error?e.message:'无法连接手机');}});
  return ()=>{alive.current=false;clearTimeout(timer.current);latest.current=null;void (async()=>{await connected;await framePending.current;try{await operation.current;}catch{}await api.request('phone_disconnect',{id:phone.id});})().catch(()=>{});};
 },[api,phone.id]);
 async function action(body:Record<string,unknown>,observed=latest.current) {
  const navigation=['back','home','recents'].includes(String(body.type));
  if(acting.current||(!navigation&&(!observed||!ready)))return;
  acting.current=true;setBusy(true);setReady(false);setActionError('');
  try {
   await framePending.current;
   const request=api.request<{ok:boolean}>('phone_action',{id:phone.id,action:{...body,frameId:observed?.id||''}});operation.current=request;
   const result=await request;
   if(!result.ok)throw Error('手机未完成操作，请查看刷新后的画面');
   if(body.type==='text')setText('');
  }catch(e){if(alive.current)setActionError(e instanceof Error?e.message:'未确认操作结果；没有自动重试');}
  finally{operation.current=null;acting.current=false;if(alive.current)setBusy(false);}
 }
 async function wake(){
  if(acting.current)return;acting.current=true;setBusy(true);setActionError('');
  try{await framePending.current;const request=api.request('phone_wake',{id:phone.id});operation.current=request;await request;}
  catch(e){if(alive.current)setActionError(e instanceof Error?e.message:'无法点亮手机');}
  finally{operation.current=null;acting.current=false;if(alive.current)setBusy(false);}
 }
 function point(event:PointerEvent<HTMLImageElement>,f:Frame){return phonePoint(event.clientX,event.clientY,event.currentTarget.getBoundingClientRect(),f.width,f.height);}
 function start(event:PointerEvent<HTMLImageElement>){const f=latest.current;if(!f||!ready||acting.current||event.button!==0)return;const p=point(event,f);if(p){event.currentTarget.setPointerCapture(event.pointerId);down.current={point:p,frame:f,at:Date.now()};}}
 function finish(event:PointerEvent<HTMLImageElement>){const d=down.current;down.current=null;if(!d||!ready)return;const p=point(event,d.frame);if(!p)return;const distance=Math.hypot(p.x-d.point.x,p.y-d.point.y);void action(distance<Math.max(d.frame.width,d.frame.height)*.012?{type:'tap',...p}:{type:'swipe',x1:d.point.x,y1:d.point.y,x2:p.x,y2:p.y,duration:Math.min(1000,Math.max(150,Date.now()-d.at))},d.frame);}
 return <DialogShell open onOpenChange={value=>{if(!value)onClose();}} title={phone.name+' · Phone Bridge'} className="dc-phone-dialog" contentClassName="dc-phone-content" footer={<><span className="dc-detail-note" role="status">{connecting?'正在选择线路…':frame?.route||'等待画面'}</span><Button className="dc-button" disabled={busy||connecting} onClick={()=>void wake()}>点亮屏幕</Button><Button className="dc-button" onClick={onClose}>断开</Button></>}>
  <div className="flex flex-wrap items-center gap-2 pb-2">
   {(['back','home','recents'] as const).map((type,i)=><Button key={type} className="dc-button" disabled={connecting||busy} onClick={()=>void action({type})}>{['返回','主页','最近应用'][i]}</Button>)}
   <HelpPopover label="Phone Bridge 控制说明">点击画面或按住拖动操作手机。连续截图通常每秒 1–2 帧，适合日常操作；需要流畅视频可使用 ADB 投屏。画面过期、手机旋转或锁定时拒绝操作。受保护页面由 Android 禁止截图。关闭窗口即停止采集，不保存画面。</HelpPopover>
  </div>
  {error||actionError?<p className="dc-warning" role="alert">{error||actionError}</p>:null}
  <div className="dc-phone-screen">{frame?<img src={'data:image/jpeg;base64,'+frame.image} alt={phone.name+'实时画面'} draggable={false} onPointerDown={start} onPointerUp={finish} onPointerCancel={()=>{down.current=null;}} style={{touchAction:'none',cursor:ready&&!busy?'crosshair':'wait'}}/>:<p role="status">{connecting?'正在连接手机…':'等待可用画面'}</p>}</div>
  <form className="flex gap-2 pt-2" onSubmit={event=>{event.preventDefault();void action({type:'text',text});}}><Input className="min-w-0 flex-1" aria-label="远程输入文字" placeholder="选择手机输入框后填入文字" value={text} maxLength={1024} onChange={event=>setText(event.target.value)}/><Button type="submit" className="dc-button" disabled={!ready||busy||!text}>填入</Button></form>
 </DialogShell>;
}

export function PhoneBridge({api,query=''}:{api:Api;query?:string}) {
 const [phones,setPhones]=useState<Phone[]>([]),[pairing,setPairing]=useState(false),[config,setConfig]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[selected,setSelected]=useState<Phone|null>(null);
 async function load(){if(api.preview)return;try{const result=await api.request<{phones:Phone[]}>('phone_list');setPhones(result.phones);setError('');}catch(e){setError(e instanceof Error?e.message:'无法读取配对手机');}}
 useEffect(()=>{let alive=true;const unsubscribe=api.onReady(()=>{if(alive)void load();});const timer=setInterval(()=>{if(!document.hidden&&!selected)void load();},10000);return()=>{alive=false;clearInterval(timer);unsubscribe();};},[api,selected?.id]);
 async function pair(){if(busy||api.preview)return;setBusy(true);setError('');try{await api.request('phone_pair',{config});setConfig('');setPairing(false);await load();}catch(e){setError(e instanceof Error?e.message:'配对失败');}finally{setBusy(false);}}
 async function remove(p:Phone){if(busy||api.preview)return;setBusy(true);try{await api.request('phone_remove',{id:p.id});await load();}catch(e){setError(e instanceof Error?e.message:'无法取消配对');}finally{setBusy(false);}}
 const visible=phones.filter(p=>p.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
 return <section className="dc-group" aria-label="Phone Bridge 手机">
  <div className="dc-group-heading"><h2>Phone Bridge <small>({phones.length})</small></h2><div className="flex items-center gap-2"><HelpPopover label="无需调试连接手机">手机安装 Phone Bridge 并开启无障碍、连接服务后，复制配对配置到这里。按配置顺序检查 EasyTier、Tailscale 或局域网直连，失败后使用 HTTPS 中转。无需打开 USB 或无线调试。停止手机连接可以撤销访问。</HelpPopover><Button className="dc-button" disabled={api.preview} onClick={()=>{setError('');setPairing(true);}}>添加手机</Button></div></div>
  {error&&!pairing?<p className="dc-warning" role="alert">{error}</p>:null}
  {visible.map(p=><div className="dc-phone-row" key={p.id}>
   <div><strong>{p.name}</strong><p className="dc-detail-note">{p.busy?'正在连接…':p.connected?p.route:'已配对'}{p.health?.version?' · '+p.health.version:''}</p>
    {p.health?.accessibilityConnected===false?<p className="dc-warning">请在手机开启无障碍</p>:null}
    {p.health?.batteryExempt===false?<p className="dc-detail-note">手机尚未允许后台运行</p>:null}
    {['missing','unknown'].includes(p.health?.vendorFreezeExemption||'')?<p className="dc-warning">{p.health?.vendorFreezeExemption==='missing'?'小米免冻结尚未生效，请在手机允许后台运行':'尚无法确认小米免冻结状态'}</p>:null}
   </div>
   <div className="flex flex-wrap items-start gap-2"><Button className="dc-button" disabled={busy||api.preview} onClick={()=>setSelected(p)}>连接与操控</Button><PhoneRecovery api={api} id={p.id} available={p.canRecover===true} disabled={busy} onBusy={setBusy}/><Button variant="ghost" className="dc-button" disabled={busy||api.preview} onClick={()=>void remove(p)}>取消配对</Button></div>
  </div>)}
  {!phones.length?<p className="dc-detail-note">添加手机后，无需开启无线调试即可连接。</p>:null}
  {pairing?<DialogShell open onOpenChange={value=>{setPairing(value);if(!value)setConfig('');}} title="添加 Phone Bridge 手机" className="dc-dialog" footer={<Button className="dc-button" disabled={busy||!config.trim()} onClick={()=>void pair()}>{busy?'保存中…':'保存配对'}</Button>}><p className="dc-detail-note">在手机 Phone Bridge 中点击“复制 Flowhub 配对配置”，粘贴到下方。中转配置由自己的服务器提供。</p><Textarea aria-label="手机配对配置" value={config} onChange={event=>setConfig(event.target.value)} rows={8} spellCheck={false} autoComplete="off" maxLength={32768}/>{error?<p className="dc-warning" role="alert">{error}</p>:null}</DialogShell>:null}
  {selected?<Viewer key={selected.id} api={api} phone={selected} onClose={()=>{setSelected(null);void load();}}/>:null}
 </section>;
}
