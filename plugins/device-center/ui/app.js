(() => {
'use strict';
const node=document.getElementById('app');
const surface=document.body.dataset.surface||'main';
const isWidget=surface!=='main';
const hostWindow=window.parent!==window;
const widgetToken=new URLSearchParams(location.hash.slice(1)).get('flowhubWidgetToken');
const preview=!hostWindow||(isWidget&&!widgetToken)||new URLSearchParams(location.search).has('preview');
if(new URLSearchParams(location.search).has('embedded'))document.body.classList.add('embedded');
const p=new URLSearchParams(location.search);
let view=p.get('view')||'overview',search='',chosen=null,loading=false,done=false,widgetContext={},widgetReady=false,widgetSelectedId=null;
const pending=new Map();
let poll=null;
const powerIntervals=[5,10,30,60];
const powerInterval=()=>powerIntervals.includes(Number(widgetContext?.config?.powerIntervalSeconds))?Number(widgetContext.config.powerIntervalSeconds):5;
const paths={
  overview:'<rect x="3" y="3" width="18" height="15" rx="3"/><path d="M9 22h6m-3-4v4"/>',
  bluetooth:'<path d="m7 7 10 10-5 4V3l5 4L7 17"/>',
  usb:'<path d="M12 3v17m-4-14 4-3 4 3M7 12h5l5 5m-10-5v5m10 0h3v3h-3v-3M5 17h4v4H5v-4Z"/>',
  display:'<rect x="2.5" y="3.5" width="19" height="14" rx="2"/><path d="M8 21h8m-4-3v3"/>',
  power:'<path d="M13 2 4 13h7l-1 9 10-12h-7V2Z"/>',
  events:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
  settings:'<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.2-2l2-1-2-4-2 1a7 7 0 0 0-3-2l-.5-2h-4l-.5 2a7 7 0 0 0-3 2l-2-1-2 4 2 1a7 7 0 0 0 0 4l-2 1 2 4 2-1a7 7 0 0 0 3 2l.5 2h4l.5-2a7 7 0 0 0 3-2l2 1 2-4-2-1a7 7 0 0 0 .2-2Z"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.2"/><path d="m15 15 6 6"/>',
  dots:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  chevron:'<path d="m9 5 7 7-7 7"/>',
  warning:'<path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 9v4m0 4v.01"/>',
  laptop:'<rect x="4" y="4" width="16" height="13" rx="2"/><path d="M2 20h20l-2-3H4l-2 3Z"/>',
  battery:'<rect x="2" y="7" width="18" height="10" rx="2"/><path d="M22 10v4"/>',
  refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 9A7 7 0 0 1 18 7l2 5M4 12l2 5a7 7 0 0 0 12-2"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  close:'<path d="m5 5 14 14M19 5 5 19"/>',
  headset:'<path d="M4 13v-2a8 8 0 0 1 16 0v2M4 13h4v7H6a2 2 0 0 1-2-2v-5Zm16 0h-4v7h2a2 2 0 0 0 2-2v-5Z"/>',
  device:'<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>'
};
const svg=(name,cls='')=>`<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${paths[name]||paths.device}</svg>`;
const safe=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const label={overview:'概览',bluetooth:'蓝牙设备',usb:'USB 与移动设备',display:'显示器',power:'供电',events:'历史事件',settings:'设置'};
const demo={
  at:Date.now(),stale:false,
  devices:[
    {id:'a',name:'AirPods Pro 2',category:'bluetooth',kind:'headphones',detail:'音频设备',battery:'82%',status:'connected',image:'airpods',badges:[['已连接','green']]},
    {id:'b',name:'Magic Mouse',category:'bluetooth',kind:'mouse',detail:'鼠标',battery:'67%',status:'connected',image:'mouse',badges:[['已连接','green']]},
    {id:'c',name:'Keychron K3',category:'bluetooth',kind:'keyboard',detail:'键盘',battery:'100%',status:'connected',image:'keyboard',badges:[['已连接','green']]},
    {id:'d',name:'Pixel 9 Pro',category:'usb',kind:'phone',detail:'USB-C',status:'connected',image:'pixel',badges:[['USB-C','gray'],['ADB 已授权','green'],['开发者模式','green']]},
    {id:'e',name:'iPhone 15',category:'usb',kind:'phone',detail:'USB',status:'connected',image:'iphone',badges:[['USB','gray'],['已信任','green']]},
    {id:'f',name:'Samsung T7 SSD',category:'usb',kind:'drive',detail:'USB 3.2 Gen 2 · 10 Gbps',status:'connected',image:'ssd',badges:[['USB 3.2 Gen 2','gray'],['10 Gbps','gray']]},
    {id:'g',name:'SD Card Reader',category:'usb',kind:'hub',detail:'USB',status:'connected',image:'reader',badges:[['已连接','green']]},
    {id:'h',name:'DELL U2723QE',category:'display',kind:'monitor',detail:'3840 × 2160 · 60 Hz',status:'connected',image:'dell',role:'主显示器'},
    {id:'i',name:'LG UltraFine',category:'display',kind:'monitor',detail:'2560 × 1440 · 60 Hz',status:'connected',image:'lg',role:'竖屏'}
  ],
  power:{adapterWatts:'96',inputWatts:56.8,systemWatts:25.4,batterySideWatts:31.4,externalConnected:true,source:'MacBook 供电状态',charging:true,cableLimitWatts:null,
    sampledAt:Date.now(),note:'系统报告的采样值；电池功率按电压×电流估算，并非线缆实测。'},
  events:[
    {at:Date.now()-380000,name:'连接 Pixel 9 Pro',category:'usb',action:'connected'},
    {at:Date.now()-840000,name:'外接显示器 DELL U2723QE 已接入',category:'display',action:'connected'},
    {at:Date.now()-1790000,name:'线缆能力无法识别',category:'power',action:'unknown'},
    {at:Date.now()-2400000,name:'Samsung T7 SSD 已连接',category:'usb',action:'connected'}
  ],previewAnomalies:1
};
let data=preview?structuredClone(demo):{at:0,stale:true,devices:[],events:[],power:{},error:null};
const count=t=>data.devices.filter(d=>d.category===t).length;
const formattedTime=t=>t?new Date(t).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}):'尚未采集';
function imgKey(d){
  if(d.image)return d.image;
  const n=d.name.toLowerCase();
  const known={
    'airpods pro 2':'airpods','magic mouse':'mouse','keychron k3':'keyboard','pixel 9 pro':'pixel',
    'iphone 15':'iphone','samsung t7 ssd':'ssd','sd card reader':'reader',
    'dell u2723qe':'dell','lg ultrafine':'lg'
  };
  return known[n]||null;
}
function photo(d,screen=false){
  const key=imgKey(d);
  const fallback=d.category==='display'?'monitor':d.kind==='headphones'?'headphones':d.kind||'device';
  const alt=screen?'显示器示意':'设备示意';
  return `<span class="device-photo${key?'':' fallback'}">${key?`<img src="assets/${key}.png" alt="${alt}" loading="lazy">`:`<img src="assets/${fallback}.svg" alt="${alt}" loading="lazy">`}</span>`;
}
function badge(name,style='green'){return `<span class="tag${style==='green'?'':' '+style}">${safe(name)}</span>`;}
function displayType(d){return ({'built-in':'内置','external':'外接'})[d.displayConnection]||'类型未知';}
function displayBadge(d){return d.category==='display'?`<span class="display-connection">${displayType(d)}</span>`:'';}
function battery(pct){
  const level=Number(String(pct).replace(/%$/,''));
  if(!Number.isFinite(level)||level<0||level>100)return '';
  return `<span class="battery-val">${level}%</span><span class="battery-indicator${level<=20?' low':''}" style="--battery-level:${level/100}" aria-label="电量 ${level}%"></span>`;
}
function row(d,opts={}){
  const badges=Array.isArray(d.badges)?d.badges:(d.category==='usb'?[[d.detail||'USB','gray']]:[['已连接','green']]);
  const status=opts.widget?'':(d.category==='usb'?badges.map(([x,s])=>badge(x,s)).join(''):badge('已连接'));
  const meta=opts.widget?`<span class="device-sub">${safe(d.detail||'已连接')}</span>`:'';
  return `<button class="device-row" type="button" data-device="${safe(d.id)}">${photo(d)}<span class="device-name-wrap"><span class="device-name">${safe(d.name)}${displayBadge(d)}</span>${meta}</span>${status}${d.battery?battery(d.battery):''}${!opts.widget?svg('chevron','row-chevron'):''}</button>`;
}
function empty(t){return `<div class="empty">${svg(t==='bluetooth'?'bluetooth':t==='display'?'display':'usb')}<span>当前没有检测到此类设备</span></div>`;}
function filtered(t){return data.devices.filter(d=>d.category===t&&(!search||(d.name+' '+(d.detail||'')).toLowerCase().includes(search.toLowerCase())));}
function panel(title,category,contents,options={}){
  return `<section class="panel ${safe(options.cls||'')}"><header class="panel-top"><span class="section-icon ${category==='bluetooth'?'bt':category==='power'?'power':''}">${svg(category==='events'?'events':category)}</span><strong>${safe(title)}</strong>${options.count!==undefined?`<small>(${options.count})</small>`:''}${options.all?`<button class="viewall" data-view="${category}" type="button">查看全部 ${svg('chevron')}</button>`:''}</header>${contents}</section>`;
}
function listPanel(t,all=false){
  const devices=filtered(t), limit=all?50:t==='bluetooth'?3:4;
  return panel(t==='bluetooth'?'蓝牙设备':'USB 与移动设备',t,
    `<div class="items">${devices.length?devices.slice(0,limit).map(d=>row(d)).join(''):empty(t)}</div>`,
    {cls:'device-panel'+(t==='usb'?' devices-usb':''),count:devices.length,all:!all});
}
function displayPanel(all=false){
  const dev=filtered('display');
  return panel('显示器','display',dev.length?`<div class="screen-grid">${dev.slice(0,all?50:2).map(d=>
    `<button type="button" class="screen-card" data-device="${safe(d.id)}"><span class="screen-photo"><img src="assets/${imgKey(d)||'monitor'}.${imgKey(d)?'png':'svg'}" alt="显示器示意"></span><span class="screen-name">${safe(d.name)}${displayBadge(d)} ${d.role?`<span class="screen-role">${safe(d.role)}</span>`:''}</span><span class="screen-spec">${safe(d.detail||'显示参数未知')}</span></button>`).join('')}</div>`:empty('display'),
    {cls:'display-panel',count:dev.length,all:!all});
}
function powerValues(power){
  const number=value=>{const n=value===null||value===undefined||value===''?null:Number(value);return n!==null&&Number.isFinite(n)?n:null;};
  const watt=value=>{const n=number(value);return n!==null&&Number.isFinite(n)?`${Math.abs(n).toFixed(1)}W`:'未提供';};
  const battery=number(power.batterySideWatts);
  const batteryLabel=battery===null?'电池功率':battery>0?'电池充电':battery<0?'电池放电':'电池待机';
  return {input:watt(power.inputWatts),system:watt(power.systemWatts),battery:watt(power.batterySideWatts),batteryLabel};
}
function powerFlow(power){
  const reading=powerValues(power),battery=Number(power.batterySideWatts);
  if(power.externalConnected===false)return {source:'电池',state:'电池正在放电',detail:''};
  if(power.externalConnected===true){
    if(power.batterySideWatts!=null&&Number.isFinite(battery)&&battery<0)return {source:'混合供电',state:`电池补充供电 ${reading.battery}（估算）`,detail:`电池 ${reading.battery}`};
    if(power.batterySideWatts!=null&&Number.isFinite(battery)&&battery>0)return {source:'外接电源',state:`电池充电 ${reading.battery}（估算）`,detail:`充电 ${reading.battery}`};
    return {source:'外接电源',state:power.charging===false?'电池未充电':power.charging===true?'电池充电功率未提供':'电池状态未提供',detail:power.charging===false?'未充电':''};
  }
  return {source:'未提供',state:'供电状态未提供',detail:''};
}
function powerPanel(all=false){
  const power=data.power||{},isCharging=power.charging===true;
  const reading=powerValues(power),chargingLabel=power.charging===null||power.charging===undefined?'未知':isCharging?'充电中':'未充电';
  const watts=power.adapterWatts==null?'—':String(power.adapterWatts).replace(/[^\d.]/g,'')+'W';
  const src=power.source||'供电设备';
  const vals=[['当前输入（系统报告）',reading.input,false],['整机功耗（系统报告）',reading.system,false],[reading.batteryLabel+'（估算）',reading.battery,isCharging],['适配器规格',watts,false],['充电状态',chargingLabel,isCharging],['线缆能力',power.cableLimitWatts?power.cableLimitWatts+'W':'未知',false]];
  return panel('供电状态','power',`<div class="power-main"><div class="power-source">${photo({name:'MacBook',kind:'laptop',category:'display'})}<span class="source-text">${safe(src)}</span>${badge(chargingLabel)}</div><div class="power-values">${vals.map(([label,value,good])=>`<div class="power-value"><small>${safe(label)}</small><strong class="${good?'good':''}">${safe(value)}</strong></div>`).join('')}</div><div class="power-note">${svg('info')}${safe(power.note||'系统未提供当前功率，适配器规格不代表实时输入功率。')}</div></div>`,{cls:'power-panel',all:!all});
}
function eventsPanel(all=false){
  const events=data.events||[];
  const labels={usb:'USB',bluetooth:'蓝牙',display:'显示器',power:'供电'};
  return panel('最近事件','events',events.length?events.slice(0,all?50:4).map(e=>
    `<div class="event-row"><span class="event-dot ${e.category==='display'?'blue':e.category==='power'?'orange':e.category==='bluetooth'?'gray':''}"></span><time class="event-time">${formattedTime(e.at)}</time><span class="event-message">${safe(e.name)}</span><span class="event-type">${safe(labels[e.category]||'设备')}</span></div>`).join(''):empty('events'),{cls:'events-panel',all:!all});
}
function statView(){
  const counts=[['全部设备',data.devices.length,'overview',''],['蓝牙设备',count('bluetooth'),'bluetooth','bt'],['USB 设备',count('usb'),'usb','usb'],['显示器',count('display'),'display','display'],['异常设备',data.previewAnomalies||0,'warning','warning']];
  return `<section class="stats">${counts.map(([name,n,key,variant])=>`<button type="button" class="stat" data-view="${key==='warning'?'events':key}"><span class="stat-icon ${variant}">${svg(key==='warning'?'warning':key)}</span><span class="stat-text"><span class="stat-label">${safe(name)}</span><span class="stat-val">${n}</span></span>${svg('chevron','stat-arrow')}</button>`).join('')}</section>`;
}
function details(d){
  const fields=d.category==='display'?
    [['屏幕类型',displayType(d)],['设备名称',d.name],['像素分辨率',d.pixelResolution||'未提供'],['界面逻辑尺寸',d.logicalResolution||'未提供'],['刷新率',d.refreshRate||'未提供']]:
    [['连接类型',label[d.category]||d.category],['设备名称',d.name],['当前电量',d.battery||'未提供'],['系统详情',d.detail||'未提供'],['厂商 ID',d.vendor||'未提供'],['产品 ID',d.productId||'未提供']];
  return `<section class="panel detail-panel"><button class="back-button" data-back="1" type="button">${svg('chevron')} 返回设备列表</button><div class="detail-head">${photo(d)}<div><h2>${safe(d.name)}${displayBadge(d)}</h2><p class="description">${safe(d.detail||'系统未提供设备描述')}</p>${badge('已连接')}</div></div><div class="detail-grid">${fields.map(([name,value])=>`<div class="detail-cell"><small>${safe(name)}</small><strong>${safe(value)}</strong></div>`).join('')}</div></section>`;
}
function contentView(){
  if(chosen)return details(chosen);
  if(view==='overview')return `<div class="card-grid">${listPanel('bluetooth')}${listPanel('usb')}${displayPanel()}${powerPanel()}${eventsPanel()}</div>`;
  if(view==='bluetooth'||view==='usb')return `<div class="card-grid">${listPanel(view,true)}</div>`;
  if(view==='display')return `<div class="card-grid">${displayPanel(true)}</div>`;
  if(view==='power')return `<div class="card-grid">${powerPanel(true)}</div>`;
  if(view==='events')return `<div class="card-grid">${eventsPanel(true)}</div>`;
  return `<section class="panel"><p class="description">显示设置和图片匹配选项将在这里提供。</p></section>`;
}
function mainView(){
  const menus=[['overview','概览'],['bluetooth','蓝牙设备'],['usb','USB 与移动设备'],['display','显示器'],['power','供电'],['events','历史事件'],['settings','设置']];
  return `<div class="app-layout"><aside class="sidebar"><div class="window-dots" aria-hidden="true"><i></i><i></i><i></i></div><div class="brand"><span class="brand-mark">${svg('overview')}</span>FlowHub</div><nav class="navigation" aria-label="设备分类">${menus.map(([key,title])=>`<button class="nav-item ${view===key?'selected':''}" type="button" data-view="${key}">${svg(key)} ${title}</button>`).join('')}</nav><div class="nav-bottom">${svg('settings')}<span>外设中心<br>v0.2.4</span></div></aside><main class="content"><header class="main-header"><div class="main-identity"><span class="header-mark">${svg('overview')}</span><div><h1>${chosen?'设备详情':view==='overview'?'外设中心':label[view]}</h1><p class="description">查看当前连接的蓝牙、USB、显示器与供电状态</p></div></div><div class="top-controls"><label class="search-control">${svg('search')}<input id="search" type="search" placeholder="搜索设备…" value="${safe(search)}" aria-label="搜索设备"></label><button class="icon-control" id="refresh" aria-label="刷新设备">${svg('refresh')}</button><button class="icon-control" aria-label="更多选项" data-view="settings">${svg('dots')}</button></div></header>${!preview&&data.error?`<div class="warning-message">设备读取失败：${safe(data.error)}</div>`:''}${statView()}${contentView()}</main></div>${preview?'<span class="preview-tag">演示数据 · 仅供视觉验收</span>':''}`;
}
function widgetView(){
  const config=widgetContext?.config||{},limit=[3,5,8].includes(Number(config.limit))?Number(config.limit):3;
  const devices=data.devices.filter(d=>d.status==='connected'),s=devices.slice(0,limit),w=data.power||{};
  const title=String(config.title||'外设中心').slice(0,40),stale=data.stale||Boolean(data.error);
  const status=!preview&&stale?`<p class="warning-message" role="status">${data.error?'设备读取失败：'+safe(data.error):'设备状态已过期'}，以下为上次采集结果。</p>`:'';
  const heading=stale?'上次连接设备':'当前连接设备';
  const shown=s.length<devices.length?` · 显示 ${s.length}/${devices.length}`:'';
  const reading=powerValues(w),flow=powerFlow(w);
  const powerError=w.telemetryError?`<p class="warning-message" role="status">当前功率读取失败：${safe(w.telemetryError)}</p>`:'';
  return `<main class="widget"><header class="widget-head"><span class="brand-mark">${svg('overview')}</span><strong>${safe(title)}</strong><button class="icon-control more" id="widgetOpen" type="button" aria-label="打开外设中心">${svg('dots')}</button></header>${status}<div class="widget-counts">${[['全部',devices.length,'overview'],['蓝牙',devices.filter(d=>d.category==='bluetooth').length,'bluetooth'],['USB',devices.filter(d=>d.category==='usb').length,'usb'],['显示器',devices.filter(d=>d.category==='display').length,'display']].map(([title,value,key])=>`<div class="widget-metric">${svg(key)}<span>${safe(title)}</span><strong>${value}</strong></div>`).join('')}</div><button type="button" class="widget-power" id="widgetPower" aria-label="查看供电详情" title="${safe(w.note||'查看输入功率、电池充放电与适配器详情')}"><span class="widget-power-metric"><span>整机耗电</span><strong>${reading.system}</strong></span><span class="widget-power-metric"><span>供电来源</span><span class="widget-source-value" title="${safe(flow.state)}"><strong>${flow.source}</strong>${flow.detail?`<small>${safe(flow.detail)}</small>`:''}</span></span></button>${powerError}<p class="widget-section">${heading}${shown}</p>${s.length?s.map(d=>row(d,{widget:true})).join(''):'<p class="empty">当前没有检测到已连接设备</p>'}</main>${preview?'<span class="preview-tag">演示数据</span>':''}`;
}
function editorView(){const conf=widgetContext?.config||{};return `<main class="editor"><h1>桌面组件</h1><label>组件名称<input id="widget-title" maxlength="40" value="${safe(conf.title||'外设中心')}"></label><label>显示数量<select id="widget-limit">${[3,5,8].map(n=>`<option value="${n}" ${Number(conf.limit||3)===n?'selected':''}>${n} 个</option>`).join('')}</select></label><label>功率采样间隔<select id="widget-interval">${powerIntervals.map(n=>`<option value="${n}" ${powerInterval()===n?'selected':''}>${n} 秒</option>`).join('')}</select></label></main>`;}
function redraw(){
  if(done)return;
  node.innerHTML=surface==='editor'?editorView():surface==='card'?widgetView():mainView();
  node.querySelectorAll('[data-view]').forEach(btn=>btn.addEventListener('click',()=>{view=btn.dataset.view;chosen=null;search='';redraw();}));
  node.querySelectorAll('[data-device]').forEach(btn=>btn.addEventListener('click',()=>{
    const d=data.devices.find(x=>x.id===btn.dataset.device);if(!d)return;
    if(isWidget){if(!preview&&widgetToken)window.parent.postMessage({type:'flowhub:widget-navigate',token:widgetToken,action:'detail',selection:{deviceId:d.id}},'*');}
    else{chosen=d;redraw();}
  }));
  node.querySelector('[data-back]')?.addEventListener('click',()=>{chosen=null;redraw();});
  node.querySelector('#refresh')?.addEventListener('click',()=>void refresh(true));
  node.querySelector('#search')?.addEventListener('input',e=>{search=e.target.value;const sel=e.target.selectionStart;redraw();const field=node.querySelector('#search');field?.focus();field?.setSelectionRange(sel,sel);});
  node.querySelector('#widgetOpen')?.addEventListener('click',()=>{if(!preview&&widgetToken)window.parent.postMessage({type:'flowhub:widget-navigate',token:widgetToken,action:'detail',selection:{}},'*');});
  node.querySelector('#widgetPower')?.addEventListener('click',()=>{if(!preview&&widgetToken)window.parent.postMessage({type:'flowhub:widget-navigate',token:widgetToken,action:'detail',selection:{view:'power'}},'*');});
  for(const img of node.querySelectorAll('img'))img.addEventListener('error',()=>{img.replaceWith(document.createTextNode('◇'));},{once:true});
  if(isWidget&&widgetToken&&widgetReady){window.parent.postMessage({type:'flowhub:widget-size',token:widgetToken,height:Math.ceil(document.documentElement.scrollHeight)},'*');}
}
function rpc(method){
  if(preview)return Promise.resolve(demo);
  const id='dc-preview-'+Date.now()+'-'+Math.random().toString(16).slice(2);
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('设备响应超时'));},44000);
    pending.set(id,{resolve,reject,timer});
    const params={powerIntervalSeconds:powerInterval()};
    const msg=isWidget?{type:'flowhub:widget-rpc',id,token:widgetToken,params:{action:'management',method,params}}:{type:'flowhub:request',id,method,params};
    window.parent.postMessage(msg,'*');
  });
}
async function refresh(force=false){
  if(done||loading)return;
  loading=true;
  try{const next=await rpc(force?'refresh':'snapshot');if(!done&&Array.isArray(next.devices)){data=next;if(surface==='detail'&&widgetSelectedId)chosen=data.devices.find(d=>d.id===widgetSelectedId)||null;redraw();}}
  catch(err){if(!done){data={...data,error:String(err),stale:true};redraw();}}
  finally{loading=false;}
}
function startPolling(){
  clearInterval(poll);
  if(surface==='editor'||preview)return;
  poll=setInterval(()=>{if(!document.hidden&&(!isWidget||widgetReady))void refresh();},powerInterval()*1000);
}
function receive(event){
  if(done||event.source!==window.parent)return;
  const msg=event.data;
  if(!msg||typeof msg!=='object'||isWidget&&widgetToken&&msg.token!==widgetToken)return;
  if(isWidget&&msg.type==='flowhub:widget-init'){
    widgetReady=true;widgetContext=msg.context||{};
    if(surface==='detail'){widgetSelectedId=widgetContext.selection?.deviceId||widgetContext.config?.selection?.deviceId||null;view=widgetContext.selection?.view==='power'?'power':'overview';}
    redraw();startPolling();if(surface!=='editor')void refresh();return;
  }
  if(isWidget&&msg.type==='flowhub:widget-save'){
    const interval=Number(node.querySelector('#widget-interval')?.value||5);
    const config={title:String(node.querySelector('#widget-title')?.value||'外设中心').slice(0,40),limit:Number(node.querySelector('#widget-limit')?.value||3),powerIntervalSeconds:powerIntervals.includes(interval)?interval:5};
    window.parent.postMessage({type:'flowhub:widget-config',id:msg.id,token:widgetToken,config},'*');return;
  }
  if(msg.type===(isWidget?'flowhub:widget-result':'flowhub:response')){
    const entry=pending.get(msg.id);if(!entry)return;
    pending.delete(msg.id);clearTimeout(entry.timer);
    if(msg.error)entry.reject(new Error(String(msg.error)));else entry.resolve(msg.result);
  }
}
window.addEventListener('message',receive);
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&chosen){chosen=null;redraw();}});
redraw();
if(isWidget&&hostWindow&&widgetToken)window.parent.postMessage({type:'flowhub:widget-ready',token:widgetToken},'*');
else if(!preview)void refresh();
if(!isWidget)startPolling();
window.addEventListener('pagehide',()=>{done=true;clearInterval(poll);window.removeEventListener('message',receive);for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(Error('页面已关闭'));}pending.clear();},{once:true});
})();
