import {useEffect,useRef,useState,type CSSProperties} from 'react';
import {Button,DialogShell,EmptyState,HelpPopover,Input,Tabs} from '@flowhub/plugin-common/react';
import type {Api} from './api';
import {DeviceArt,Icon} from './Icons';
import {AdbPreferenceEditor} from './AdbPreferenceEditor';
import {adbConnectionLabel,adbConnectionSummary,adbState,adbStale,adbTransport,categories,contextSelection,deviceAlias,deviceBattery,deviceName,displaySpec,displayType,emptyArtwork,eventLabel,finite,initial,isStale,listed,source,time,watts,type AdbPreferences,type Artwork,type Category,type Device,type Snapshot} from './model';

type Page='devices'|'power'|'events';
type Filter='all'|Category;
const validIntervals=[5,10,30,60];

function DeviceCard({device,artwork,stale,preferences,onOpen}:{device:Device;artwork:Artwork;stale:boolean;preferences?:AdbPreferences;onOpen:(device:Device)=>void}) {
 const level=deviceBattery(device,stale);
 const name=deviceName(device,preferences);
 const low=level!==null&&(device.adb?level<(preferences?.lowBatteryThreshold??30):level<=20);
 const speed=/(\d+(?:\.\d+)?)\s*(?:Gbit\/s|Gbps|Gb\/s|Mbps)/i.exec(device.detail);
 const info=device.adb?adbConnectionSummary(device.adb):device.category==='display'?device.pixelResolution||'像素参数未提供':device.detail||categories.find(c=>c.id===device.category)?.short||'设备';
 const connection=device.adb?(stale?'上次 · ':'')+adbState(device.adb.state):'';
 const battery=device.adb?(level===null?'电量未知':`电量 ${level}%${low?'，低电量':''}`):'';
 return <Button variant="ghost" className={'dc-card '+(stale?'is-stale':'')} data-device={device.id} aria-haspopup="dialog" aria-label={[name,connection,battery,'查看详情'].filter(Boolean).join('，')} onClick={event=>{event.currentTarget.focus();onOpen(device);}}>
  <DeviceArt device={device} artwork={artwork}/>
  <span className="dc-card-name">
   <span className="dc-card-title"><strong title={name}>{name}</strong>{device.adb?<span className="dc-adb-state" data-tone={stale?'stale':device.adb.state==='device'?'connected':'disconnected'}>{connection}</span>:null}</span>
   <small title={info}>{info}</small>
  </span>
  <span className="dc-card-value">{level!==null?<><strong className={low?'low':''}>{level}<small>%</small></strong><span className={'dc-battery-track '+(low?'low':'')} style={{'--level':level+'%'} as CSSProperties}><i/></span></>:device.adb?<small>电量未知</small>:device.category==='display'?<strong className="dc-spec">{displaySpec(device)}</strong>:speed?<strong className="dc-spec">{speed[0]}</strong>:<small>{stale?'上次连接':device.kind==='headphones'||device.kind==='mouse'||device.kind==='keyboard'?'电量未提供':'已连接'}</small>}</span>
 </Button>;
}

