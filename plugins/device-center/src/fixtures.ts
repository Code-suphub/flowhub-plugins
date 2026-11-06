import type {Snapshot} from './model';
export function demo(scenario=''):Snapshot {
 const at=Date.now();
 const data:Snapshot={at,stale:false,error:null,devices:[
 {id:'airpods',name:'AirPods Pro 2',category:'bluetooth',kind:'headphones',detail:'音频设备',status:'connected',battery:'82%'},
 {id:'mouse',name:'Magic Mouse',category:'bluetooth',kind:'mouse',detail:'鼠标',status:'connected',battery:'67%'},
 {id:'keyboard',name:'Keychron K3',category:'bluetooth',kind:'keyboard',detail:'键盘',status:'connected',battery:'100%'},
 {id:'pixel',name:'Pixel 9 Pro',category:'usb',kind:'phone',detail:'USB-C',status:'connected'},
 {id:'iphone',name:'iPhone 15',category:'usb',kind:'phone',detail:'USB',status:'connected'},
 {id:'ssd',name:'Samsung T7 SSD',category:'usb',kind:'drive',detail:'USB 3.2 Gen 2 · 10 Gbps',status:'connected'},
 {id:'reader',name:'SD Card Reader',category:'usb',kind:'hub',detail:'USB',status:'connected'},
 {id:'dell',name:'DELL U2723QE',category:'display',kind:'monitor',detail:'显示器',status:'connected',pixelResolution:'3840 × 2160',refreshRate:'60 Hz',displayConnection:'external'},
 {id:'lg',name:'LG UltraFine',category:'display',kind:'monitor',detail:'显示器',status:'connected',pixelResolution:'2560 × 1440',refreshRate:'60 Hz',displayConnection:'external'}
 ],power:{externalConnected:true,charging:true,batteryPresent:true,source:'外接电源',inputWatts:56.8,systemWatts:25.4,batterySideWatts:31.4,adapterWatts:'96',sampledAt:at},
 events:[{at:at-360000,name:'Pixel 9 Pro 已连接',category:'usb',action:'connected'},{at:at-720000,name:'DELL U2723QE 已连接',category:'display',action:'connected'},{at:at-1020000,name:'AirPods Pro 2 已连接',category:'bluetooth',action:'connected'}]};
 if(scenario==='empty')data.devices=[];
 if(scenario==='missing'){data.devices[0].battery=null;data.devices[1].battery='0%';data.power={externalConnected:true,batteryPresent:false,source:'外接电源',sampledAt:at};}
 if(scenario==='stale'||scenario==='error'){data.at=at-180000;data.stale=true;if(scenario==='error')data.error='设备扫描超时，请重试';}
 if(scenario==='unplugged')data.power={...data.power,externalConnected:false,source:'电池供电',charging:false,inputWatts:null,batterySideWatts:-15.2};
 if(scenario==='long')data.devices[0].name='一台名称很长的蓝牙设备 / A deliberately long accessory name that must truncate';
 return data;
}
