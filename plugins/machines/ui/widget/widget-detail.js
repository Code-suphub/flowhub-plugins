(() => {
const $=s=>document.querySelector(s);
let context={},row='';
const names={load:'负载',cpu:'CPU',memory:'内存',disk:'磁盘',rx:'下载速度',tx:'上传速度'};
let request=0;const chartResults=new Map();
function enlarge(key){const result=chartResults.get(key);if(!result)return;$('#zoom h2').textContent=names[key];draw(result,key,$('#zoom'));$('#zoom').showModal();}
$('#closeZoom').onclick=()=>$('#zoom').close();$('#zoom').onclick=e=>{if(e.target===$('#zoom'))$('#zoom').close();};

function draw(result,metric,section){const $=s=>section.querySelector(s);const rows=result.data||[],valid=rows.filter(r=>Number.isFinite(r[1])),unit=result.unit||'';$('[data-chart]').replaceChildren();if(!valid.length){$('[data-summary]').textContent='暂无数据';$('[data-status]').textContent='这个时间范围没有已保存的采样。';return;}
const max=Math.max(1,...valid.map(r=>r[1])),ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 760 310');svg.setAttribute('role','img');svg.setAttribute('aria-label',names[metric]+'历史曲线');
function node(tag,attrs,text){const n=document.createElementNS(ns,tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,v);if(text!=null)n.textContent=text;svg.append(n);return n;}
for(let i=0;i<=4;i++){const y=20+i*60;node('line',{x1:60,x2:740,y1:y,y2:y,stroke:'#ffffff0e'});node('text',{x:5,y:y+4,fill:'#aaa3aa','font-size':11},(max*(1-i/4)).toFixed(1));}
let d='',pen=false;rows.forEach((r,i)=>{if(!Number.isFinite(r[1])){pen=false;return;}const x=60+i/(rows.length-1||1)*680,y=260-r[1]/max*240;d+=(pen?'L':'M')+x+','+y+' ';pen=true;const dot=node('circle',{cx:x,cy:y,r:3,fill:'#f7a454'}),t=document.createElementNS(ns,'title');t.textContent=new Date(r[0]*1000).toLocaleString()+' · '+r[1].toFixed(2)+' '+unit;dot.append(t);});node('path',{d,stroke:'#f7a454','stroke-width':2,fill:'none'});node('text',{x:60,y:292,fill:'#aaa3aa','font-size':11},new Date(rows[0][0]*1000).toLocaleString());node('text',{x:740,y:292,fill:'#aaa3aa','font-size':11,'text-anchor':'end'},new Date(rows.at(-1)[0]*1000).toLocaleString());$('[data-chart]').append(svg);$('[data-summary]').textContent='最近采样 '+valid.at(-1)[1].toFixed(2)+' '+unit;$('[data-status]').textContent='鼠标悬停在采样点可查看时间和数值。';}
async function load(){
 const token=++request;chartResults.clear();$('#charts').classList.add('overview');
 const seconds=Number($('#range').value),keys=Object.keys(names);$('#charts').replaceChildren();
 await Promise.all(keys.map(async key=>{const section=document.createElement('section');section.tabIndex=0;section.setAttribute('role','button');section.setAttribute('aria-label','放大'+names[key]+'曲线');section.onclick=()=>enlarge(key);section.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();enlarge(key);}};section.innerHTML='<div class="chart-head"><h2></h2><span data-summary></span></div><div data-chart></div><p data-status role="status">正在读取历史…</p>';section.querySelector('h2').textContent=names[key];$('#charts').append(section);try{const result=!context.preview?await FlowHubWidget.invoke({action:'history',row,metric:key,seconds}):{unit:key==='load'?'':key==='rx'||key==='tx'?'KB/s':'%',data:Array.from({length:90},(_,i)=>[Date.now()/1000-seconds+i*seconds/89,i>35&&i<43?null:Math.max(0,key==='load'?1+Math.sin(i/8):40+20*Math.sin(i/8))])};if(token===request){chartResults.set(key,result);draw(result,key,section);}}catch(e){if(token===request)section.querySelector('[data-status]').textContent='历史读取失败：'+String(e);}}));
}
$('#range').onchange=load;$('#refresh').onclick=load;FlowHubWidget.onInit(data=>{context=data;row=data.config?.row||data.snapshot?.rows?.[0]?.id||'';$('#title').textContent=data.title||data.snapshot?.rows?.find(r=>r.id===row)?.name||'机器详情';$('#identity').textContent=data.preview?'浏览器预览 · 模拟数据':row;load();});

$('#settingsTab').onclick=()=>{location.href='machines.html?widgetSettings=1&row='+encodeURIComponent(row)+location.hash;};
})();
