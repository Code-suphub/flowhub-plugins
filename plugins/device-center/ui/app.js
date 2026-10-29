(() => {
'use strict';

const root = document.getElementById('app');
const surface = document.body.dataset.surface || 'main';
const widget = surface !== 'main';
const embedded = window.parent !== window;
const token = new URLSearchParams(location.hash.slice(1)).get('flowhubWidgetToken');
const preview = !embedded || (widget && !token);
const menus = [
  ['all','概览','grid'],
  ['bluetooth','蓝牙','bluetooth'],
  ['usb','USB','usb'],
  ['display','显示器','monitor'],
  ['power','供电','zap'],
  ['events','连接记录','clock']
];
const categories = {bluetooth:'蓝牙设备',usb:'USB 与移动设备',display:'显示器'};
const paths = {
  grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  bluetooth:'<path d="m7 7 10 10-5 4V3l5 4L7 17"/>',
  usb:'<path d="M12 19V3m-4 4 4-4 4 4M6 19a3 3 0 0 0 3-3v-2m3-3 5 5m0 0h3v3h-3v-3M9 14H5v-3h4v3Zm3 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"/>',
  monitor:'<rect x="2" y="3" width="20" height="15" rx="2"/><path d="M8 22h8m-4-4v4"/>',
  zap:'<path d="m13 2-9 12h7l-1 8 10-12h-7l0-8Z"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.5 8A7 7 0 0 1 19 7l1 5M4 12l1 5a7 7 0 0 0 12.5-1"/>',
  search:'<circle cx="10.8" cy="10.8" r="6.5"/><path d="m16 16 5 5"/>',
  chevron:'<path d="m9 6 6 6-6 6"/>',
  arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',
  battery:'<rect x="2" y="7" width="18" height="10" rx="2"/><path d="M22 10v4M5 10h11v4H5Z"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  close:'<path d="M5 5l14 14M19 5 5 19"/>',
  plug:'<path d="M8 3v6m8-6v6M6 9h12v3a6 6 0 0 1-12 0V9Zm6 9v4"/>',
  check:'<path d="m4 12 5 5L20 6"/>',
  alert:'<path d="M12 3 2 20h20L12 3Z"/><path d="M12 9v4m0 3v.01"/>',
  device:'<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 22h8m-4-4v4"/>',
  headphone:'<path d="M3 14v-3a9 9 0 0 1 18 0v3M3 14h5v7H6a3 3 0 0 1-3-3v-4Zm18 0h-5v7h2a3 3 0 0 0 3-3v-4Z"/>',
  disk:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 15h10m-2-6h2"/>',
  signal:'<path d="M4 16v3m5-8v8m5-13v13m5-9v9"/>'
};
const icon = (name,extra='') =>
  '<svg class="svg-icon '+extra+'" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'+
  (paths[name]||paths.device)+'</svg>';
const esc = value => String(value??'').replace(/[&<>"']/g, x=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
})[x]);
const demo = {
  at:Date.now(),stale:false,
  devices:[
    {id:'demo-b1',name:'AirPods Pro 2',category:'bluetooth',kind:'headphones',battery:'82%',detail:'音频设备'},
    {id:'demo-b2',name:'Magic Mouse',category:'bluetooth',kind:'mouse',battery:'67%',detail:'输入设备'},
    {id:'demo-b3',name:'Keychron K3',category:'bluetooth',kind:'keyboard',battery:'100%',detail:'输入设备'},
    {id:'demo-u1',name:'Pixel 9 Pro',category:'usb',kind:'phone',detail:'USB-C · 调试状态未读取'},
    {id:'demo-u2',name:'iPhone 15',category:'usb',kind:'phone',detail:'USB · 信任状态未读取'},
    {id:'demo-u3',name:'Samsung T7 SSD',category:'usb',kind:'drive',detail:'USB 3.2 · 10 Gb/s'},
    {id:'demo-u4',name:'SD Card Reader',category:'usb',kind:'hub',detail:'USB'},
    {id:'demo-d1',name:'DELL U2723QE',category:'display',kind:'monitor',detail:'3840 × 2160 · 60 Hz'},
    {id:'demo-d2',name:'LG UltraFine',category:'display',kind:'monitor',detail:'2560 × 1440'}
  ],
  power:{adapterWatts:'96',charging:true,source:'AC Power',
    note:'适配器报告功率不是线缆或电池的实时功率'},
  events:[{at:Date.now()-100000,name:'Pixel 9 Pro',action:'connected',category:'usb'},
    {at:Date.now()-720000,name:'DELL U2723QE',action:'connected',category:'display'}]
};
let snapshot=preview?demo:{at:0,stale:true,devices:[],events:[],power:{}};
let status=preview?statusOf(demo):null,context={},view='all',query='',selected=null,busy=false,disposed=false,widgetInitialized=false;
const requests=new Map();
const time = n => n?new Date(n).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'尚未采集';
const amount = type => (snapshot.devices||[]).filter(d=>d.category===type).length;
const formatCount = n => Number.isFinite(n)?String(n):'—';
function statusOf(s) {
  return {at:s.at,stale:!!s.stale,error:s.error||null,count:s.devices.length,
    counts:{bluetooth:s.devices.filter(d=>d.category==='bluetooth').length,
      usb:s.devices.filter(d=>d.category==='usb').length,
      display:s.devices.filter(d=>d.category==='display').length},
    rows:s.devices.map(d=>({id:d.id,name:d.name,category:d.category,kind:d.kind,
      summary:d.detail||categories[d.category]||'设备',battery:d.battery||null}))};
}
function mediaPath(d) {
  const n=(d.name||'').toLowerCase(),detail=(d.detail||'').toLowerCase();
  let file='device.svg';
  if(d.category==='display'||d.kind==='monitor')file=/color lcd|retina|built.in|内建/.test(n+' '+detail)?'laptop.svg':'monitor.svg';
  else if(/airpods|earbud|earphone|小米耳机|buds|入耳/.test(n))file='earbuds.svg';
  else if(/headphone|headset|headphone|耳机|耳麦/.test(n+' '+detail)||d.kind==='headphones')file='headphones.svg';
  else if(d.kind==='mouse'||/mouse|trackpad|鼠标/.test(n))file='mouse.svg';
  else if(d.kind==='keyboard'||/keyboard|keychron|键盘/.test(n))file='keyboard.svg';
  else if(d.kind==='phone'||/iphone|pixel|phone|android|手机/.test(n))file='phone.svg';
  else if(d.kind==='drive'||/ssd|storage|disk|flash|硬盘/.test(n))file='drive.svg';
  else if(d.kind==='hub'||/hub|reader|读卡|扩展坞/.test(n))file='hub.svg';
  else if(/speaker|音箱/.test(n))file='speaker.svg';
  return 'assets/'+file;
}
function media(d) {
  // All paths come from a fixed, package-local allowlist, never remote device metadata.
  return '<span class="media"><img loading="lazy" decoding="async" src="'+mediaPath(d)+'" alt="" /></span>';
}
function categoryName(key) {return categories[key]||'外设';}
function deviceDetail(d) {
  const s=[d.detail||categoryName(d.category),d.battery?'电量 '+d.battery:''].filter(Boolean);
  return s.join(' · ');
}
function row(d,forWidget=false) {
  return '<button type="button" class="device-row" data-device="'+esc(d.id)+'" aria-label="查看 '+esc(d.name)+' 设备详情">'+
    media(d)+'<span class="device-text"><span class="device-name">'+esc(d.name)+'</span>'+
    '<span class="device-sub">'+esc(deviceDetail(d))+'</span></span>'+
    '<span class="device-trailing">'+(d.battery?'<span class="battery">'+icon('battery')+esc(d.battery)+'</span>':
    '<span class="pill">'+icon('check','sm')+'已连接</span>')+
    '</span>'+(forWidget?'':icon('chevron','disclosure'))+'</button>';
}
function panel(key,label,content,options={}) {
  return '<section class="panel '+(options.full?'full':'')+'" aria-label="'+esc(label)+'">'+
    '<div class="panel-head"><div class="panel-title">'+icon(key==='power'?'zap':key==='events'?'clock':key)+
    '<span>'+esc(label)+'</span>'+(options.count!==undefined?'<span class="count">'+options.count+'</span>':'')+
    '</div>'+(options.more?'<button class="more" type="button" data-view="'+esc(key)+'">查看全部 '+icon('chevron')+'</button>':'')+
    '</div>'+content+'</section>';
}
function empty(category) {
  const text = category==='usb'?['没有检测到 USB 外设','USB-C 显示输出、雷电连接不一定会出现在 USB 设备树中']:
    category==='bluetooth'?['当前没有已连接的蓝牙设备','已配对但断开的设备不会统计为已连接']:
    ['没有检测到显示器','系统未返回可识别的显示器数据'];
  return '<div class="empty"><span class="empty-icon">'+icon(category==='usb'?'usb':category==='bluetooth'?'bluetooth':'monitor')+'</span>'+
    '<strong>'+text[0]+'</strong><small>'+text[1]+'</small></div>';
}
function matching(devices) {
  const q=query.trim().toLocaleLowerCase();
  return q?devices.filter(d=>(d.name+' '+(d.detail||'')+' '+(d.vendor||'')).toLocaleLowerCase().includes(q)):devices;
}
function devicePanel(category,limit=100,full=false) {
  const devices=matching(snapshot.devices.filter(d=>d.category===category));
  const items=devices.length?devices.slice(0,limit).map(d=>row(d)).join(''):empty(category);
  return panel(category,categoryName(category),'<div class="device-list">'+items+'</div>',{
    count:devices.length,more:view==='all',full
  });
}
function displayPanel(full=false) {
  const devices=matching(snapshot.devices.filter(d=>d.category==='display'));
  const cards=devices.length?'<div class="display-list">'+devices.slice(0,full?50:4).map(d=>
    '<button type="button" class="display-card" data-device="'+esc(d.id)+'">'+media(d)+
    '<span class="device-text"><span class="device-name">'+esc(d.name)+'</span>'+
    '<span class="device-sub">'+esc(d.detail||'显示参数未提供')+'</span>'+
    '<span class="display-role">'+(/color lcd|retina|built.in|内建/i.test(d.name+' '+(d.detail||''))?'内建显示器':'已连接')+'</span></span>'+
    '</button>'
  ).join('')+'</div>':empty('display');
  return panel('display','显示器',cards,{count:devices.length,more:view==='all',full});
}
function powerPanel(full=false) {
  const p=snapshot.power||{};
  const watts=p.adapterWatts==null||p.adapterWatts===''?null:String(p.adapterWatts).replace(/[^\d.]/g,'');
  const known=watts!==null&&watts.length>0;
  const source=p.source||'';
  const plugged=/AC|adapter|电源|适配器/i.test(source);
  const charging=p.charging===true?'电池充电中':
    p.charging===false?(plugged?'外部供电 · 电池未充电':'电池未充电'):'充电状态未知';
  const facts=[
    ['电池侧实际功率','未测量'],
    ['USB-C 线缆能力','未知'],
    ['电源来源',source?esc(source):'未知'],
    ['功率测量','系统报告值']
  ];
  return panel('power','供电状态','<div class="power-panel">'+
    '<div class="power-top"><span class="power-big-icon">'+icon('plug')+'</span>'+
    '<div class="power-main"><span class="power-eyebrow">适配器报告功率</span>'+
    '<div class="power-number">'+(known?esc(watts)+' <small>W</small>':'未提供')+'</div></div>'+
    '<span class="pill '+(p.charging===null||p.charging===undefined?'na':'')+'">'+
    esc(charging)+'</span></div>'+
    '<div class="power-facts">'+facts.map(([label,value])=>
      '<div class="fact"><span>'+label+'</span><strong>'+value+'</strong></div>'
    ).join('')+'</div><p class="hint">'+icon('info')+
    esc(p.note||'系统未提供实时功率；适配器规格不能代表当前充电瓦数')+'</p></div>',{
      more:view==='all',full
    });
}
function eventsPanel(full=true) {
  const events=(snapshot.events||[]).slice(0,view==='all'?5:60);
  const content=events.length?'<div class="events-list">'+events.map(e=>
    '<div class="event-row"><span class="event-dot '+(e.action==='disconnected'?'off':'')+'"></span>'+
    '<time class="event-time">'+time(e.at)+'</time>'+
    '<span class="event-name">'+esc(e.name)+'</span>'+
    '<span class="event-action">'+(e.action==='connected'?'已接入':'已断开')+' · '+esc(categoryName(e.category))+'</span></div>'
  ).join('')+'</div>':'<div class="empty"><span class="empty-icon">'+icon('clock')+
    '</span><strong>暂无连接变化记录</strong><small>首次扫描完成后，设备的连接和断开会在这里出现</small></div>';
  return panel('events','最近连接事件',content,{more:view==='all',full});
}
function snapshotNotice() {
  if(preview)return '<div class="notice info">'+icon('info')+'演示预览模式：设备、型号与数字均非本机扫描结果</div>';
  if(snapshot.error)return '<div class="notice" role="alert">'+icon('alert')+
    '设备读取失败：'+esc(snapshot.error)+'。当前展示上一次有效数据。</div>';
  if(snapshot.stale)return '<div class="notice" role="status">'+icon('clock')+
    '正在等待首次采集，或数据超过有效期。可点击右上角「刷新」。</div>';
  return '';
}
function appView() {
  const metrics=[
    ['全部设备',snapshot.devices.length,'grid','all'],
    ['蓝牙设备',amount('bluetooth'),'bluetooth','bluetooth'],
    ['USB 设备',amount('usb'),'usb','usb'],
    ['显示器',amount('display'),'monitor','display']
  ];
  const content=view==='all'?
    devicePanel('bluetooth',4)+devicePanel('usb',5)+displayPanel()+powerPanel()+eventsPanel():
    view==='bluetooth'||view==='usb'?devicePanel(view,100,true):
    view==='display'?displayPanel(true):view==='power'?powerPanel(true):eventsPanel(true);
  return '<main class="shell">'+
    '<header class="header"><div class="identity"><span class="logo">'+icon('device')+'</span>'+
    '<div><span class="kicker">FLOWHUB · DEVICE CENTER</span>'+
    '<h1>外设中心</h1><p class="subtitle">已连接设备与供电状态，一目了然</p></div></div>'+
    '<div class="header-controls"><label class="search-wrap">'+icon('search')+
    '<input id="device-search" type="search" aria-label="搜索已连接设备" placeholder="搜索设备…" value="'+esc(query)+'" autocomplete="off"></label>'+
    '<button type="button" class="action-btn" id="refresh" '+(busy?'disabled':'')+'>'+icon('refresh')+(busy?'扫描中…':'刷新')+'</button></div></header>'+
    '<div class="toolbar"><nav class="tabs" aria-label="外设分类">'+menus.map(([key,label,glyph])=>
      '<button class="tab '+(view===key?'active':'')+'" data-view="'+key+'" type="button" aria-current="'+(view===key?'page':'false')+'">'+
      icon(glyph)+label+'</button>').join('')+'</nav>'+
    '<span class="status-text"><span class="connection-dot '+(snapshot.stale?'stale':'')+'"></span>'+
    (snapshot.stale?'数据待更新':time(snapshot.at)+' 更新')+'</span></div>'+
    snapshotNotice()+
    '<div class="summary">'+metrics.map(([label,value,glyph,category])=>
      '<div class="metric"><span class="metric-symbol '+category+'">'+icon(glyph)+'</span>'+
      '<div><div class="metric-label">'+label+'</div><div class="metric-number">'+value+'</div></div></div>'
    ).join('')+'</div>'+
    '<div class="main-grid">'+content+'</div>'+
    '<p class="secondary-note">由 macOS 系统设备报告提供，只展示可确认的信息。部分蓝牙电量、USB 链路及充电功率可能无法读取。设备图为内置类别插画，不代表厂家实物照片。</p>'+
    '</main>'+
    (selected?drawer(selected):'');
}
function property(label,value) {
  return '<div class="property"><span>'+esc(label)+'</span><strong>'+esc(value??'系统未提供')+'</strong></div>';
}
function detailBody(d) {
  if(!d)return '<div class="empty"><strong>设备已断开或暂不可用</strong><small>请返回概览刷新列表</small></div>';
  return '<div class="detail-media">'+media(d)+
    '<div class="device-text"><span class="kicker">'+esc(categoryName(d.category))+'</span>'+
    '<h1>'+esc(d.name)+'</h1><p class="subtitle">'+esc(d.detail||'系统未提供设备详情')+'</p>'+
    '<span class="pill">'+icon('check','sm')+'已连接</span></div></div>'+
    '<div class="detail-properties">'+
    property('连接类型',categoryName(d.category))+
    property('设备类别',d.kind||'未知')+
    property('设备电量',d.battery||'未提供')+
    property('厂商 ID',d.vendor||'未提供')+
    property('产品 ID',d.productId||'未提供')+
    property('系统描述',d.detail||'未提供')+
    '</div><p class="secondary-note">只读取本机设备信息。此处的设备图片是类别插画，不表示已经确认具体产品外观。</p>';
}
function drawer(d) {
  return '<div class="overlay" id="overlay"><aside class="drawer" role="dialog" aria-modal="true" aria-label="设备详情">'+
    '<div class="drawer-head"><div class="drawer-title">设备详情</div>'+
    '<button type="button" id="close-detail" class="icon-button" aria-label="关闭详情">'+icon('close')+'</button></div>'+
    detailBody(d)+'</aside></div>';
}
function widgetView() {
  const s=status||statusOf(snapshot),rows=Array.isArray(s.rows)?s.rows:[],counts=s.counts||{};
  const cfg=context.config||{},limit=Math.max(1,Math.min(8,Number(cfg.limit)||3));
  const metrics=[['蓝牙',counts.bluetooth,'bluetooth'],['USB',counts.usb,'usb'],['显示器',counts.display,'monitor']];
  const knownValue=(key)=>Number.isFinite(counts[key])?counts[key]:'—';
  return '<main class="widget-shell"><div class="widget-head"><span class="widget-title">'+icon('device')+
    esc(cfg.title||'外设中心')+'</span><span class="status-text">'+(preview?'演示':s.stale?'数据过期':time(s.at))+'</span></div>'+
    '<div class="widget-stats">'+metrics.map(([label,n,glyph])=>
      '<div class="widget-metric">'+icon(glyph,'sm')+'<strong>'+knownValue(glyph==='monitor'?'display':glyph)+'</strong><span>'+label+'</span></div>'
    ).join('')+'</div>'+
    (s.error?'<div class="notice" role="alert">'+esc(s.error)+'</div>':'')+
    '<div class="device-list">'+rows.slice(0,limit).map(d=>row({
      ...d,detail:d.summary||'',battery:d.battery||null,category:d.category||'unknown'
    },true)).join('')+
    (rows.length?'':'<div class="empty"><strong>等待设备数据</strong></div>')+'</div>'+
    '<div class="widget-foot"><span class="subtitle">'+formatCount(s.count??rows.length)+' 台设备已记录</span>'+
    '<button type="button" class="more" id="open-full">查看全部 '+icon('arrow','sm')+'</button></div></main>';
}
function editorView() {
  const cfg=context.config||{},limit=Number(cfg.limit)||3;
  return '<main class="widget-editor"><h1>桌面外设组件</h1>'+
    '<p class="subtitle" style="margin-bottom:22px">选择组件展示的设备数量和标题</p>'+
    '<label class="editor-field">组件标题<input id="widget-title" maxlength="40" value="'+esc(cfg.title||'外设中心')+'"></label>'+
    '<label class="editor-field">显示设备数量<select id="widget-limit">'+[2,3,5,8].map(n=>
      '<option value="'+n+'" '+(n===limit?'selected':'')+'>'+n+' 台</option>').join('')+
    '</select></label><p class="hint">'+icon('info')+'组件只读取缓存，不会重复执行系统设备扫描。</p></main>';
}
function widgetDetailView(){
  const chosen=context.selection?.deviceId||context.config?.selection?.deviceId||null;
  const d=snapshot.devices.find(d=>d.id===chosen)||null;
  return '<main class="detail-shell"><div class="detail-head">'+
    '<div><span class="kicker">DEVICE CENTER</span><h1>设备详情</h1></div></div>'+
    '<section class="panel">'+(chosen?detailBody(d):
      '<p class="subtitle">从外设组件选择具体设备，或打开 FlowHub「外设中心」查看完整设备列表。</p>')+'</section></main>';
}
function render(){
  if(disposed)return;
  root.innerHTML=surface==='editor'?editorView():
    surface==='card'?widgetView():surface==='detail'?widgetDetailView():appView();
  for(const button of root.querySelectorAll('[data-view]')){
    button.addEventListener('click',()=>{view=button.dataset.view;query='';selected=null;render();});
  }
  root.querySelector('#refresh')?.addEventListener('click',()=>{void refresh(true);});
  root.querySelector('#device-search')?.addEventListener('input',event=>{
    query=event.target.value;const caret=event.target.selectionStart;
    render();const input=root.querySelector('#device-search');
    input?.focus();if(caret!==null)input?.setSelectionRange(caret,caret);
  });
  root.querySelectorAll('[data-device]').forEach(button=>{
    button.addEventListener('click',()=>{
      const id=button.dataset.device;
      if(widget&&surface==='card'){
        if(!preview&&embedded&&token)window.parent.postMessage({
          type:'flowhub:widget-navigate',token,action:'detail',selection:{deviceId:id}
        },'*');
        return;
      }
      selected=snapshot.devices.find(d=>d.id===id)||null;render();
    });
  });
  root.querySelector('#close-detail')?.addEventListener('click',()=>{selected=null;render();});
  root.querySelector('#overlay')?.addEventListener('click',event=>{
    if(event.target.id==='overlay'){selected=null;render();}
  });
  root.querySelector('#open-full')?.addEventListener('click',()=>{
    if(!preview&&embedded&&token)window.parent.postMessage({
      type:'flowhub:widget-navigate',token,action:'detail',selection:{}
    },'*');
  });
  for(const img of root.querySelectorAll('.media img')){
    img.addEventListener('error',()=>{
      img.parentElement?.replaceChildren();
      img.parentElement?.insertAdjacentHTML('beforeend',icon('device'));
    },{once:true});
  }
  if(widget&&embedded&&token){
    window.parent.postMessage({type:'flowhub:widget-size',token,
      height:Math.ceil(document.documentElement.scrollHeight)},'*');
  }
}
function rpc(method){
  if(preview)return Promise.resolve(method==='status_snapshot'?statusOf(demo):demo);
  if(widget&&!widgetInitialized)return Promise.reject(new Error('组件上下文尚未就绪'));
  const id='dc-'+Date.now()+'-'+Math.random().toString(36).slice(2);
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{
      requests.delete(id);reject(new Error('设备查询超时，可稍后刷新'));
    },43000);
    requests.set(id,{timer,resolve,reject});
    const message=widget?{
      type:'flowhub:widget-rpc',id,token,params:method==='status_snapshot'?
        {action:'snapshot'}:{action:'management',method,params:{}}
    }:{type:'flowhub:request',id,method,params:{}};
    try{window.parent.postMessage(message,'*');}
    catch(e){clearTimeout(timer);requests.delete(id);reject(e);}
  });
}
function receive(event){
  if(disposed||event.source!==window.parent)return;
  const d=event.data;
  if(!d||typeof d!=='object'||(widget&&token&&d.token!==token))return;
  if(widget&&d.type==='flowhub:widget-init'){
    context=d.context||{};
    widgetInitialized=true;
    if(context.snapshot)status=context.snapshot;
    render();
    if(surface==='detail')void refresh(false);
    else if(surface==='card')void readStatus();
  }
  if(widget&&d.type==='flowhub:widget-save'){
    const title=String(root.querySelector('#widget-title')?.value||'外设中心').trim().slice(0,40);
    const limit=Math.max(1,Math.min(8,Number(root.querySelector('#widget-limit')?.value)||3));
    window.parent.postMessage({type:'flowhub:widget-config',id:d.id,token,
      config:{title,limit}},'*');
  }
  if(d.type===(widget?'flowhub:widget-result':'flowhub:response')){
    const p=requests.get(d.id);
    if(!p)return;
    clearTimeout(p.timer);requests.delete(d.id);
    if(d.error)p.reject(new Error(String(d.error)));else p.resolve(d.result);
  }
}
async function refresh(force){
  if(disposed||busy)return;
  if(force){busy=true;render();}
  try{
    const result=await rpc(force?'refresh':'snapshot');
    if(!disposed&&Array.isArray(result?.devices)){
      snapshot=result;status=statusOf(result);
    }
  }catch(e){
    if(!disposed)snapshot={...snapshot,error:String(e),stale:true};
  }finally{
    if(!disposed){busy=false;render();}
  }
}
async function readStatus(){
  try{
    const result=await rpc('status_snapshot');
    if(!disposed){status=result;render();}
  }catch(e){
    if(!disposed){status={...(status||{}),error:String(e),stale:true};render();}
  }
}
window.addEventListener('message',receive);
window.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&selected){selected=null;render();}
});
if(preview){snapshot=demo;status=statusOf(demo);}
render();
if(widget&&embedded&&token)window.parent.postMessage({type:'flowhub:widget-ready',token},'*');
if(!preview&&!widget)void refresh(false);
const polling=setInterval(()=>{
  if(disposed||document.hidden)return;
  if(!widget)void refresh(false);
  else if(widgetInitialized&&surface==='card')void readStatus();
  else if(widgetInitialized&&surface==='detail')void refresh(false);
},widget?15000:20000);
window.addEventListener('pagehide',()=>{
  disposed=true;clearInterval(polling);window.removeEventListener('message',receive);
  for(const p of requests.values()){clearTimeout(p.timer);p.reject(new Error('页面已关闭'));}
  requests.clear();
},{once:true});
})();