(() => {
'use strict';
const app=document.getElementById('app'),surface=document.body.dataset.surface||'main';
const widget=surface!=='main',embedded=window.parent!==window;
const token=new URLSearchParams(location.hash.slice(1)).get('flowhubWidgetToken');
const preview=!embedded||(widget&&!token);
const labels={all:'概览',bluetooth:'蓝牙设备',usb:'USB 与移动设备',display:'显示器',power:'供电',events:'历史事件'};
const icons={all:'▣',bluetooth:'ᛒ',usb:'♧',display:'▤',power:'ϟ',events:'◷',headphones:'♫',mouse:'◉',keyboard:'▦',phone:'▯',drive:'▰',hub:'⌘',monitor:'▤',device:'◇'};
const sample={at:Date.now(),stale:false,devices:[
{id:'bt1',name:'AirPods Pro 2',category:'bluetooth',kind:'headphones',battery:'82%',detail:'音频设备'},
{id:'bt2',name:'Magic Mouse',category:'bluetooth',kind:'mouse',battery:'67%',detail:'输入设备'},
{id:'bt3',name:'Keychron K3',category:'bluetooth',kind:'keyboard',battery:'100%',detail:'输入设备'},
{id:'u1',name:'Pixel 9 Pro',category:'usb',kind:'phone',detail:'USB-C · ADB 状态未读取'},
{id:'u2',name:'iPhone 15',category:'usb',kind:'phone',detail:'USB · 信任状态未读取'},
{id:'u3',name:'Samsung T7 SSD',category:'usb',kind:'drive',detail:'USB 3.2 · 10 Gb/s'},
{id:'u4',name:'SD Card Reader',category:'usb',kind:'hub',detail:'USB'},
{id:'d1',name:'DELL U2723QE',category:'display',kind:'monitor',detail:'3840 × 2160 · 60 Hz'},
{id:'d2',name:'LG UltraFine',category:'display',kind:'monitor',detail:'2560 × 1440'}
],power:{adapterWatts:'96',charging:true,note:'适配器功率为系统报告值，并非实时输入功率'},events:[{at:Date.now()-100000,name:'Pixel 9 Pro',category:'usb',action:'connected'}]};
let snapshot=preview?sample:{at:0,stale:true,devices:[],events:[],power:{}},context={},status=null,view='all',search='',busy=false,disposed=false;
const pending=new Map();
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock=x=>x?new Date(x).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'未采集';
const count=x=>snapshot.devices.filter(d=>d.category===x).length;
function rpc(method){
 if(preview)return Promise.resolve(method==='status_snapshot'?statusOf(sample):sample);
 const id='dc-'+Date.now()+'-'+Math.random().toString(36).slice(2);
 return new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>{pending.delete(id);reject(new Error('系统设备查询超时'));},42000);
 pending.set(id,{timer,resolve,reject});
 if(widget)window.parent.postMessage({type:'flowhub:widget-rpc',id,token,params:method==='status_snapshot'?{action:'snapshot'}:{action:'management',method,params:{}}},'*');
 else window.parent.postMessage({type:'flowhub:request',id,method,params:{}},'*');
 });
}
function statusOf(s){return {at:s.at,stale:s.stale,rows:s.devices.map(d=>({name:d.name,summary:d.detail||d.category,id:d.id})),count:s.devices.length,error:s.error};}
function onMessage(event){
 if(event.source!==window.parent||disposed)return;
 const d=event.data;
 if(!d||typeof d!=='object'||(widget&&token&&d.token!==token))return;
 if(widget&&d.type==='flowhub:widget-init'){context=d.context||{};status=context.snapshot||status;render();}
 if(widget&&d.type==='flowhub:widget-save'){
 const config={title:String(document.getElementById('title')?.value||'外设中心').slice(0,40),limit:Math.max(1,Math.min(8,Number(document.getElementById('limit')?.value)||3))};
 window.parent.postMessage({type:'flowhub:widget-config',id:d.id,token,config},'*');
 }
 if(d.type===(widget?'flowhub:widget-result':'flowhub:response')){
 const p=pending.get(d.id);if(!p)return;
 clearTimeout(p.timer);pending.delete(d.id);d.error?p.reject(Error(String(d.error))):p.resolve(d.result);
 }
}
window.addEventListener('message',onMessage);
function deviceRow(d){
 return '<div class="row"><div class="device-icon" aria-hidden="true">'+(icons[d.kind]||icons.device)+'</div><div class="grow"><div class="name" title="'+esc(d.name)+'">'+esc(d.name)+'</div><div class="detail">'+esc(d.detail||labels[d.category]||'已连接')+'</div></div>'+(d.battery?'<span class="battery">'+esc(d.battery)+'</span>':'<span class="pill">已连接</span>')+'</div>';
}
function panel(title,category,content){
 return '<section class="panel"><div class="panel-head"><strong>'+icons[category]+'　'+title+'</strong>'+(view==='all'?'<button class="link" data-view="'+category+'">查看全部 ›</button>':'')+'</div>'+content+'</section>';
}
function devices(category,limit=100){
 const rows=snapshot.devices.filter(d=>d.category===category&&(d.name+' '+d.detail).toLowerCase().includes(search.toLowerCase()));
 return panel(labels[category]+' <span class="small">('+rows.length+')</span>',category,rows.length?rows.slice(0,limit).map(deviceRow).join(''):'<div class="empty">当前没有检测到此类设备</div>');
}
function power(){
 const p=snapshot.power||{},w=p.adapterWatts==null?'未提供':esc(p.adapterWatts)+' W';
 const tiles=[['适配器报告功率',w],['电池侧功率','未测量'],['充电状态',p.charging===true?'充电中':p.charging===false?'未充电':'未知'],['线缆功率能力','未知']];
 return panel('供电状态','power','<div class="power-grid">'+tiles.map(t=>'<div class="power-tile"><small>'+t[0]+'</small><b>'+t[1]+'</b></div>').join('')+'</div><div class="footnote">'+esc(p.note||'缺少供电数据；不能将额定功率当作实时功率')+'</div>');
}
function events(){
 const rows=snapshot.events||[];
 return panel('最近连接事件','events',rows.length?rows.slice(0,view==='all'?5:60).map(e=>'<div class="event"><span class="dot '+(e.action==='disconnected'?'off':'')+'"></span><time>'+clock(e.at)+'</time><span class="grow">'+esc(e.name)+'　<span class="small">'+(e.action==='connected'?'已连接':'已断开')+'</span></span><span class="pill">'+esc(labels[e.category]||e.category)+'</span></div>').join(''):'<div class="empty">首次扫描后，连接变化会记录在这里（仅内存）</div>');
}
function main(){
 const stats=[['全部设备',snapshot.devices.length,'all'],['蓝牙设备',count('bluetooth'),'bluetooth'],['USB 设备',count('usb'),'usb'],['显示器',count('display'),'display']];
 const warning=preview?'<div class="info">浏览器预览 · 以下设备和数字均为演示数据</div>':snapshot.error?'<div class="alert" role="alert">'+esc(snapshot.error)+' · 当前显示上次有效数据</div>':snapshot.stale?'<div class="alert">等待设备扫描，或缓存已经过期</div>':'';
 const panels=view==='all'?[devices('bluetooth',4),devices('usb',5),devices('display',3),power(),events()]:[view==='power'?power():view==='events'?events():devices(view)];
 const nav=Object.entries(labels).map(k=>'<button data-view="'+k[0]+'" class="'+(view===k[0]?'active':'')+'"><i>'+icons[k[0]]+'</i>'+k[1]+'</button>').join('');
 return '<div class="layout"><aside class="side"><div class="brand"><span>◈</span>FlowHub</div><nav class="nav">'+nav+'</nav><small>外设中心 v0.1.0<br>macOS 原生设备信息</small></aside><div class="main"><div class="head"><div><div class="eyebrow">DEVICE CENTER</div><h1>'+(view==='all'?'外设中心':labels[view])+'</h1><p class="sub">蓝牙、USB、显示器及供电状态 · '+clock(snapshot.at)+' 更新</p></div><div class="actions"><input id="search" class="search" placeholder="搜索设备…" value="'+esc(search)+'"><button id="refresh" class="button" '+(busy?'disabled':'')+'>'+(busy?'扫描中…':'↻ 刷新')+'</button></div></div>'+warning+
 '<div class="stats">'+stats.map(s=>'<div class="stat"><span class="stat-icon">'+icons[s[2]]+'</span><div><small>'+s[0]+'</small><b>'+s[1]+'</b></div></div>').join('')+'</div><div class="panels">'+panels.map((p,i)=>'<div class="'+(view!=='all'||i===4?'wide':'')+'">'+p+'</div>').join('')+'</div><div class="footnote">本地只读扫描。不传输序列号、蓝牙地址或手机调试标识；不保证所有设备电量与显示器参数都能读取。连接事件为采样差异，非完整的系统事件日志。</div></div></div>';
}
function compact(){
 const s=status||statusOf(snapshot),rows=s.rows||[],cfg=context.config||{},limit=Math.max(1,Math.min(8,Number(cfg.limit)||3));
 return '<div class="widget"><div class="widget-top"><strong>◈ '+esc(cfg.title||'外设中心')+'</strong><span class="small">'+(preview?'演示数据':s.stale?'数据过期':clock(s.at))+'</span></div><div class="widget-counts"><div><b>'+Number(s.count??rows.length)+'</b><small>全部设备</small></div><div><b>'+rows.length+'</b><small>缓存条目</small></div><div><b>'+(s.error?'!':'✓')+'</b><small>采集状态</small></div></div>'+(s.error?'<div class="alert">'+esc(s.error)+'</div>':'')+
 rows.slice(0,limit).map(d=>'<div class="row"><span class="device-icon">◇</span><div class="grow"><div class="name">'+esc(d.name)+'</div><div class="detail">'+esc(d.summary)+'</div></div></div>').join('')+'<div class="widget-foot"><span class="small">设备状态缓存</span><button class="link" id="open" '+(preview?'disabled':'')+'>查看全部 ›</button></div></div>';
}
function editor(){
 return '<div class="editor"><h2>桌面外设组件</h2><label>标题<input id="title" maxlength="40" value="'+esc(context.config?.title||'外设中心')+'"></label><label>显示设备数量<select id="limit">'+[2,3,5,8].map(n=>'<option value="'+n+'" '+(Number(context.config?.limit||3)===n?'selected':'')+'>'+n+' 个</option>').join('')+'</select></label><p class="small">组件读取系统监控缓存，不额外扫描设备。</p></div>';
}
function render(){
 if(disposed)return;
 app.innerHTML=surface==='editor'?editor():widget?compact():main();
 app.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{view=b.dataset.view;render();}));
 app.querySelector('#refresh')?.addEventListener('click',()=>void refresh(true));
 app.querySelector('#search')?.addEventListener('input',e=>{search=e.target.value;const cursor=e.target.selectionStart;render();const input=app.querySelector('#search');input?.focus();input?.setSelectionRange(cursor,cursor);});
 app.querySelector('#open')?.addEventListener('click',()=>{if(embedded&&!preview)window.parent.postMessage({type:'flowhub:widget-navigate',token,action:'detail',selection:{}},'*');});
}
async function refresh(force=false){
 if(disposed||busy)return;
 busy=force;render();
 try{const data=await rpc(force?'refresh':'snapshot');if(!disposed&&Array.isArray(data.devices)){snapshot=data;status=statusOf(data);}}
 catch(e){if(!disposed)snapshot={...snapshot,error:String(e),stale:true};}
 finally{busy=false;if(!disposed)render();}
}
async function tick(){
 try{const data=await rpc('status_snapshot');if(!disposed){status=data;render();}}
 catch(e){if(!disposed){status={...(status||{}),error:String(e)};render();}}
}
if(preview)status=statusOf(sample);
render();
if(widget&&embedded&&token)window.parent.postMessage({type:'flowhub:widget-ready',token},'*');
if(!preview){if(widget&&surface!=='editor')void tick();else if(!widget)void refresh();}
const poll=setInterval(()=>{if(document.hidden)return;if(widget&&surface!=='editor')void tick();else if(!widget)void refresh();},widget?15000:45000);
addEventListener('pagehide',()=>{disposed=true;clearInterval(poll);removeEventListener('message',onMessage);for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('页面已关闭'));}pending.clear();},{once:true});
})();