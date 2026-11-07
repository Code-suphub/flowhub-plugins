import {useState} from 'react';
import {mdiBluetooth,mdiUsb,mdiMonitor,mdiLaptop,mdiCellphone,mdiHeadphones,mdiKeyboard,mdiMouse,mdiHarddisk,mdiUsbFlashDrive,mdiDevices,mdiMagnify,mdiRefresh,mdiPowerPlug,mdiBatteryCharging,mdiClockOutline,mdiInformationOutline,mdiContentCopy,mdiOpenInNew} from '@mdi/js';
import {resolveDeviceArt,type Artwork,type Device} from './model';
const paths:Record<string,string>={adb:mdiCellphone,bluetooth:mdiBluetooth,usb:mdiUsb,display:mdiMonitor,monitor:mdiMonitor,laptop:mdiLaptop,phone:mdiCellphone,headphones:mdiHeadphones,keyboard:mdiKeyboard,mouse:mdiMouse,drive:mdiHarddisk,hub:mdiUsbFlashDrive,device:mdiDevices,search:mdiMagnify,refresh:mdiRefresh,power:mdiPowerPlug,battery:mdiBatteryCharging,events:mdiClockOutline,info:mdiInformationOutline,copy:mdiContentCopy,external:mdiOpenInNew};
export function Icon({name,className=''}:{name:string;className?:string}){return <svg className={'dc-icon '+className} viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]||paths.device}/></svg>;}
export function DeviceArt({device,artwork}:{device:Device;artwork:Artwork}) {
 const [failed,setFailed]=useState('');
 const art=resolveDeviceArt(device,artwork);
 const src=failed===art.src?art.fallback:art.src;
 const system=art.system&&src===art.src;
 return <span className={'dc-device-art '+(failed!==art.fallback?'has-art':'')}>
  {failed===art.fallback?<Icon name={device.kind}/>:<img src={src} alt={system?'macOS 设备家族示意图':'设备类别示意图'} onError={()=>setFailed(src)}/>}
 </span>;
}
