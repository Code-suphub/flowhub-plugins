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
let loading=false,done=false,widgetContext={},widgetReady=false;
const pending=new Map();
let poll=null;
let widgetCategory='overview';
const widgetScroll={};
const orderTools=window.FlowHubDeviceOrder;
let orderDraft=null,orderSaving=false,orderError='',orderNotice='',drag=null,dragFrame=null;
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
  grip:'<circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/>',
  headset:'<path d="M4 13v-2a8 8 0 0 1 16 0v2M4 13h4v7H6a2 2 0 0 1-2-2v-5Zm16 0h-4v7h2a2 2 0 0 0 2-2v-5Z"/>',
  device:'<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>'
};
const svg=(name,cls='')=>`<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${paths[name]||paths.device}</svg>`;
const safe=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const label={overview:'概览',bluetooth:'蓝牙设备',usb:'USB 与移动设备',display:'显示器',adb:'ADB',power:'供电',events:'历史事件',settings:'设置'};
const adbState=state=>({device:'已连接',unauthorized:'未授权',offline:'离线','no permissions':'权限不足',recovery:'Recovery',sideload:'Sideload',bootloader:'Bootloader',connecting:'连接中',authorizing:'授权中'})[state]||state||'状态未提供';
const adbTransport=transport=>({usb:'USB',tcp:'TCP/IP',wireless:'无线调试',emulator:'模拟器'})[transport]||'连接方式未提供';
const demo={
  at:Date.now(),stale:false,
  devices:[
    {id:'a',name:'AirPods Pro 2',category:'bluetooth',kind:'headphones',detail:'音频设备',battery:'82%',status:'connected',badges:[['已连接','green']]},
    {id:'b',name:'Magic Mouse',category:'bluetooth',kind:'mouse',detail:'鼠标',battery:'67%',status:'connected',badges:[['已连接','green']]},
    {id:'c',name:'Keychron K3',category:'bluetooth',kind:'keyboard',detail:'键盘',battery:'100%',status:'connected',badges:[['已连接','green']]},
    {id:'d',name:'Pixel 9 Pro',category:'usb',kind:'phone',detail:'USB-C',status:'connected'},
    {id:'e',name:'iPhone 15',category:'usb',kind:'phone',detail:'USB',status:'connected'},
    {id:'f',name:'Samsung T7 SSD',category:'usb',kind:'drive',detail:'USB 3.2 Gen 2 · 10 Gbps',status:'connected',badges:[['USB 3.2 Gen 2','gray'],['10 Gbps','gray']]},
    {id:'g',name:'SD Card Reader',category:'usb',kind:'hub',detail:'USB',status:'connected',badges:[['已连接','green']]},
    {id:'h',name:'DELL U2723QE',category:'display',kind:'monitor',pixelResolution:'3840 × 2160',refreshRate:'60 Hz',detail:'3840 × 2160 · 60 Hz',status:'connected',role:'主显示器'},
    {id:'i',name:'LG UltraFine',category:'display',kind:'monitor',pixelResolution:'2560 × 1440',refreshRate:'60 Hz',detail:'2560 × 1440 · 60 Hz',status:'connected',role:'竖屏'}
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
function photo(d){const known=['headphones','mouse','keyboard','phone','drive','hub','device','laptop'];const kind=d.category==='display'?'monitor':known.includes(d.kind)?d.kind:'device';return '<span class="device-photo"><img src="assets/'+kind+'.svg" alt="设备类别图标" loading="lazy"></span>';}
function displayType(d){return ({'built-in':'内置','external':'外接'})[d.displayConnection]||'类型未知';}
function displayBadge(d){return d.category==='display'?`<span class="display-connection">${displayType(d)}</span>`:'';}
function displaySpec(d){
  if(d.category!=='display'||!d.pixelResolution)return d.detail||'';
  const dimensions=String(d.pixelResolution).match(/^(\d+)\s*[×xX]\s*(\d+)$/);
  // Use exact pixel pairs, including portrait orientation; never classify the
  // Retina logical size or guess a class from just one dimension.
  const key=dimensions?dimensions.slice(1).map(Number).sort((a,b)=>b-a).join('x'):'';
  const names={'1280x720':'720P','1920x1080':'1080P','2560x1440':'2K',
    '3840x2160':'4K','4096x2160':'4K','5120x2880':'5K','6016x3384':'6K',
    '6144x3456':'6K','7680x4320':'8K'};
  return [names[key]||d.pixelResolution,d.refreshRate].filter(Boolean).join(' · ');
}
function battery(pct){
  const level=Number(String(pct).replace(/%$/,''));
  if(!Number.isFinite(level)||level<0||level>100)return '';
  return `<span class="battery-val">${level}%</span><span class="battery-indicator${level<=20?' low':''}" style="--battery-level:${level/100}" aria-label="电量 ${level}%"></span>`;
}
function row(d,position,total){
 const cached=d.adb&&(!data.adb?.at||data.adb.stale||data.adb.error);
 const description=d.adb?[(cached?'上次 · ':'')+adbState(d.adb.state),adbTransport(d.adb.transport),d.adb.serial].join(' · '):displaySpec(d)||'已连接';
 return '<div class="device-row" role="listitem" aria-posinset="'+position+'" aria-setsize="'+total+'" data-order-item="'+safe(d.id)+'"><button class="device-open" type="button" data-device="'+safe(d.id)+'">'+photo(d)+'<span class="device-name-wrap"><span class="device-name">'+safe(d.name)+displayBadge(d)+'</span><span class="device-sub">'+safe(description)+'</span></span>'+(d.battery?battery(d.battery):'')+'</button><button class="device-order-handle" type="button" data-order-handle="'+safe(d.id)+'" aria-label="调整 '+safe(d.name)+' 的顺序" aria-description="拖动排序，也可使用上下方向键移动，Home 和 End 移到首尾" title="拖动排序，或用上下方向键移动"'+(preview||orderSaving||orderDraft?' disabled':'')+'>'+svg('grip')+'</button></div>';
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
  const external=typeof power.externalConnected==='boolean'?power.externalConnected:['外接电源','AC Power','UPS'].includes(power.source)?true:['电池供电','Battery Power'].includes(power.source)?false:null;
  if(power.source==='UPS')return {source:'UPS',state:'UPS 供电',detail:''};
  if(external===false)return {source:'电池',state:'电池正在放电',detail:''};
  if(external===true){
    if(power.batteryPresent===false)return {source:'外接电源',state:'交流电供电，无内置电池',detail:''};
    if(power.batterySideWatts!=null&&Number.isFinite(battery)&&battery<0)return {source:'混合供电',state:`电池补充供电 ${reading.battery}（估算）`,detail:`电池 ${reading.battery}`};
    if(power.batterySideWatts!=null&&Number.isFinite(battery)&&battery>0)return {source:'外接电源',state:`电池充电 ${reading.battery}（估算）`,detail:`充电 ${reading.battery}`};
    return {source:'外接电源',state:power.charging===false?'电池未充电':power.charging===true?'电池充电功率未提供':'电池状态未提供',detail:power.charging===false?'未充电':''};
  }
  return {source:'未提供',state:power.powerSourceError||'供电状态未提供',detail:''};
}
function widgetView(){
  const config=widgetContext?.config||{};
  const devices=orderTools.sort(data.devices.filter(d=>d.category==='adb'||d.status==='connected'),orderDraft||data.widgetOrder?.ids||[]);
  const filtered=widgetCategory==='overview'?devices:devices.filter(d=>d.category===widgetCategory);
  const s=filtered,w=data.power||{};
  const title=String(config.title||'外设中心').slice(0,40),stale=widgetCategory==='adb'?(!data.adb?.at||data.adb.stale||Boolean(data.adb.error)):data.stale||Boolean(data.error),error=widgetCategory==='adb'?data.adb?.error:data.error;
  const status=!preview&&stale?`<p class="warning-message" role="status">${error?'设备读取失败：'+safe(error):'设备状态已过期'}，以下为上次采集结果。</p>`:'';
  const heading=(stale?'上次':'当前')+(filtered.some(d=>d.category==='adb')?'设备记录':'连接设备')+(widgetCategory==='overview'?'':` · ${label[widgetCategory]}`);
  const shown=` · ${filtered.length} 个`;
  const reading=powerValues(w),flow=powerFlow(w);
  const powerError=w.telemetryError?`<p class="warning-message" role="status">当前功率读取失败：${safe(w.telemetryError)}</p>`:'';
  const counts=[['全部',devices.length,'overview'],['蓝牙',devices.filter(d=>d.category==='bluetooth').length,'bluetooth'],['USB',devices.filter(d=>d.category==='usb').length,'usb'],['显示器',devices.filter(d=>d.category==='display').length,'display'],['ADB',devices.filter(d=>d.category==='adb').length,'adb']];
  const filters=counts.map(([title,value,key])=>`<button type="button" class="widget-metric" data-widget-category="${key}" aria-pressed="${widgetCategory===key}" aria-label="查看${title}设备">${svg(key)}<span>${safe(title)}</span><strong>${value}</strong></button>`).join('');
  const items=s.length?s.map((d,index)=>row(d,index+1,s.length)).join(''):`<p class="empty">${widgetCategory==='overview'?'当前没有检测到已连接设备':'当前分类没有检测到已连接设备'}</p>`;
  const issue=orderError||data.widgetOrder?.error;
  const orderStatus=issue?`<div class="widget-order-error" role="alert">${safe(issue)}${orderDraft&&!orderSaving?'<div><button id="widgetOrderRetry" type="button">重试保存</button><button id="widgetOrderDiscard" type="button">撤销排序</button></div>':''}</div>`:'';
  return `<main class="widget"><header class="widget-head"><span class="brand-mark">${svg('overview')}</span><strong>${safe(title)}</strong><button class="icon-control more" id="widgetOpen" type="button" aria-label="打开外设中心">${svg('dots')}</button></header>${status}<div class="widget-counts">${filters}</div><button type="button" class="widget-power" id="widgetPower" aria-label="查看供电详情" title="${safe(w.powerUnavailableReason||w.note||'查看输入功率、电池充放电与适配器详情')}"><span class="widget-power-metric"><span>整机耗电</span><strong>${reading.system}</strong></span><span class="widget-power-metric"><span>供电来源</span><span class="widget-source-value" title="${safe(flow.state)}"><strong>${flow.source}</strong>${flow.detail?`<small>${safe(flow.detail)}</small>`:''}</span></span></button>${powerError}<div class="widget-section"><span>${heading}${shown}</span><span class="widget-order-notice" role="status">${safe(orderNotice)}</span></div>${orderStatus}<div class="widget-device-list" data-widget-list-category="${widgetCategory}" role="list" aria-label="设备列表">${items}</div></main>${preview?'<span class="preview-tag">演示数据</span>':''}`;
}
function editorView(){const conf=widgetContext?.config||{};return `<main class="editor"><h1>桌面组件</h1><label>组件名称<input id="widget-title" maxlength="40" value="${safe(conf.title||'外设中心')}"></label><label>功率采样间隔<select id="widget-interval">${powerIntervals.map(n=>`<option value="${n}" ${powerInterval()===n?'selected':''}>${n} 秒</option>`).join('')}</select></label></main>`;}
function redraw(focusId,ensureVisible=false){
  if(done||drag)return;
  const previousList=node.querySelector('.widget-device-list');
  if(previousList?.dataset?.widgetListCategory)widgetScroll[previousList.dataset.widgetListCategory]=previousList.scrollTop;
  const active=document.hasFocus?.()?document.activeElement:null;
  const ownFocus=focusId&&(!active||active===document.body||active.dataset?.orderHandle===focusId);
  const focus=ownFocus?{handle:focusId}:active?.dataset?.orderHandle?{handle:active.dataset.orderHandle}:active?.dataset?.device?{device:active.dataset.device}:active?.dataset?.widgetCategory?{category:active.dataset.widgetCategory}:null;
  node.innerHTML=surface==='editor'?editorView():widgetView();
  node.querySelectorAll('[data-widget-category]').forEach(btn=>btn.addEventListener('click',()=>{widgetCategory=btn.dataset.widgetCategory;redraw();}));
  const widgetList=node.querySelector('.widget-device-list'),category=widgetCategory;
  if(widgetList){widgetList.scrollTop=widgetScroll[category]||0;widgetList.addEventListener('scroll',()=>{widgetScroll[category]=widgetList.scrollTop;},{passive:true});}
  node.querySelectorAll('[data-device]').forEach(btn=>btn.addEventListener('click',()=>{
    const d=data.devices.find(x=>x.id===btn.dataset.device);if(!d)return;
    if(isWidget){if(!preview&&widgetToken)window.parent.postMessage({type:'flowhub:widget-navigate',token:widgetToken,action:'detail',selection:{deviceId:d.id}},'*');}
  }));
  node.querySelector('#widgetOpen')?.addEventListener('click',()=>{if(!preview&&widgetToken)window.parent.postMessage({type:'flowhub:widget-navigate',token:widgetToken,action:'detail',selection:{view:widgetCategory}},'*');});
  node.querySelector('#widgetPower')?.addEventListener('click',()=>{if(!preview&&widgetToken)window.parent.postMessage({type:'flowhub:widget-navigate',token:widgetToken,action:'detail',selection:{view:'power'}},'*');});
  node.querySelector('#widgetOrderRetry')?.addEventListener('click',()=>{if(orderDraft)void saveOrder(orderDraft);});
  node.querySelector('#widgetOrderDiscard')?.addEventListener('click',()=>{orderDraft=null;orderError='';orderNotice='';redraw();});
  bindOrder(widgetList);
  if(focus&&document.hasFocus?.()){
    const selector=focus.handle?'[data-order-handle]':focus.device?'[data-device]':'[data-widget-category]';
    const target=[...node.querySelectorAll(selector)].find(el=>(el.dataset.orderHandle||el.dataset.device||el.dataset.widgetCategory)===(focus.handle||focus.device||focus.category));
    target?.focus({preventScroll:true});
    if(ensureVisible&&ownFocus){target?.scrollIntoView({block:'nearest'});if(widgetList)widgetScroll[widgetCategory]=widgetList.scrollTop;}
  }
  for(const img of node.querySelectorAll('img'))img.addEventListener('error',()=>{img.replaceWith(document.createTextNode('◇'));},{once:true});
  if(isWidget&&widgetToken&&widgetReady){window.parent.postMessage({type:'flowhub:widget-size',token:widgetToken,height:Math.ceil(document.documentElement.scrollHeight)},'*');}
}
function rpc(method,extra={}){
  if(preview)return Promise.resolve(demo);
  const id='dc-preview-'+Date.now()+'-'+Math.random().toString(16).slice(2);
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('设备响应超时'));},44000);
    pending.set(id,{resolve,reject,timer});
    const params={...extra,powerIntervalSeconds:powerInterval()};
    const msg=isWidget?{type:'flowhub:widget-rpc',id,token:widgetToken,params:{action:'management',method,params}}:{type:'flowhub:request',id,method,params};
    window.parent.postMessage(msg,'*');
  });
}
async function saveOrder(ids,focusId,ensureVisible=false){
  if(preview||orderSaving)return;
  orderDraft=ids;orderSaving=true;orderError='';orderNotice='保存中…';redraw(focusId,ensureVisible);
  try{
    const result=await rpc('widget_order_set',{ids,expectedRevision:data.widgetOrder?.revision||0});
    if(done)return;
    data={...data,widgetOrder:result};orderDraft=null;orderNotice='顺序已保存';
  }catch(error){
    if(done)return;
    orderError=String(error);orderNotice='尚未保存';
    // A timeout can happen after a successful write. Read back before offering
    // a retry; never blindly repeat a preference write with an old revision.
    try{const next=await rpc('snapshot');if(!done&&Array.isArray(next.devices)){data=next;if(JSON.stringify(data.widgetOrder?.ids)===JSON.stringify(ids)){orderDraft=null;orderError='';orderNotice='顺序已保存';}}}catch{}
  }finally{orderSaving=false;if(!done)redraw(focusId);}
}
function moveDevice(source,target,after=false,ensureVisible=false){
  if(preview||orderSaving||orderDraft)return false;
  const order=orderTools.merge(data.widgetOrder?.ids||[],data.devices);
  const next=orderTools.move(order,source,target,after);
  if(JSON.stringify(next)===JSON.stringify(order))return false;
  void saveOrder(next,source,ensureVisible);return true;
}
function endDrag(){
  if(dragFrame!==null){cancelAnimationFrame(dragFrame);dragFrame=null;}
  const previous=drag;drag=null;
  try{if(previous?.handle.hasPointerCapture(previous.pointerId))previous.handle.releasePointerCapture(previous.pointerId);}catch{}
  node.querySelector('.widget')?.classList.remove('is-order-dragging');
}
function dragPosition(list,x,y){
  if(!drag)return;
  drag.x=x;
  drag.y=y;
  const bounds=list.getBoundingClientRect();
  const inside=x>=bounds.left&&x<=bounds.right&&y>=bounds.top&&y<=bounds.bottom;
  let row=inside?document.elementFromPoint(x,y)?.closest('[data-order-item]'):null;
  if(inside&&!row){
    const first=list.firstElementChild,last=list.lastElementChild;
    if(first&&y<first.getBoundingClientRect().top)row=first;
    else if(last&&y>last.getBoundingClientRect().bottom)row=last;
  }
  let after=false;
  if(row?.dataset.orderItem){
    const rect=row.getBoundingClientRect();
    after=y>=rect.top+rect.height/2;
    // Both sides of a shared gap anchor to the top of the same row.
    if(after&&row.nextElementSibling){
      row=row.nextElementSibling;
      after=false;
    }
    // Gaps immediately before and after the source both leave it in place.
    if(row===drag.sourceRow||(!after&&row.previousElementSibling===drag.sourceRow))row=null;
  }else{
    row=null;
  }
  if(row!==drag.target||after!==drag.after){
    drag.target?.removeAttribute('data-drop');
    if(row)row.dataset.drop=after?'after':'before';
    drag.target=row;
    drag.after=after;
  }
  drag.scroll=!inside?0:y<bounds.top+24?-6:y>bounds.bottom-24?6:0;
}
function scrollDrag(list){
  if(dragFrame!==null||!drag?.scroll)return;
  const scroll=()=>{dragFrame=null;if(!drag?.scroll)return;const before=list.scrollTop;list.scrollTop+=drag.scroll;if(list.scrollTop!==before){dragPosition(list,drag.x,drag.y);if(drag?.scroll)dragFrame=requestAnimationFrame(scroll);}};
  dragFrame=requestAnimationFrame(scroll);
}
function movePointer(event){
  if(!drag||event.pointerId!==drag.pointerId)return;
  if(!drag.moved&&Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)<5)return;
  event.preventDefault();
  event.stopPropagation();
  if(!drag.moved){
    drag.moved=true;
    drag.sourceRow.classList.add('is-dragging');
    node.querySelector('.widget')?.classList.add('is-order-dragging');
  }
  dragPosition(drag.list,event.clientX,event.clientY);scrollDrag(drag.list);
}
function finishPointer(event){
  if(!drag||event.pointerId!==drag.pointerId)return;
  event.preventDefault();event.stopPropagation();if(drag.moved)dragPosition(drag.list,event.clientX,event.clientY);
  const {id,target,after,moved}=drag;endDrag();
  if(!moved||!target||!moveDevice(id,target.dataset.orderItem,after))redraw(id);
}
function cancelPointer(){if(drag){const id=drag.id;endDrag();redraw(id);}}
function leaveWidget(event){if(!event.relatedTarget)cancelPointer();}
function bindOrder(list){
  if(!list)return;
  for(const handle of node.querySelectorAll('[data-order-handle]')){
    handle.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&drag){event.preventDefault();event.stopPropagation();endDrag();redraw(handle.dataset.orderHandle);return;}
      if(preview||orderSaving||orderDraft||event.isComposing||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
      if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
      event.preventDefault();event.stopPropagation();
      if(event.repeat)return;
      const keys=[...node.querySelectorAll('[data-order-item]')].map(el=>el.dataset.orderItem),id=handle.dataset.orderHandle,index=keys.indexOf(id);
      const target=event.key==='Home'?0:event.key==='End'?keys.length-1:event.key==='ArrowUp'?index-1:index+1;
      if(keys[target])moveDevice(id,keys[target],event.key==='ArrowDown'||event.key==='End',true);
    });
    handle.addEventListener('pointerdown',event=>{
      if(preview||orderSaving||orderDraft||drag||event.button!==0||!event.isPrimary)return;
      event.preventDefault();event.stopPropagation();handle.focus({preventScroll:true});
      drag={
        id:handle.dataset.orderHandle,handle,list,sourceRow:handle.closest('[data-order-item]'),
        pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,
        target:null,after:false,scroll:0,moved:false
      };
      handle.setPointerCapture(event.pointerId);
    });
    for(const type of ['pointercancel','lostpointercapture'])handle.addEventListener(type,cancelPointer);
    handle.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();});
  }
}
async function refresh(force=false){
  if(done||loading)return;
  loading=true;
  try{const next=await rpc(force?'refresh':'snapshot');if(!done&&Array.isArray(next.devices)){data=next;redraw();}}
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
    redraw();startPolling();if(surface!=='editor')void refresh();return;
  }
  if(isWidget&&msg.type==='flowhub:widget-save'){
    const interval=Number(node.querySelector('#widget-interval')?.value||5);
    const config={title:String(node.querySelector('#widget-title')?.value||'外设中心').slice(0,40),limit:'all',powerIntervalSeconds:powerIntervals.includes(interval)?interval:5};
    window.parent.postMessage({type:'flowhub:widget-config',id:msg.id,token:widgetToken,config},'*');return;
  }
  if(msg.type===(isWidget?'flowhub:widget-result':'flowhub:response')){
    const entry=pending.get(msg.id);if(!entry)return;
    pending.delete(msg.id);clearTimeout(entry.timer);
    if(msg.error)entry.reject(new Error(String(msg.error)));else entry.resolve(msg.result);
  }
}
window.addEventListener('message',receive);
document.addEventListener?.('pointermove',movePointer,true);
document.addEventListener?.('pointerup',finishPointer,true);
document.addEventListener?.('pointerout',leaveWidget);
window.addEventListener('blur',cancelPointer);
redraw();
if(isWidget&&hostWindow&&widgetToken)window.parent.postMessage({type:'flowhub:widget-ready',token:widgetToken},'*');
else if(!preview)void refresh();
if(!isWidget)startPolling();
window.addEventListener('pagehide',()=>{done=true;endDrag();clearInterval(poll);window.removeEventListener('message',receive);window.removeEventListener('blur',cancelPointer);document.removeEventListener?.('pointermove',movePointer,true);document.removeEventListener?.('pointerup',finishPointer,true);document.removeEventListener?.('pointerout',leaveWidget);for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(Error('页面已关闭'));}pending.clear();},{once:true});
})();
