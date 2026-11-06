import {useState} from 'react';
import {mdiBluetooth,mdiUsb,mdiMonitor,mdiLaptop,mdiCellphone,mdiHeadphones,mdiKeyboard,mdiMouse,mdiHarddisk,mdiUsbFlashDrive,mdiDevices,mdiMagnify,mdiRefresh,mdiPowerPlug,mdiBatteryCharging,mdiClockOutline,mdiInformationOutline,mdiContentCopy,mdiOpenInNew} from '@mdi/js';
import {family,type Artwork,type Device} from './model';
const paths:Record<string,string>={bluetooth:mdiBluetooth,usb:mdiUsb,display:mdiMonitor,monitor:mdiMonitor,laptop:mdiLaptop,phone:mdiCellphone,headphones:mdiHeadphones,keyboard:mdiKeyboard,mouse:mdiMouse,drive:mdiHarddisk,hub:mdiUsbFlashDrive,device:mdiDevices,search:mdiMagnify,refresh:mdiRefresh,power:mdiPowerPlug,battery:mdiBatteryCharging,events:mdiClockOutline,info:mdiInformationOutline,copy:mdiContentCopy,external:mdiOpenInNew};
export function Icon({name,className=''}:{name:string;className?:string}){return <svg className={'dc-icon '+className} viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]||paths.device}/></svg>;}
export function DeviceArt({device,artwork}:{device:Device;artwork:Artwork}) {
 const [failed,setFailed]=useState('');
 const key=family(device),item=key?artwork.icons[key]:undefined;
 const url=item?.dataUrl;
 const valid=url&&url.length<90_030&&/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/=]*$/.test(url);
 return <span className={'dc-device-art '+(valid&&failed!==url?'has-art':'')}>
  {valid&&failed!==url?<img src={url} alt="macOS 设备家族示意图" title="系统设备图标，可能与实际颜色或壁纸不同" onError={()=>setFailed(url)}/>:<Icon name={device.kind}/>}
 </span>;
}