function AdbSection({snapshot,devices,artwork,busy,query,preview,onRefresh,onOpen,onThreshold}:{snapshot:Snapshot;devices:Device[];artwork:Artwork;busy:boolean;query:string;preview:boolean;onRefresh:()=>void;onOpen:(device:Device)=>void;onThreshold:(value:string)=>Promise<void>}) {
 const report=snapshot.adb,stale=adbStale(report),count=snapshot.devices.filter(d=>d.category==='adb').length;
 const [thresholdOpen,setThresholdOpen]=useState(false);
 return <section className="dc-group dc-adb" aria-label="ADB 设备"><div className="dc-group-heading"><h2><Icon name="adb"/>ADB 设备<small>({count})</small></h2><div className="dc-adb-actions"><HelpPopover label="ADB 设备说明"><p>使用本机 ADB 查询 Android 设备和模拟器，已授权连接会额外读取电量。USB 与 ADB 分别表示物理连接和调试连接，同一台手机可以出现在两处。</p><p>离线、未授权或读不到电量时显示未知。点击设备进入详情可以编辑该连接的别名。</p></HelpPopover><Button className="dc-button" disabled={preview} aria-expanded={thresholdOpen} onClick={()=>setThresholdOpen(value=>!value)}>电量设置</Button><Button className="dc-button" disabled={busy} onClick={onRefresh} aria-label="刷新 ADB 设备"><Icon name="refresh"/>刷新</Button></div></div>
  {thresholdOpen?<AdbPreferenceEditor kind="threshold" saved={String(snapshot.adbPreferences?.lowBatteryThreshold??30)} save={onThreshold}/>:null}
  {report?.error?<div className="dc-warning" role="alert">{report.error}{count?' 以下为上次采集结果。':''}</div>:report?.at&&stale?<div className="dc-warning" role="status">ADB 数据已过期，以下为上次采集结果。</div>:null}
  {devices.some(d=>d.adb?.state==='unauthorized')?<p className="dc-adb-hint" role="status">请在 Android 设备上确认调试授权，然后刷新。</p>:null}
  {devices.length?<div className="dc-device-grid">{devices.map(device=><DeviceCard key={device.id} device={device} artwork={artwork} stale={stale} preferences={snapshot.adbPreferences} onOpen={onOpen}/>)}</div>:!report?.error?<EmptyState className="dc-empty dc-adb-empty" title={!report?.checkedAt?'正在读取 ADB 设备':query&&count?'没有匹配的 ADB 设备':'没有检测到 ADB 设备'} description={!report?.checkedAt?'首次查询可能需要几秒。':query&&count?'尝试搜索别名、型号、序列号或连接状态。':'连接 Android 设备并启用 USB 调试，或启动模拟器后刷新。'}/>:null}
 </section>;
}

function PowerView({snapshot,stale}:{snapshot:Snapshot;stale:boolean}) {
 const p=snapshot.power,supply=source(p),system=finite(p.systemWatts),input=p.externalConnected===false?null:finite(p.inputWatts),battery=p.batteryPresent===false?null:finite(p.batterySideWatts);
 const label=p.batteryPresent===false?'电池功率':battery===null?'电池功率':battery<0?'电池放电':battery===0?'电池待机':'电池充电';
 const rating=typeof p.adapterWatts==='string'||typeof p.adapterWatts==='number'?String(p.adapterWatts).replace(/W$/i,'').trim():null;
 const ratingValue=rating&&/^\d+(\.\d+)?$/.test(rating)&&Number(rating)>0?rating:null;
 const powerError=p.telemetryError||p.powerSourceError;
 const measurements=[{label:'整机功耗',value:system,icon:'laptop',main:true},{label:'当前输入',value:input,icon:'power'},{label,value:battery,icon:'battery',estimate:true}];
 return <div className="dc-power"><div className="dc-power-heading"><small>{stale?'上次采样':'最近采样'} {time(p.sampledAt)}</small><span>{supply.label} · {supply.state}</span></div>
  {powerError?<div className="dc-warning" role="status">部分供电信息读取受限：{powerError}</div>:null}
  <section className={'dc-power-metrics '+(stale?'is-stale':'')} aria-label={stale?'上次功率读数':'功率读数'}>{measurements.map(m=><article key={m.icon} className={'dc-power-metric '+(m.main?'is-primary':'')}><div className="dc-metric-label"><Icon name={m.icon}/><span>{m.label}</span></div><div className={'dc-metric-number '+(m.value===null?'is-unknown':'')}>{m.value===null?'—':watts(m.value)}{m.value!==null?<span>W</span>:null}</div><small>{m.value===null?(m.estimate&&p.batteryPresent===false?'无内置电池':'系统未提供'):m.estimate?<><em>估算</em>电压 × 电流</>:'系统报告'}</small></article>)}</section>
  <section className="dc-power-facts" aria-label="电源信息"><div><span>供电方式</span><strong>{supply.label}</strong><small>{supply.label==='未提供'?'系统未返回此信息':stale?'上次采集结果':'系统已确认'}</small></div><div><span>适配器规格</span><strong>{ratingValue?ratingValue+' W':'未提供'}</strong><small>{ratingValue?'额定功率，非实时读数':'系统未返回此信息'}</small></div><div><span>线缆能力</span><strong>{finite(p.cableLimitWatts)!==null?p.cableLimitWatts+' W':'未提供'}</strong><small>{finite(p.cableLimitWatts)!==null?'系统报告':'系统未返回此信息'}</small></div></section>
  <div className="dc-power-note"><Icon name="info"/><span>功率可能异步采样，三项读数不保证相加相等。</span><HelpPopover label="功率与采样说明"><p>适配器额定功率不代表实际输入。整机功耗不包含独立供电的显示器等外设功耗。</p><p>{p.note||p.powerUnavailableReason||'系统传感器可用性因机型而异。缺失数据不使用估算规格填补。'}</p><p>设备目录每 45 秒更新，功率按当前组件采样间隔刷新。</p></HelpPopover></div>
 </div>;
}

