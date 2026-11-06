import {useEffect,useRef,useState,type CSSProperties} from 'react';
import {Button,DialogShell,EmptyState,HelpPopover,Input,Tabs} from '@flowhub/plugin-common/react';
import type {Api} from './api';
import {DeviceArt,Icon} from './Icons';
import {batteryLevel,categories,displaySpec,displayType,emptyArtwork,finite,initial,isStale,source,time,watts,type Artwork,type Category,type Device,type Snapshot} from './model';

type Page='devices'|'power'|'events';
type Filter='all'|Category;
const validIntervals=[5,10,30,60];

function DeviceCard({device,artwork,stale,onOpen}:{device:Device;artwork:Artwork;stale:boolean;onOpen:(device:Device)=>void}) {
 const level=batteryLevel(device.battery);
 const speed=/(\d+(?:\.\d+)?)\s*(?:Gbit\/s|Gbps|Gb\/s|Mbps)/i.exec(device.detail);
 const info=device.category==='display'?device.pixelResolution||'像素参数未提供':device.detail||categories.find(c=>c.id===device.category)?.short||'设备';
 return <Button variant="ghost" className={'dc-card '+(stale?'is-stale':'')} data-device={device.id} aria-haspopup="dialog" aria-label={device.name+'，查看详情'} onClick={()=>onOpen(device)}>
  <DeviceArt device={device} artwork={artwork}/><span className="dc-card-name"><strong title={device.name}>{device.name}</strong><small title={info}>{info}</small></span>
  <span className="dc-card-value">{level!==null?<><strong className={level<=20?'low':''}>{level}<small>%</small></strong><span className="dc-battery-track" style={{'--level':level+'%'} as CSSProperties}><i/></span></>:device.category==='display'?<strong className="dc-spec">{displaySpec(device)}</strong>:speed?<strong className="dc-spec">{speed[0]}</strong>:<small>{stale?'上次连接':device.kind==='headphones'||device.kind==='mouse'||device.kind==='keyboard'?'电量未提供':'已连接'}</small>}</span>
 </Button>;
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
 const [selected,setSelected]=useState<Device|null>(null),[open,setOpen]=useState(false),[eventName,setEventName]=useState('');
 const [notice,setNotice]=useState(''),[copyState,setCopyState]=useState('');
 const inputRef=useRef<HTMLInputElement>(null),reload=useRef<(force?:boolean)=>void>(()=>{}),requestedDevice=useRef<string|undefined>(undefined);
 const scrollRef=useRef<HTMLDivElement>(null),scrolls=useRef<Record<Page,number>>({devices:0,power:0,events:0});
 const stale=isStale(snapshot,clock);
 useEffect(()=>{
  let alive=true,inflight=false,timer:ReturnType<typeof setInterval>|undefined;
  async function load(force=false,seconds=5) {
   if(inflight||!alive)return;inflight=true;setBusy(true);
   try {
    const next=await api.request<Snapshot>(force?'refresh':'snapshot',{powerIntervalSeconds:seconds});
    if(!next||!Array.isArray(next.devices)||!Array.isArray(next.events)||!next.power||typeof next.at!=='number')throw Error('设备数据格式无效');
    if(alive){setSnapshot(next);setClock(Date.now());if(requestedDevice.current&&next.at>0){const d=next.devices.find(d=>d.id===requestedDevice.current);requestedDevice.current=undefined;if(d){setSelected(d);setOpen(true);}else setNotice('该设备未出现在本次采集结果中');}}
   }catch(error){if(alive)setSnapshot(previous=>({...previous,stale:true,error:String(error instanceof Error?error.message:error)}));}
   finally {inflight=false;if(alive)setBusy(false);}
  }
  const unsubscribe=api.onReady(context=>{
   const seconds=validIntervals.includes(Number(context.config?.powerIntervalSeconds))?Number(context.config?.powerIntervalSeconds):5;
   setIntervalSeconds(seconds);reload.current=(force=false)=>void load(force,seconds);
   const target=context.selection?.view||new URLSearchParams(location.search).get('view');
   if(['power','events'].includes(target||''))setPage(target as Page);
   else if(['bluetooth','usb','display'].includes(target||'')){setPage('devices');setFilter(target as Category);}
   requestedDevice.current=context.selection?.deviceId;
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
 const connected=snapshot.devices.filter(d=>d.status==='connected');
 const visible=connected.filter(d=>(filter==='all'||d.category===filter)&&(d.name+' '+d.detail).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
 const current=selected?snapshot.devices.find(d=>d.id===selected.id):undefined;
 const detail=current||selected;
 const removed=Boolean(selected&&snapshot.at&&!current&&!stale);
 const level=batteryLevel(detail?.battery);
 const events=snapshot.events.filter(event=>!eventName||event.name.includes(eventName));
 function openDevice(device:Device){setSelected(device);setCopyState('');setOpen(true);setNotice('');}
 async function copy(){if(!detail)return;try{await navigator.clipboard.writeText([detail.name,detail.detail,detail.battery,detail.pixelResolution,detail.refreshRate].filter(Boolean).join(' · '));setCopyState('已复制');}catch{setCopyState('复制受限，可选中详情文字手动复制');}}
 const fields=detail?(detail.category==='display'?[['像素分辨率',detail.pixelResolution||'未提供'],['界面逻辑尺寸',detail.logicalResolution||'未提供'],['刷新率',detail.refreshRate||'未提供'],['屏幕类型',displayType(detail)]]:[['连接方式',categories.find(c=>c.id===detail.category)?.short||'未提供'],['系统描述',detail.detail||'未提供'],['厂商 ID',detail.vendor||'未提供'],['产品 ID',detail.productId||'未提供']]):[];
 return <Tabs value={page} onValueChange={value=>{setPage(value as Page);setEventName('');}} className="dc-app">
  <header className="dc-header"><div className="dc-brand"><Icon name="laptop"/><strong>外设中心</strong></div><Tabs.List className="dc-navigation" aria-label="外设中心工作区"><Tabs.Trigger value="devices">设备</Tabs.Trigger><Tabs.Trigger value="power">供电</Tabs.Trigger><Tabs.Trigger value="events">事件</Tabs.Trigger></Tabs.List><div className="dc-header-actions">{api.preview?<span className="dc-preview">示例数据</span>:null}<Button className="dc-button dc-refresh" disabled={busy} aria-label="刷新设备" onClick={()=>reload.current(true)}><Icon className={busy?'is-spinning':''} name="refresh"/><span>刷新</span></Button></div></header>
  {(snapshot.error||stale&&snapshot.at>0)?<div className="dc-warning" role={snapshot.error?'alert':'status'}>{snapshot.error?'读取失败：'+snapshot.error:'设备数据已过期'}{snapshot.at?'；以下为 '+time(snapshot.at)+' 的上次采集结果。':'。'}<Button className="dc-button" disabled={busy} onClick={()=>reload.current(true)}>重新读取</Button></div>:null}
  {notice?<div role="status" className="dc-notice">{notice}</div>:null}
  <div className="dc-workspace" ref={scrollRef} onScroll={event=>{scrolls.current[page]=event.currentTarget.scrollTop;}}>
   <Tabs.Panel value="devices" forceMount className="dc-devices" tabIndex={-1}>
    <div className="dc-toolbar"><label className="dc-search"><Icon name="search"/><Input ref={inputRef} className="dc-input" type="search" aria-label="搜索设备" placeholder="搜索设备…" value={query} onChange={e=>setQuery(e.target.value)}/><kbd>⌘ K</kbd></label><div className="dc-filters" role="group" aria-label="设备分类">{[{id:'all',short:'全部'},...categories].map(category=><Button variant="ghost" className="dc-button dc-filter" key={category.id} aria-pressed={filter===category.id} onClick={()=>setFilter(category.id as Filter)}>{category.short}<small>{category.id==='all'?connected.length:connected.filter(d=>d.category===category.id).length}</small></Button>)}</div><HelpPopover label="设备图标说明">苹果设备可使用当前 macOS 提供的设备家族示意图，不代表实际机身颜色或手机壁纸；其他设备使用开源 Material Design Icons 类别图标，资源缺失时同样回退。图标不会联网加载。</HelpPopover></div>
    {!snapshot.at&&!snapshot.error?<EmptyState className="dc-empty" title="正在读取设备" description="首次设备扫描可能需要一些时间。"/>:!visible.length?<EmptyState className="dc-empty" title={query?'未找到匹配设备':'当前没有检测到设备'} description={query?'尝试其他名称或清除筛选。':snapshot.error?'设备读取失败，请重试。':'仅显示本机已检测到的连接设备。'} action={query||filter!=='all'?<Button className="dc-button" onClick={()=>{setQuery('');setFilter('all');}}>清除筛选</Button>:undefined}/>:categories.map(category=>{
     const devices=visible.filter(d=>d.category===category.id);return devices.length?<section key={category.id} className="dc-group"><h2><Icon name={category.id}/>{category.label}<small>({devices.length})</small></h2><div className="dc-device-grid">{devices.map(device=><DeviceCard key={device.id} device={device} artwork={artwork} stale={stale} onOpen={openDevice}/>)}</div></section>:null;
    })}
   </Tabs.Panel>
   <Tabs.Panel value="power" className="dc-power-panel" tabIndex={-1}><PowerView snapshot={snapshot} stale={stale}/></Tabs.Panel>
   <Tabs.Panel value="events" className="dc-events" tabIndex={-1}><div className="dc-events-heading"><span>{eventName?'名称：'+eventName:'本次运行的连接变化'}</span>{eventName?<Button className="dc-button" onClick={()=>setEventName('')}>全部事件</Button>:null}<HelpPopover label="事件记录说明">只记录本次后端运行期间观察到的变化，最多保留 60 条，重启后清空。设备目录每 45 秒扫描一次，不保证捕获两次扫描间的短暂连接。详情入口按设备名称筛选。</HelpPopover></div>{events.length?events.map((event,index)=><div className="dc-event" key={event.at+'-'+index}><Icon name={event.category}/><div><strong>{event.name}</strong><small>{event.action==='disconnected'?'设备断开':event.action==='connected'?'设备连接':'设备状态变化'}</small></div><time>{time(event.at)}</time></div>):<EmptyState className="dc-empty" title="暂无连接事件" description="后续扫描观察到变化时会在这里记录。"/>}</Tabs.Panel>
  </div>
  <footer className="dc-footer"><span>{busy?'正在采集…':stale?'上次更新 ':'更新于 '}{busy?'':time(page==='power'?snapshot.power.sampledAt:snapshot.at)}</span><span>{page==='power'?'功率每 '+interval+' 秒 · 设备每 45 秒':page==='events'?'仅在本次运行保留':'点击设备查看详情'}</span></footer>
  <DialogShell open={open&&Boolean(detail)} onOpenChange={value=>{setOpen(value);if(!value&&!current)requestAnimationFrame(()=>inputRef.current?.focus());}} title="设备详情" className="dc-dialog" contentClassName="dc-dialog-content" footer={<><span className="dc-copy-status" role="status">{copyState}</span><Button className="dc-button" onClick={()=>void copy()}><Icon name="copy"/>复制摘要</Button><Button variant="ghost" className="dc-button" onClick={()=>{setOpen(false);setPage('events');setEventName(detail?.name||'');}}>相关事件</Button></>}>
   {detail?<><div className="dc-detail-hero"><DeviceArt device={detail} artwork={artwork}/><div><h3>{detail.name}</h3><p>{removed?'本次扫描未检测到':stale?'上次采集结果':'已连接'}</p></div>{level!==null?<strong className="dc-detail-battery">{level}<small>%</small></strong>:detail.category==='display'?<strong className="dc-detail-spec">{displaySpec(detail)}</strong>:null}</div>{removed?<p className="dc-warning" role="status">设备已离开当前连接列表，以下为上次信息。</p>:null}<dl className="dc-detail-facts">{fields.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>{level===null&&detail.category==='bluetooth'?<p className="dc-detail-note">macOS 未提供当前电量。</p>:null}<p className="dc-detail-note">{stale||removed?'上次采集于 ':'采集于 '}{time(snapshot.at)} · 数据来自 macOS</p></>:null}
  </DialogShell>
 </Tabs>;
}
