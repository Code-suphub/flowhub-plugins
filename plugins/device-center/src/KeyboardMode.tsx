import {useEffect,useRef,useState} from 'react';
import {Button,HelpPopover,Input} from '@flowhub/plugin-common/react';
import type {Api} from './api';

type Mode='mac'|'windows';
type Lighting='breathing'|'off';
type Reading = {status:'pending'|'unavailable'|'read';mode?:Mode|'unknown';usbRelease?:string;configurationSupported?:boolean;lighting?:Lighting|null};
type Preset={name:string;mode:Mode;lighting:Lighting|null};
type Diagnostics={configurationBytes:number;powerBytes?:number[];modeByte?:number;lightingByte?:number;configurationDigest:string};
const modeLabels={mac:'Mac',windows:'Windows'};
const lightLabels={breathing:'呼吸灯',off:'关灯'};

export function KeyboardMode({api,id}:{api:Api;id:string}) {
 const [reading,setReading]=useState<Reading>({status:'pending'});
 const [presets,setPresets]=useState<Preset[]|null>(null),[name,setName]=useState('');
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 const [diagnostic,setDiagnostic]=useState<Diagnostics|null>(null);
 const action=useRef(false),generation=useRef(0);
 useEffect(()=>{
  if(api.preview)return;
  let alive=true,busy=false;
  let retry:ReturnType<typeof setTimeout>|undefined;
  async function read(followUp=false) {
   if(busy||action.current||document.hidden)return;
   busy=true;
   const revision=generation.current;
   try{
    const value=await api.request<Reading>('keyboard_mode',{id});
    if(alive&&revision===generation.current){
     setReading(value);
     if(followUp&&value.status==='pending')retry=setTimeout(()=>void read(),400);
    }
   }catch{if(alive&&revision===generation.current)setReading({status:'unavailable'});}
   finally{busy=false;}
  }
  void read(true);
  const timer=setInterval(()=>void read(),3000);
  return ()=>{alive=false;clearInterval(timer);clearTimeout(retry);};
 },[api,id]);

 async function run(operation:()=>Promise<void>){
  if(api.preview||action.current)return;
  action.current=true;generation.current+=1;setBusy(true);setMessage('');setError('');
  try{await operation();}
  catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  finally{action.current=false;setBusy(false);}
 }
 function loadPresets(){
  if(presets!==null)return;
  void run(async()=>setPresets(await api.request<Preset[]>('keyboard_presets',{id})));
 }
 function record(){
  void run(async()=>{
   setPresets(await api.request<Preset[]>('keyboard_record_preset',{id,name:name.trim()}));
   setName('');setMessage('已记录键盘当前设置');
  });
 }
 function apply(selection:{mode:Mode}|{name:string}){
  void run(async()=>{
   const result=await api.request<Reading>('keyboard_apply_preset',{id,...selection,expectedMode:reading.mode,expectedLighting:reading.lighting});
   setReading(result);setMessage('已应用并读回确认');
  });
 }
 function remove(preset:Preset){
  void run(async()=>{
   setPresets(await api.request<Preset[]>('keyboard_delete_preset',{id,name:preset.name}));
   setMessage('已删除预设 '+preset.name);
  });
 }

 const mode=reading.status==='read'&&reading.mode==='mac'?'Mac 模式'
  :reading.status==='read'&&reading.mode==='windows'?'Windows 模式'
  :api.preview?'预览不可读取'
  :reading.status==='pending'?'正在读取…'
  :reading.status==='unavailable'?'无法读取，请检查 USB 连接':'模式未知';
 const known=reading.status==='read'&&(reading.mode==='mac'||reading.mode==='windows');
 const canConfigure=!api.preview&&reading.configurationSupported===true&&known&&!busy;
 return <section className="dc-keyboard-mode" aria-label="珂芝 K75 键位模式">
  <div><h4>K75 键位模式</h4><strong role="status">{mode}</strong></div>
  {known?<small><kbd>Fn + S</kbd> Mac <span aria-hidden="true">·</span> <kbd>Fn + A</kbd> Windows</small>:null}
  {reading.usbRelease?<small>USB 设备版本 <code>{reading.usbRelease}</code></small>:null}
  <div className="dc-keyboard-help"><HelpPopover label="键位模式说明">通过有线 USB 读取键盘当前的键位模式。键盘切换后，读数会在下一次采集时更新。</HelpPopover></div>
  {reading.configurationSupported?<details className="dc-keyboard-presets" onToggle={event=>{if(event.currentTarget.open)loadPresets();}}>
   <summary>有线配置与预设</summary>
   <div className="dc-keyboard-actions" aria-label="切换键位">
    {(['mac','windows'] as const).map(mode=><Button key={mode} className="dc-button" disabled={!canConfigure||reading.mode===mode} onClick={()=>apply({mode})}>切换到 {modeLabels[mode]}</Button>)}
    <span>灯效 · {reading.lighting?lightLabels[reading.lighting]:'未识别'}</span>
   </div>
   <div className="dc-keyboard-actions">
    <Input aria-label="预设名称" value={name} maxLength={36} placeholder="预设名称" disabled={busy}
      onChange={event=>setName(event.target.value)} onKeyDown={event=>{
       if(event.key!=='Enter'||event.nativeEvent.isComposing||!canConfigure||!name.trim())return;
       event.preventDefault();event.stopPropagation();record();
      }}/>
    <Button className="dc-button" disabled={!canConfigure||!name.trim()} onClick={record}>记录当前</Button>
   </div>
   <small>记录当前键位和已识别的灯效，适用于 USB 版本 0x4023。</small>
   {presets?.length?<ul aria-label="已保存预设">{presets.map(preset=><li key={preset.name}>
    <span><strong>{preset.name}</strong><small>{modeLabels[preset.mode]}{preset.lighting?' · '+lightLabels[preset.lighting]:''}</small></span>
    <Button className="dc-button" aria-label={'应用 '+preset.name} disabled={!canConfigure||Boolean(preset.lighting&&!reading.lighting)} onClick={()=>apply({name:preset.name})}>应用</Button>
    <Button variant="ghost" className="dc-button" aria-label={'删除 '+preset.name} disabled={busy} onClick={()=>remove(preset)}>删除</Button>
   </li>)}</ul>:null}
  </details>:null}
  <details className="dc-keyboard-presets">
   <summary>诊断</summary>
   <Button className="dc-button" disabled={api.preview||busy||reading.status!=='read'} onClick={()=>void run(async()=>setDiagnostic(await api.request<Diagnostics>('keyboard_diagnostics',{id})))}>读取 USB 诊断</Button>
   {diagnostic?<dl className="dc-keyboard-diagnostic">
    <dt>配置块</dt><dd>{diagnostic.configurationBytes} 字节</dd>
    {diagnostic.modeByte!==undefined?<><dt>键位字段</dt><dd>{diagnostic.modeByte}</dd></>:null}
    {diagnostic.lightingByte!==undefined?<><dt>灯效字段</dt><dd>{diagnostic.lightingByte}</dd></>:null}
    <dt>电源原始值</dt><dd>{diagnostic.powerBytes?.join(' / ')??'读取失败'}</dd>
    <dt>配置指纹</dt><dd><code>{diagnostic.configurationDigest}</code></dd>
   </dl>:null}
  </details>
  {error?<p className="dc-keyboard-feedback dc-warning" role="alert">{error}</p>:message?<p className="dc-keyboard-feedback" role="status">{message}</p>:null}
 </section>;
}