export function App({api}:{api:Api}) {
 const [snapshot,setSnapshot]=useState<Snapshot>(initial),[artwork,setArtwork]=useState<Artwork>(emptyArtwork);
 const [page,setPage]=useState<Page>('devices'),[filter,setFilter]=useState<Filter>('all'),[query,setQuery]=useState('');
 const [busy,setBusy]=useState(false),[clock,setClock]=useState(Date.now()),[interval,setIntervalSeconds]=useState(5);
 const [selected,setSelected]=useState<Device|null>(null),[open,setOpen]=useState(false);
 const [eventFilter,setEventFilter]=useState<{name:string;ids:string[]}|null>(null);
 const [notice,setNotice]=useState(''),[copyState,setCopyState]=useState('');
 const [settingsBusy,setSettingsBusy]=useState(false),[settingsError,setSettingsError]=useState('');
 const openingSettings=useRef(false);
 const inputRef=useRef<HTMLInputElement>(null),reload=useRef<(force?:boolean,adbOnly?:boolean)=>void>(()=>{}),requestedDevice=useRef<string|undefined>(undefined);
 const scrollRef=useRef<HTMLDivElement>(null),scrolls=useRef<Record<Page,number>>({devices:0,power:0,events:0});
 const stale=isStale(snapshot,clock);
 useEffect(()=>{
  let alive=true,inflight=false,timer:ReturnType<typeof setInterval>|undefined;
  async function load(force=false,seconds=5,adbOnly=false) {
   if(inflight||!alive)return;inflight=true;setBusy(true);
   try {
    const next=await api.request<Snapshot>(force?(adbOnly?'adb_refresh':'refresh'):'snapshot',{powerIntervalSeconds:seconds});
    if(!next||!Array.isArray(next.devices)||!Array.isArray(next.events)||!next.power||typeof next.at!=='number')throw Error('设备数据格式无效');
    if(alive){
     setSnapshot(previous=>(previous.adbPreferences?.revision??0)>(next.adbPreferences?.revision??0)
      ?{...next,adbPreferences:previous.adbPreferences}:next);
     setClock(Date.now());
     if(requestedDevice.current&&(next.at>0||next.adb?.at)){const id=requestedDevice.current;const d=next.devices.find(d=>d.id===id||d.adb?.legacyIds?.includes(id));requestedDevice.current=undefined;if(d){setSelected(d);setOpen(true);}else setNotice('该设备未出现在本次采集结果中');}
    }
   }catch(error){if(alive){const message=String(error instanceof Error?error.message:error);setSnapshot(previous=>({...previous,...(adbOnly?{}:{stale:true,error:message}),adb:{available:false,at:0,intervalSeconds:10,...previous.adb,checkedAt:Date.now(),stale:true,error:message}}));}}
   finally {inflight=false;if(alive)setBusy(false);}
  }
  const unsubscribe=api.onReady(context=>{
   const seconds=validIntervals.includes(Number(context.config?.powerIntervalSeconds))?Number(context.config?.powerIntervalSeconds):5;
   setIntervalSeconds(seconds);reload.current=(force=false,adbOnly=false)=>void load(force,seconds,adbOnly);
   const selection=contextSelection(context);
   const target=selection.view||new URLSearchParams(location.search).get('view');
   if(['power','events'].includes(target||''))setPage(target as Page);
   else if(['bluetooth','usb','display','adb'].includes(target||'')){setPage('devices');setFilter(target as Category);}
   requestedDevice.current=selection.deviceId;
   void load(false,seconds);
   void api.request<Artwork>('device_icons').then(value=>{if(alive&&value?.icons&&typeof value.icons==='object')setArtwork(value);}).catch(()=>{});
   clearInterval(timer);timer=setInterval(()=>{setClock(Date.now());if(!document.hidden)void load(false,seconds);},seconds*1000);
  });
  return ()=>{alive=false;clearInterval(timer);unsubscribe();reload.current=()=>{};};
 },[api]);
 useEffect(()=>{if(scrollRef.current)scrollRef.current.scrollTop=scrolls.current[page];},[page]);
 useEffect(()=>{
  function shortcut(event:KeyboardEvent){if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'&&!open&&!event.isComposing){event.preventDefault();setPage('devices');requestAnimationFrame(()=>inputRef.current?.focus());}}
  window.addEventListener('keydown',shortcut);return ()=>window.removeEventListener('keydown',shortcut);
 },[open]);
 const connected=snapshot.devices.filter(listed);
 const search=query.trim().toLocaleLowerCase();
 const visible=connected.filter(d=>(filter==='all'||d.category===filter)&&[
  deviceName(d,snapshot.adbPreferences),d.name,d.detail,d.adb?.serial,d.adb?.sharedAlias,
  d.adb?adbState(d.adb.state):'',d.adb?adbTransport(d.adb.transport):'',
  ...(d.adb?.connections??[]).flatMap(connection=>[connection.serial,adbState(connection.state),adbConnectionLabel(connection,true)])
 ].join(' ').toLocaleLowerCase().includes(search));
 const showAdb=filter==='adb'||filter==='all'&&Boolean(snapshot.adb?.available||snapshot.devices.some(d=>d.category==='adb'));
 const current=selected?snapshot.devices.find(d=>d.id===selected.id):undefined;
 const detail=current||selected;
 const removed=Boolean(selected&&(selected.adb?snapshot.adb?.at:snapshot.at)&&!current&&!(selected.adb?adbStale(snapshot.adb):stale));
 const level=detail?deviceBattery(detail,removed||adbStale(snapshot.adb)):null;
 const detailName=detail?deviceName(detail,snapshot.adbPreferences):'';
 const lowBattery=Boolean(detail?.adb&&level!==null&&level<(snapshot.adbPreferences?.lowBatteryThreshold??30));
 const detailIds=detail?[detail.id,...(detail.adb?.legacyIds??[])]:[];
 const recentEvents=open?snapshot.events.filter(event=>detailIds.includes(event.deviceId)).slice(0,3):[];
 const events=eventFilter?snapshot.events.filter(event=>eventFilter.ids.includes(event.deviceId)):snapshot.events;
 function openDevice(device:Device){setSelected(device);setCopyState('');setSettingsError('');setOpen(true);setNotice('');}
 async function saveAdbPreference(method:string,params:Record<string,unknown>){
  const next=await api.request<AdbPreferences>(method,params);
  setSnapshot(previous=>(previous.adbPreferences?.revision??0)>next.revision?previous:{...previous,adbPreferences:next});
 }
 async function openDisplaySettings(){
  if(api.preview||openingSettings.current)return;
  openingSettings.current=true;setSettingsBusy(true);setSettingsError('');
  try{await api.request('open_display_settings');}
  catch(error){setSettingsError(error instanceof Error?error.message:'无法打开显示器设置，请在系统设置中选择“显示器”。');}
  finally{openingSettings.current=false;setSettingsBusy(false);}
 }
 async function copy(){if(!detail)return;try{await navigator.clipboard.writeText(detail.adb?detail.adb.serial:[detail.name,detail.detail,detail.battery,detail.pixelResolution,detail.refreshRate].filter(Boolean).join(' · '));setCopyState('已复制');}catch{setCopyState('复制受限，可选中详情文字手动复制');}}
 const connections=detail?.adb?.connections??[];
 const fields=detail?(detail.adb?[
  ...(connections.length?[]:[['序列号',detail.adb.serial],['连接状态',adbState(detail.adb.state)],['连接方式',adbTransport(detail.adb.transport)],['传输 ID',detail.adb.transportId||'未提供']]),
  ['型号',detail.adb.model||'未提供'],['产品',detail.adb.product||'未提供'],
  ...(detail.adb.sharedAlias?[['Toolkit 别名',detail.adb.sharedAlias]]:[])
 ]:detail.category==='display'?[['像素分辨率',detail.pixelResolution||'未提供'],['界面逻辑尺寸',detail.logicalResolution||'未提供'],['刷新率',detail.refreshRate||'未提供'],['屏幕类型',displayType(detail)]]:[['连接方式',categories.find(c=>c.id===detail.category)?.short||'未提供'],['系统描述',detail.detail||'未提供'],['厂商 ID',detail.vendor||'未提供'],['产品 ID',detail.productId||'未提供']]):[];
 return <Tabs value={page} onValueChange={value=>{setPage(value as Page);setEventFilter(null);}} className="dc-app">
  <header className="dc-header"><div className="dc-brand"><Icon name="laptop"/><strong>外设中心</strong></div><Tabs.List className="dc-navigation" aria-label="外设中心工作区"><Tabs.Trigger value="devices">设备</Tabs.Trigger><Tabs.Trigger value="power">供电</Tabs.Trigger><Tabs.Trigger value="events">事件</Tabs.Trigger></Tabs.List><div className="dc-header-actions">{api.preview?<span className="dc-preview">示例数据</span>:null}{!(page==='devices'&&filter==='adb')?<Button className="dc-button dc-refresh" disabled={busy} aria-label="刷新设备" onClick={()=>reload.current(true)}><Icon className={busy?'is-spinning':''} name="refresh"/><span>刷新</span></Button>:null}</div></header>
  {(snapshot.error||stale&&snapshot.at>0)&&!(page==='devices'&&filter==='adb')?<div className="dc-warning" role={snapshot.error?'alert':'status'}>{snapshot.error?'读取失败：'+snapshot.error:'设备数据已过期'}{snapshot.at?'；以下为 '+time(snapshot.at)+' 的上次采集结果。':'。'}<Button className="dc-button" disabled={busy} onClick={()=>reload.current(true)}>重新读取</Button></div>:null}
  {notice?<div role="status" className="dc-notice">{notice}</div>:null}
  {settingsError&&!open?<div role="alert" className="dc-warning">{settingsError}</div>:null}
  <div className="dc-workspace" ref={scrollRef} onScroll={event=>{scrolls.current[page]=event.currentTarget.scrollTop;}}>
   <Tabs.Panel value="devices" forceMount className="dc-devices" tabIndex={-1}>
    <div className="dc-toolbar"><label className="dc-search"><Icon name="search"/><Input ref={inputRef} className="dc-input" type="search" aria-label="搜索设备" placeholder="搜索设备…" value={query} onChange={e=>setQuery(e.target.value)}/><kbd>⌘ K</kbd></label><div className="dc-filters" role="group" aria-label="设备分类">{[{id:'all',short:'全部'},...categories].map(category=><Button variant="ghost" className="dc-button dc-filter" key={category.id} data-category={category.id} aria-pressed={filter===category.id} onClick={()=>setFilter(category.id as Filter)}>{category.short}<small>{category.id==='all'?connected.length:connected.filter(d=>d.category===category.id).length}</small></Button>)}</div><HelpPopover label="设备图标说明">桌面组件、设备卡片和详情共用设备图片。能识别的苹果设备使用 macOS 家族示意图，其余设备使用插件自带的彩色类别插图。图片均在本机加载。</HelpPopover></div>
    {filter==='adb'?null:!snapshot.at&&!snapshot.error?<EmptyState className="dc-empty" title="正在读取设备" description="首次设备扫描可能需要一些时间。"/>:!visible.length?<EmptyState className="dc-empty" title={query?'未找到匹配设备':'当前没有检测到设备'} description={query?'尝试其他名称或清除筛选。':snapshot.error?'设备读取失败，请重试。':'仅显示本机已检测到的连接设备。'} action={query||filter!=='all'?<Button className="dc-button" onClick={()=>{setQuery('');setFilter('all');}}>清除筛选</Button>:undefined}/>:categories.filter(category=>category.id!=='adb').map(category=>{
     const devices=visible.filter(d=>d.category===category.id);return devices.length?<section key={category.id} className="dc-group"><div className="dc-group-heading"><h2><Icon name={category.id}/>{category.label}<small>({devices.length})</small></h2>{category.id==='display'?<Button className="dc-button dc-display-settings" disabled={api.preview||settingsBusy} title={api.preview?'只读预览不打开系统设置':'在 macOS 中调整分辨率、刷新率、镜像／扩展和屏幕排列'} onClick={()=>void openDisplaySettings()}><Icon name="external"/>{settingsBusy?'正在打开…':'显示设置'}</Button>:null}</div><div className="dc-device-grid">{devices.map(device=><DeviceCard key={device.id} device={device} artwork={artwork} stale={stale} onOpen={openDevice}/>)}</div></section>:null;
    })}
    {showAdb?<AdbSection snapshot={snapshot} devices={visible.filter(d=>d.category==='adb')} artwork={artwork} busy={busy} query={query} preview={api.preview} onRefresh={()=>reload.current(true,true)} onOpen={openDevice} onThreshold={value=>saveAdbPreference('adb_set_low_battery_threshold',{threshold:Number(value)})}/>:null}
   </Tabs.Panel>
   <Tabs.Panel value="power" className="dc-power-panel" tabIndex={-1}><PowerView snapshot={snapshot} stale={stale}/></Tabs.Panel>
   <Tabs.Panel value="events" className="dc-events" tabIndex={-1}>
    <div className="dc-events-heading">
     <span>{eventFilter?.name||'本次运行的连接变化'}</span>
     {eventFilter?<Button className="dc-button" onClick={()=>setEventFilter(null)}>全部事件</Button>:null}
     <HelpPopover label="事件记录说明">只记录本次运行期间观察到的变化，最多保留 60 条。首次扫描建立基线，重启后清空。蓝牙、USB 和显示器每 45 秒扫描，ADB 约每 10 秒检查，可能漏过两次扫描之间的短暂变化。</HelpPopover>
    </div>
    {events.length?events.map((event,index)=><div className="dc-event" key={event.at+'-'+index}><Icon name={event.category}/><div><strong>{eventFilter?.name||event.name}</strong><small>{eventLabel(event)}</small></div><time>{time(event.at)}</time></div>):<EmptyState className="dc-empty" title="暂无连接事件" description="后续扫描观察到变化时会在这里记录。"/>}
   </Tabs.Panel>
  </div>
  <footer className="dc-footer"><span>{busy?'正在采集…':filter==='adb'&&page==='devices'?adbStale(snapshot.adb)?'上次更新 ':'更新于 ':stale?'上次更新 ':'更新于 '}{busy?'':time(page==='power'?snapshot.power.sampledAt:filter==='adb'?snapshot.adb?.at:snapshot.at)}</span><span>{page==='power'?'功率每 '+interval+' 秒 · 设备每 45 秒':page==='events'?'仅在本次运行保留':filter==='adb'?'ADB 每 10 秒 · 点击查看详情':'点击设备查看详情'}</span></footer>
  <DialogShell open={open&&Boolean(detail)} onOpenChange={value=>{setOpen(value);if(!value&&!current)requestAnimationFrame(()=>inputRef.current?.focus());}} title="设备详情" className="dc-dialog" contentClassName="dc-dialog-content" footer={<><span className="dc-copy-status" role="status">{copyState}</span>{detail?.category==='display'?<Button className="dc-button dc-display-settings" disabled={api.preview||settingsBusy} title={api.preview?'只读预览不打开系统设置':'打开 macOS 显示器设置'} onClick={()=>void openDisplaySettings()}><Icon name="external"/>{settingsBusy?'正在打开…':'显示设置'}</Button>:null}<Button className="dc-button" onClick={()=>void copy()}><Icon name="copy"/>{detail?.adb?'复制序列号':'复制摘要'}</Button><Button variant="ghost" className="dc-button" onClick={()=>{setOpen(false);setPage('events');setEventFilter({name:detailName,ids:detailIds});}}>相关事件</Button></>}>
   {detail?<><div className="dc-detail-hero"><DeviceArt device={detail} artwork={artwork}/><div><h3>{detailName}</h3><p>{removed?'本次扫描未检测到':(detail.adb?adbStale(snapshot.adb):stale)?'上次采集结果':detail.adb?adbState(detail.adb.state):'已连接'}</p></div>{level!==null?<strong className={'dc-detail-battery '+(lowBattery?'low':'')} aria-label={lowBattery?`低电量 ${level}%`:undefined}>{level}<small>%</small></strong>:detail.adb?<small>电量未知</small>:detail.category==='display'?<strong className="dc-detail-spec">{displaySpec(detail)}</strong>:null}</div>{removed?<p className="dc-warning" role="status">设备已离开当前连接列表，以下为上次信息。</p>:null}
    {connections.length?<section className="dc-adb-connections" aria-label="连接线路">
     <h4>连接线路 <small>{connections.length}</small></h4>
     <ul>{connections.map(connection=><li key={connection.serial}>
      <div><strong>{adbConnectionLabel(connection,true)}</strong>
       {connection.role?<small>{connection.role==='primary'?'主入口':'备用入口'}</small>:null}
       {connection.identityVerified===false?<small>身份待核对</small>:null}
      </div>
      <span className="dc-adb-state" data-tone={removed||adbStale(snapshot.adb)?'stale':connection.state==='device'?'connected':'disconnected'}>
       {removed||adbStale(snapshot.adb)?'上次 · ':''}{adbState(connection.state)}
      </span>
      <code>{connection.serial}</code>
     </li>)}</ul>
    </section>:null}
    <dl className="dc-detail-facts">{fields.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <section className="dc-recent-events" aria-label="最近连接事件">
     <h4>最近连接事件</h4>
     {recentEvents.length?<ul>{recentEvents.map((event,index)=><li key={event.at+'-'+index}><span>{eventLabel(event)}</span><time>{time(event.at)}</time></li>)}</ul>:<p>本次运行暂无连接变化</p>}
    </section>
    {open&&detail.adb&&!api.preview?<AdbPreferenceEditor key={detail.id} kind="alias" saved={deviceAlias(detail,snapshot.adbPreferences)} disabled={removed} sharedAlias={detail.adb.sharedAlias} save={alias=>saveAdbPreference('adb_set_alias',{id:detail.id,alias})}/>:null}
    {detail.category==='display'?<><p className="dc-detail-note">点击“显示设置”，在 macOS 中选择屏幕并调整分辨率、刷新率、镜像／扩展和排列。</p>{settingsError?<p role="alert" className="dc-warning">{settingsError}</p>:null}</>:null}{detail.adb?.state==='unauthorized'?<p className="dc-warning" role="status">请在 Android 设备上确认调试授权，然后刷新。</p>:null}{detail.adb&&snapshot.adb?.error?<p role="alert" className="dc-warning">{snapshot.adb.error}</p>:null}{level===null&&detail.category==='bluetooth'?<p className="dc-detail-note">macOS 未提供当前电量。</p>:null}<p className="dc-detail-note">{(detail.adb?adbStale(snapshot.adb):stale)||removed?'上次采集于 ':'采集于 '}{time(detail.adb?snapshot.adb?.at:snapshot.at)} · 数据来自 {detail.adb?'本机 ADB':'macOS'}</p></>:null}
  </DialogShell>
 </Tabs>;
}
