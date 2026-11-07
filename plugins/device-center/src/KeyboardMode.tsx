import {useEffect,useState} from 'react';
import {HelpPopover} from '@flowhub/plugin-common/react';
import type {Api} from './api';

type Reading = {status:'pending'|'unavailable'|'read';mode?:'mac'|'windows'|'unknown';usbRelease?:string};

export function KeyboardMode({api,id}:{api:Api;id:string}) {
 const [reading,setReading]=useState<Reading>({status:'pending'});
 useEffect(()=>{
  if(api.preview)return;
  let alive=true,busy=false;
  let retry:ReturnType<typeof setTimeout>|undefined;
  async function read(followUp=false) {
   if(busy||document.hidden)return;
   busy=true;
   try{
    const value=await api.request<Reading>('keyboard_mode',{id});
    if(alive){
     setReading(value);
     if(followUp&&value.status==='pending')retry=setTimeout(()=>void read(),400);
    }
   }catch{if(alive)setReading({status:'unavailable'});}
   finally{busy=false;}
  }
  void read(true);
  const timer=setInterval(()=>void read(),3000);
  return ()=>{alive=false;clearInterval(timer);clearTimeout(retry);};
 },[api,id]);

 const mode=reading.status==='read'&&reading.mode==='mac'?'Mac 模式'
  :reading.status==='read'&&reading.mode==='windows'?'Windows 模式'
  :api.preview?'预览不可读取'
  :reading.status==='pending'?'正在读取…'
  :reading.status==='unavailable'?'无法读取，请检查 USB 连接':'模式未知';
 const known=reading.status==='read'&&(reading.mode==='mac'||reading.mode==='windows');
 return <section className="dc-keyboard-mode" aria-label="珂芝 K75 键位模式">
  <div><h4>K75 键位模式</h4><strong role="status">{mode}</strong></div>
  {known?<small><kbd>Fn + S</kbd> Mac <span aria-hidden="true">·</span> <kbd>Fn + A</kbd> Windows</small>:null}
  {reading.usbRelease?<small>USB 设备版本 <code>{reading.usbRelease}</code></small>:null}
  <HelpPopover label="键位模式说明">通过有线 USB 读取键盘当前的键位模式。键盘切换后，读数会在下一次采集时更新。</HelpPopover>
 </section>;
}
