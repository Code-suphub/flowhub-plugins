import type {Snapshot} from './model';
export function demo(scenario=''):Snapshot {
 const at=Date.now();
 const data:Snapshot={at,stale:false,error:null,adb:{available:false,at,checkedAt:at,stale:false,intervalSeconds:10},devices:[
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
 events:[{at:at-360000,deviceId:'pixel',name:'Pixel 9 Pro',category:'usb',action:'connected'},{at:at-720000,deviceId:'dell',name:'DELL U2723QE',category:'display',action:'connected'},{at:at-1020000,deviceId:'airpods',name:'AirPods Pro 2',category:'bluetooth',action:'connected'}]};
 if(scenario.startsWith('adb')) {
  data.adb={available:true,at,checkedAt:at,stale:false,intervalSeconds:10};
  data.devices.push(...[
   {id:'adb-usb',name:'Pixel 8 Pro',category:'adb' as const,kind:'phone',detail:'PUBLIC-USB',status:'connected',battery:'26%',adb:{serial:'PUBLIC-USB',state:'device',transport:'usb',model:'Pixel 8 Pro',product:'husky',transportId:'1'}},
   {id:'adb-auth',name:'PUBLIC-AUTH',category:'adb' as const,kind:'phone',detail:'PUBLIC-AUTH',status:'unauthorized',adb:{serial:'PUBLIC-AUTH',state:'unauthorized',transport:'usb'}},
   {id:'adb-offline',name:'192.0.2.1:5555',category:'adb' as const,kind:'phone',detail:'192.0.2.1:5555',status:'offline',adb:{serial:'192.0.2.1:5555',state:'offline',transport:'tcp'}}
  ]);
  if(scenario==='adb-empty'||scenario==='adb-missing')data.devices=data.devices.filter(d=>d.category!=='adb');
  if(scenario==='adb-missing'){data.adb.available=false;data.adb.at=0;data.adb.stale=true;data.adb.error='未找到 ADB，请安装 Android SDK Platform-Tools 后重试。';}
  if(scenario==='adb-error'){data.adb.stale=true;data.adb.error='ADB 读取超时，请检查本机 ADB 服务后重试。';}
  if(scenario==='adb-toolkit'){
   data.devices=data.devices.filter(device=>device.category!=='adb'||device.id==='adb-usb');
   const phone=data.devices.find(device=>device.id==='adb-usb')!;
   Object.assign(phone.adb!,{
    sharedAlias:'测试手机',
    connections:[
     {serial:'127.0.0.1:17352',transport:'tcp',source:'easytier',state:'device',role:'primary'},
     {serial:'100.64.0.2:5555',transport:'tcp',source:'tailscale',state:'offline',role:'fallback'},
     {serial:'PUBLIC-USB',transport:'usb',state:'device'}
    ],
    legacyIds:['adb-old-direct','adb-old-usb']
   });
   data.adbPreferences={aliases:{},lowBatteryThreshold:30,revision:0};
   data.events.unshift(
    {at:at-30000,deviceId:'adb-old-direct',name:'测试手机',category:'adb',action:'disconnected',route:'tailscale',state:'offline'},
    {at:at-45000,deviceId:'other-adb',name:'测试手机',category:'adb',action:'connected',route:'usb',state:'device'}
   );
  }
 }
 if(scenario==='empty')data.devices=[];
 if(scenario==='missing'){data.devices[0].battery=null;data.devices[1].battery='0%';data.power={externalConnected:true,batteryPresent:false,source:'外接电源',sampledAt:at};}
 if(scenario==='stale'||scenario==='error'){data.at=at-180000;data.stale=true;if(scenario==='error')data.error='设备扫描超时，请重试';}
 if(scenario==='unplugged')data.power={...data.power,externalConnected:false,source:'电池供电',charging:false,inputWatts:null,batterySideWatts:-15.2};
 if(scenario==='catalog'){
  Object.assign(data.devices.find(device=>device.id==='keyboard')!,{name:'Kzzi-K75 5.0',catalogKey:'kzzi-k75'});
  Object.assign(data.devices.find(device=>device.id==='pixel')!,{name:'Pixel 8 Pro',catalogKey:'pixel-8-pro'});
  data.catalog={'kzzi-k75':{name:'珂芝 K75'},'pixel-8-pro':{name:'Google Pixel 8 Pro'}};
 }
 if(scenario==='k75')data.devices.push({id:'usb-k75',name:'Gaming Keyboard',category:'usb',
  kind:'keyboard',detail:'BY Tech',status:'connected',vendor:'0x258a',productId:'0x0112',keyboardModeCandidate:true});
 if(scenario==='usb-tree'){
  Object.assign(data.devices.find(device=>device.id==='keyboard')!,{name:'Kzzi-K75 5.0',catalogKey:'kzzi-k75'});
  data.devices.push(
   {id:'genesys',name:'USB2.0 Hub',category:'usb',kind:'hub',detail:'Genesys Logic · 高速 · 480 Mb/s',status:'connected',usb:{manufacturer:'Genesys Logic',function:'hub'}},
   {id:'terminus',name:'USB 2.0 Hub',category:'usb',kind:'hub',detail:'Terminus · 高速 · 480 Mb/s',status:'connected',usb:{parentId:'genesys',manufacturer:'Terminus',function:'hub'}},
   {id:'adapter',name:'USB Type-C Digital AV Adapter',category:'usb',kind:'device',detail:'低速 · 1.5 Mb/s',status:'connected',usb:{parentId:'genesys',function:'billboard'}},
   {id:'usb-k75',name:'Gaming Keyboard',category:'usb',kind:'keyboard',detail:'BY Tech',status:'connected',keyboardModeCandidate:true,usb:{parentId:'terminus',manufacturer:'BY Tech'}}
  );
 }
 if(scenario==='long')data.devices[0].name='一台名称很长的蓝牙设备 / A deliberately long accessory name that must truncate';
 return data;
}
