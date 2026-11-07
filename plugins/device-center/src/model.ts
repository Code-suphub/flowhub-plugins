import '../ui/device-art.js';

export type Category='bluetooth'|'usb'|'display'|'adb';
export interface AdbConnection {
  serial: string;
  state: string;
  transport: string;
  source?: string | null;
  role?: string | null;
  identityVerified?: boolean;
}
export interface AdbInfo extends AdbConnection {
  model?: string | null;
  product?: string | null;
  transportId?: string | null;
  sharedAlias?: string | null;
  connections?: AdbConnection[];
  legacyIds?: string[];
}
export interface AdbReport {available:boolean;at:number;checkedAt:number;stale:boolean;error?:string|null;intervalSeconds:number}
export interface AdbPreferences {
  aliases: Record<string,string>;
  lowBatteryThreshold: number;
  revision: number;
  error?: string | null;
}
export interface Device {id:string;name:string;category:Category;kind:string;detail:string;status:string;battery?:string|null;vendor?:string|null;productId?:string|null;displayConnection?:string;pixelResolution?:string;logicalResolution?:string;refreshRate?:string;adb?:AdbInfo;catalogKey?:string}
export interface DeviceEvent {at:number;name:string;category:string;action:string;deviceId:string;route?:string;state?:string}
export interface Power {adapterWatts?:string|number|null;inputWatts?:number|null;systemWatts?:number|null;batterySideWatts?:number|null;externalConnected?:boolean|null;batteryPresent?:boolean;source?:string|null;charging?:boolean|null;cableLimitWatts?:number|null;sampledAt?:number|null;note?:string;powerSourceError?:string;powerUnavailableReason?:string;telemetryError?:string;smcError?:string}
export interface DeviceProfile {name:string;image?:{dataUrl:string;author:string;license:string}}
export type DeviceCatalog=Record<string,DeviceProfile>;
export interface Snapshot {at:number;stale:boolean;devices:Device[];power:Power;events:DeviceEvent[];error?:string|null;intervalSeconds?:number;powerIntervalSeconds?:number;adb?:AdbReport;adbPreferences?:AdbPreferences;catalog?:DeviceCatalog}
export interface Artwork {available:boolean;icons:Record<string,{dataUrl:string;typeIdentifier:string;source:string}>}
interface Selection {deviceId?:string;view?:string}
export interface Context {config?:{powerIntervalSeconds?:number;selection?:Selection};selection?:Selection}
export function contextSelection(context:Context):Selection {return {deviceId:context.selection?.deviceId||context.config?.selection?.deviceId,view:context.selection?.view||context.config?.selection?.view};}
export const categories:{id:Category;label:string;short:string}[]=[{id:'bluetooth',label:'蓝牙设备',short:'蓝牙'},{id:'usb',label:'USB 与移动设备',short:'USB'},{id:'display',label:'显示器',short:'显示器'},{id:'adb',label:'ADB 设备',short:'ADB'}];
export function listed(device:Device):boolean {return device.category==='adb'||device.status==='connected';}
export function adbState(state?:string):string {return ({device:'已连接',unauthorized:'未授权',offline:'离线','no permissions':'权限不足',recovery:'Recovery',sideload:'Sideload',bootloader:'Bootloader',connecting:'连接中',authorizing:'授权中'} as Record<string,string>)[state||'']||state||'状态未提供';}
export function adbTransport(transport?:string):string {return ({usb:'USB',tcp:'TCP/IP',wireless:'无线调试',emulator:'模拟器'} as Record<string,string>)[transport||'']||'连接方式未提供';}
export function adbConnectionLabel(connection:AdbConnection,detail=false):string {
  if(connection.source==='easytier')return detail?'EasyTier · 本机转发':'EasyTier';
  if(connection.source==='tailscale')return detail?'Tailscale · 直连':'Tailscale';
  return adbTransport(connection.transport);
}
export function adbConnectionSummary(adb:AdbInfo):string {
  if(!adb.connections?.length)return [adbTransport(adb.transport),adb.serial].join(' · ');
  if(adb.connections.length===1)return [adbConnectionLabel(adb.connections[0]),adb.serial].join(' · ');
  return [...new Set(adb.connections.map(connection=>adbConnectionLabel(connection)))].join(' / ');
}
export function adbStale(report?:AdbReport,now=Date.now()):boolean {return !report?.at||report.stale||Boolean(report.error)||now-report.at>30_000;}
export function deviceAlias(device:Device,preferences?:AdbPreferences):string {
  return preferences?.aliases[device.id]
    || device.adb?.legacyIds?.map(id=>preferences?.aliases[id]).find(Boolean)
    || '';
}
export function deviceName(device:Device,preferences?:AdbPreferences):string {
  return (device.adb&&(deviceAlias(device,preferences)||device.adb.sharedAlias))||device.name;
}
export function deviceBattery(device:Device,stale:boolean):number|null {
  return device.adb&&(stale||device.adb.state!=='device')?null:batteryLevel(device.battery);
}
export const initial:Snapshot={at:0,stale:true,devices:[],power:{},events:[]};
export const emptyArtwork:Artwork={available:false,icons:{}};
export function batteryLevel(value:unknown):number|null {if(typeof value!=='string')return null;const match=/^(\d+(?:\.\d+)?)%$/.exec(value.trim());const n=match?Number(match[1]):NaN;return Number.isFinite(n)&&n>=0&&n<=100?n:null;}
export function finite(value:unknown):number|null {return typeof value==='number'&&Number.isFinite(value)?value:null;}
export function watts(value:unknown):string {const n=finite(value);return n===null?'未提供':Math.abs(n).toFixed(1);}
export function time(value:unknown):string {const n=finite(value);return n!==null&&n>0?new Date(n).toLocaleTimeString('zh-CN',{hour12:false}):'尚未采集';}
export function isStale(snapshot:Snapshot,now=Date.now()):boolean {return !snapshot.at||snapshot.stale||Boolean(snapshot.error)||now-snapshot.at>120_000;}
export const family=globalThis.FlowHubDeviceArt.family;
export const resolveDeviceArt=globalThis.FlowHubDeviceArt.resolve;
export function eventLabel(event:DeviceEvent):string {
  if(!event.route)return event.action==='connected'?'设备连接':event.action==='disconnected'?'设备断开':'设备状态变化';
  const route=event.route==='easytier'?'EasyTier':event.route==='tailscale'?'Tailscale':event.route==='unknown'?'ADB':adbTransport(event.route);
  const state=event.action==='connected'?'已连接':event.action==='disconnected'?'已断开':event.state==='unknown'?'状态变化':adbState(event.state);
  return route+' · '+state;
}
export function displayType(device:Device):string {return device.displayConnection==='built-in'?'内置':device.displayConnection==='external'?'外接':'类型未提供';}
export function displaySpec(device:Device):string {
  if(!device.pixelResolution)return device.refreshRate||'显示模式未提供';
  const values=device.pixelResolution.split(/\s*[×x]\s*/i).map(Number).sort((a,b)=>b-a);
  const grades:Record<string,string>={'1280,720':'720P','1920,1080':'1080P','2560,1440':'2K','3840,2160':'4K','4096,2160':'4K','5120,2880':'5K','6016,3384':'6K','6144,3456':'6K','7680,4320':'8K'};
  return [grades[values.join(',')]||device.pixelResolution,device.refreshRate].filter(Boolean).join(' · ');
}
export function source(power:Power):{label:string;state:string} {
  if(power.source==='UPS')return {label:'UPS',state:'UPS 供电'};
  if(power.externalConnected===false||['电池供电','Battery Power'].includes(power.source||''))return {label:'电池',state:power.batteryPresent===false?'供电状态未提供':'电池供电'};
  if(power.externalConnected===true||['外接电源','AC Power'].includes(power.source||'')) {
    if(power.batteryPresent===false)return {label:'外接电源',state:'无内置电池'};
    const battery=finite(power.batterySideWatts);
    if(battery!==null&&battery<0)return {label:'混合供电',state:'电池补充供电'};
    return {label:'外接电源',state:power.charging===true?'充电中':power.charging===false?'未充电':'充电状态未提供'};
  }
  return {label:'未提供',state:'供电状态未提供'};
}
