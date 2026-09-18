(()=>{
 const invoke=window.FlowHubPlugin?.invoke||window.__TAURI__?.core?.invoke;if(!invoke)return;
 const api=(action,payload)=>invoke('machines_api',{action,payload});
 const providers={
  tencent:{name:'腾讯云 · Lighthouse',fields:['region','instanceId','secretId','secretKey','token'],required:['region','instanceId'],region:'ap-shanghai',instance:'lhins-…',help:'查询单台轻量实例的套餐余量。只读权限：lighthouse:DescribeInstancesTrafficPackages。'},
  bandwagon:{name:'搬瓦工 · KiwiVM',fields:['veid','apiKey'],required:['veid'],help:'在该实例 KiwiVM → API 获取 VEID 与 API Key，查询该实例套餐。更换 VEID 需要重新填写对应密钥。'},
  aliyun:{name:'阿里云 · 轻量应用服务器',fields:['region','instanceId','secretId','secretKey','token'],required:['region','instanceId'],region:'cn-hangzhou',instance:'轻量实例 ID',help:'查询轻量实例本月套餐余额。RAM 只读权限：swas-open:ListInstancesTrafficPackages；不适用于 ECS 的按量公网账单。'},
  huawei:{name:'华为云 · Flexus L',fields:['site','packageId','secretId','secretKey'],required:['site','packageId'],help:'查询 Flexus L 流量包余额。填写流量包 ID（不是服务器 ID），可从 Flexus 实例资源中的 huaweicloudinternal_cbc_freeresource 获取；凭证需有资源包查询权限。'},
  linode:{name:'Linode / Akamai · 共享流量',fields:['region','apiKey'],required:[],region:'可选，如 us-east',help:'查询账户本月共享流量，Token 需有 account:read_only 权限。地域留空显示账户汇总；填写地域时查询该地域的独立池。共享余量不是单台机器专属额度。'},
  vultr:{name:'Vultr · 共享流量',fields:['apiKey'],required:[],help:'查询账户本月至今已累计的共享额度及出站用量，不使用月底预测额度。API Key 需可读取 /v2/account/bandwidth，并允许当前客户端 IP。'},
  aws:{name:'AWS · Lightsail 监控用量',fields:['region','instanceId','secretId','secretKey','token'],required:['region','instanceId'],region:'us-east-1',instance:'Lightsail 实例名称',help:'查询本月 UTC 入站＋出站监控用量，可能有延迟或缺失。仅显示已用量，不代表账单或套餐余额。只读权限：lightsail:GetInstanceMetricData。'}
  ,zgocloud:{name:'ZgoCloud · API Token',fields:['apiToken','serverId','limitGB'],required:['apiToken','serverId'],serverIdHint:'例如 19383',help:'在 zgoCloud 控制台 → 用户设置生成 API Token（需要向客服申请）；serverId 是整数 ID。只读权限：账号对应 server 的查看权限。套餐限额由接口自动返回，limitGB 留空。'}
  ,zgocloudCookie:{name:'ZgoCloud · Session Cookie',fields:['cookie','xsrfToken','serverId','limitGB'],required:['cookie','xsrfToken','serverId'],serverIdHint:'例如 19383',help:'从浏览器登录 zgoCloud 后 DevTools → Network → 任一 /api/ 或 /resource/ 请求 → 复制 Cookie 头整串 + x-xsrf-token 头。limitGB 是套餐流量（手动填），用于显示剩余/超额。Cookie 会过期，过期后重新复制。'}
 ,localNet:{name:'网卡计数器 · 本地 Netdata',fields:['netdataId','limitGB'],required:['netdataId'],hideHost:true,help:'复用已在 FlowHub 机器管理接入的 Netdata 节点（每 5 分钟自动抓取）；按北京时间自然月 rx/tx 累计算日均和剩余天数。limitGB 是套餐流量（手动填），用于显示百分比和剩余天数。'}
 };
 const fields={region:'地域',instanceId:'实例 ID / 名称',secretId:'Access Key ID / SecretId',secretKey:'Access Key Secret / SecretKey',token:'临时会话 Token（可选）',veid:'VEID',apiKey:'API Key / 只读 Token',packageId:'流量包 ID',site:'华为云站点',apiToken:'API Token',cookie:'Cookie 串（浏览器）',xsrfToken:'XSRF Token（x-xsrf-token）',serverId:'Server ID（整数）',limitGB:'套餐流量 / GB（可选）'};
 const secrets=['secretId','secretKey','token','apiKey','apiToken','cookie','xsrfToken'];
 const dialog=document.createElement('dialog');dialog.className='netdata-dialog traffic-dialog';
 dialog.innerHTML=`<div class="section-head traffic-head"><div class="traffic-head-main"><div class="traffic-title"><h2>云流量</h2><span class="inline-help"><button type="button" class="help-trigger" aria-label="云流量说明" aria-describedby="trafficHelp" aria-expanded="false">?</button><span id="trafficHelp" class="help-content" role="tooltip" hidden>配置按机器保存，凭证会加密保存在本机；组件每 5 分钟更新一次。更换云服务商或凭证后，需要重新保存配置。</span></span></div><p class="traffic-target" data-target hidden></p><div class="traffic-target-fields"><label data-host-row>机器<select data-host></select></label><label data-netdata-row hidden>Netdata 节点<select data-netdata></select></label></div></div><button data-close type="button">关闭</button></div>
 <div class="traffic-body"><form id="trafficForm">
  <fieldset class="traffic-group"><legend>服务商与凭证</legend><div class="traffic-provider-heading"><span>云服务商</span><span class="inline-help"><button type="button" class="help-trigger" aria-label="服务商说明" aria-describedby="providerHelp" aria-expanded="false">?</button><span id="providerHelp" data-provider-help class="help-content" role="tooltip" hidden></span></span></div><label class="traffic-provider-field"><span class="sr-only">云服务商</span><select name="provider"></select></label><div class="traffic-fields" data-fields></div><label data-clear-token class="traffic-inline"><input name="clearToken" type="checkbox">清除已保存的临时 Token</label></fieldset>
  <section data-result class="traffic-results"></section>
 </form></div>
 <footer class="traffic-footer"><p data-status role="status"></p><div class="actions"><button type="button" data-query>查询流量</button><button type="submit" class="primary" form="trafficForm">保存配置</button></div></footer>`;
 document.body.append(dialog);
 const $=s=>dialog.querySelector(s),form=$('form');let busy=false;
 for(const help of dialog.querySelectorAll('.inline-help')){
  const button=help.querySelector('.help-trigger'),content=help.querySelector('.help-content');
  const show=visible=>{content.hidden=!visible;button.setAttribute('aria-expanded',String(visible));};
  help.onmouseenter=()=>show(true);help.onmouseleave=()=>{if(document.activeElement!==button)show(false);};
  button.onfocus=()=>show(true);button.onblur=()=>show(false);button.onclick=()=>show(true);
  button.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();show(false);}};
  document.addEventListener('pointerdown',e=>{if(!help.contains(e.target))show(false);});
 }
 for(const [key,p]of Object.entries(providers)){const o=document.createElement('option');o.value=key;o.textContent=p.name;form.elements.provider.append(o);}
 for(const [key,label]of Object.entries(fields)){
  const row=document.createElement('label');row.textContent=label;
  const input=document.createElement(key==='site'?'select':'input');input.name=key;
  if(key==='site'){for(const [value,name]of [['cn','中国站'],['intl','国际站']]){const o=document.createElement('option');o.value=value;o.textContent=name;input.append(o);}}
  else{input.type=secrets.includes(key)?'password':'text';input.autocomplete=secrets.includes(key)?'new-password':'off';input.maxLength=secrets.includes(key)?8192:128;if(secrets.includes(key))input.placeholder='已保存时留空保留';}
  row.append(input);$('[data-fields]').append(row);
 }
 function clearSecrets(){for(const k of secrets)form.elements[k].value='';form.elements.clearToken.checked=false;}
 // netdataId is chosen from the Netdata select, not from a credential input.
 const valueOf=k=>k==='netdataId'?$('[data-netdata]').value.trim():form.elements[k].value.trim();
 function syncProvider(){
  const p=providers[form.elements.provider.value];
  for(const k of Object.keys(fields)){const input=form.elements[k],show=p.fields.includes(k);input.closest('label').hidden=!show;input.disabled=busy||!show;input.required=show&&p.required.includes(k);}
  form.elements.region.placeholder=p.region||'';
  form.elements.instanceId.placeholder=p.instance||'';
  form.elements.serverId.placeholder=p.serverIdHint||'';
  $('[data-clear-token]').hidden=!p.fields.includes('token');form.elements.clearToken.disabled=busy||!p.fields.includes('token');
  $('[data-provider-help]').textContent=p.help;
  $('[data-host-row]').hidden=fixedHost||!!p.hideHost;
  $('[data-netdata-row]').hidden=!p.hideHost;
  $('[data-host]').disabled=busy||!!p.hideHost;
  $('[data-netdata]').disabled=busy||!!p.hideHost;
 }
 async function run(fn){if(busy)return;busy=true;dialog.querySelectorAll('button,select,input').forEach(e=>e.disabled=true);try{await fn();}catch(e){$('[data-status]').textContent=e.message||String(e);}finally{busy=false;dialog.querySelectorAll('button,select,input').forEach(e=>e.disabled=false);syncProvider();}}
 form.elements.provider.onchange=()=>{clearSecrets();for(const k of Object.keys(fields).filter(k=>!secrets.includes(k)))form.elements[k].value=k==='site'?'cn':'';$('[data-result]').replaceChildren();syncProvider();$('[data-status]').textContent='服务商已切换，请填写并保存对应配置';};
 async function load(){clearSecrets();$('[data-result]').replaceChildren();const v=await api('trafficRead',{hostId:$('[data-host]').value});form.elements.provider.value=providers[v.provider]?v.provider:'tencent';for(const k of Object.keys(fields).filter(k=>!secrets.includes(k)))form.elements[k].value=v[k]||(k==='site'?'cn':'');syncProvider();
  if(v.netdataId){const n=$('[data-netdata]');for(const o of n.options)if(o.value===v.netdataId){n.value=v.netdataId;break;}}
  $('[data-status]').textContent=v.configured?'已保存 · 密钥留空保留，可直接查询':'尚未配置，请填写后保存';}
 let fixedHost=false;
 async function open(hostId,hostName){
  dialog.showModal();syncProvider();
  return run(async()=>{
   const s=await api('state',{});
   const select=$('[data-host]');select.replaceChildren();
   for(const h of (s.config.hosts||[]).filter(h=>!hostId||h.id===hostId)){const o=document.createElement('option');o.value=h.id;o.textContent=h.name;select.append(o);}
   fixedHost=!!hostId;if(fixedHost)select.value=hostId;
   const target=$('[data-target]');target.hidden=!fixedHost;
   target.textContent='机器：'+(hostName||select.selectedOptions[0]?.textContent||'未选择');
   const netSel=$('[data-netdata]');netSel.replaceChildren();netSel.disabled=false;
   const netList=s.config.netdata||[];
   if(netList.length===0){const o=document.createElement('option');o.value='';o.textContent='（先在机器编辑里接入 Netdata 节点）';netSel.append(o);netSel.disabled=true;$('[data-status]').textContent='还没有接入 Netdata 节点，选择本地网卡计数器前请先接入一个。';}
   else for(const i of netList){const o=document.createElement('option');o.value=i.id;o.textContent=i.name+' · '+i.url;netSel.append(o);}
   syncProvider();
   if(select.value)await load();else $('[data-status]').textContent='请先保存机器';
  });
 }
 window.FlowHubCloudTraffic={open};
 $('[data-close]').onclick=()=>dialog.close();dialog.addEventListener('close',clearSecrets);dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});$('[data-host]').onchange=()=>run(load);
  form.onsubmit=e=>{e.preventDefault();run(async()=>{const p={hostId:$('[data-host]').value,provider:form.elements.provider.value};for(const k of providers[p.provider].fields)p[k]=valueOf(k);p.clearToken=form.elements.clearToken.checked;await api('trafficSave',p);clearSecrets();$('[data-status]').textContent='配置已加密保存，关闭页面或重启后仍可查询';$('[data-result]').replaceChildren();});};
 function node(tag,className,text){const el=document.createElement(tag);if(className)el.className=className;if(text!=null)el.textContent=text;return el;}
 function stat(label,value,hint){const wrap=node('div'),line=node('dd',null,value);if(hint)line.append(node('span','traffic-hint',hint));wrap.append(node('dt',null,label),line);return wrap;}
 function card(titleText,tagText,stats,note,percent){
  const card=node('article','traffic-card'),head=node('header','traffic-card-head');
  head.append(node('h3',null,titleText));if(tagText)head.append(node('span','traffic-tag',tagText));
  card.append(head);
  if(stats.length){const list=node('dl','traffic-stats');for(const row of stats)list.append(row);card.append(list);}
  if(percent!=null&&percent>0){const meter=node('div','traffic-meter'+(percent>100?' over':percent>=80?' warn':''));const fill=node('i');fill.style.width=Math.max(0,Math.min(100,percent))+'%';meter.append(fill);card.append(meter);}
  if(note)card.append(node('p','traffic-note',note));
  return card;
 }
 function localNetCards(data,unit,n){
  const cards=[];
  for(const row of data.rows||[])for(const pack of row.TrafficPackageSet||[]){
   const limitGB=pack.LimitGB||0,pct=pack.PercentUsed||0,avg=pack.DailyAverage||0,days=pack.DaysRemaining||0;
   const stats=[stat('入站 RX',n(pack.RxBytes)+' '+unit),stat('出站 TX',n(pack.TxBytes)+' '+unit),
    stat('双向合计',n(pack.TrafficUsed)+' '+unit,limitGB>0?pct.toFixed(1)+'% / '+limitGB+' '+unit:'未设置套餐流量')];
   if(avg>0)stats.push(stat('当前日均',n(avg)+' '+unit+'/天','本月累计口径（已 '+(pack.PeriodDays||0).toFixed(1)+' 天）'));
   stats.push(stat('预计可用',limitGB<=0?'—':(avg>0?days.toFixed(1)+' 天':'—'),limitGB<=0?'先填写套餐流量':(avg>0?'按当前速率':'累计样本不足')));
   const note=['范围：网卡计数器累计值（不含回环、容器与网桥）'];
   if(pack.StartTime||pack.EndTime)note.push('统计周期：'+(pack.StartTime?new Date(pack.StartTime).toLocaleDateString():'—')+' → '+(pack.EndTime?new Date(pack.EndTime).toLocaleDateString():'—'));
   cards.push(card((data.instanceName||row.InstanceId||'机器')+' 当前流量','网卡计数器 · 双向口径',stats,note.join(' · '),limitGB>0?pct:null));
  }
  return cards;
 }
 function standardCards(data,unit,n,summary,name){
  const cards=[],shared=summary?.scope==='account'||summary?.scope?.startsWith('region:'),usage=summary?.mode==='usage';
  for(const row of data.rows||[])for(const pack of row.TrafficPackageSet||[]){
   const total=pack.TrafficPackageTotal,used=pack.TrafficUsed,remaining=pack.TrafficPackageRemaining,overflow=pack.TrafficOverflow;
   const stats=usage?[stat('本月已用',n(used)+' '+unit)]:[stat('已用',n(used)+' '+unit),stat('套餐总量',n(total)+' '+unit),stat('剩余',n(remaining)+' '+unit),stat('超额',n(overflow)+' '+unit)];
   const scope=shared?(summary.scope==='account'?'账户汇总（含多台机器，地域独立池不可互相抵扣）':'地域共享池 '+summary.scope.slice(7)):('实例 '+(row.InstanceId==='instance'?(form.elements.instanceId.value||form.elements.packageId.value):row.InstanceId));
   const note=['范围：'+scope];
   if(pack.EndTime)note.push('周期结束：'+new Date(pack.EndTime).toLocaleString());
   const percent=!usage&&Number.isFinite(total)&&total>0?used/total*100:null;
   cards.push(card(usage?('本月监控已用 '+n(used)+' '+unit):((shared?'共享剩余 ':'剩余 ')+n(remaining)+' '+unit),name+(shared?' · 共享池':' · 单实例'),stats,note.join(' · '),percent));
  }
  return cards;
 }
 function emptyCard(text){return node('p','traffic-empty',text);}
 $('[data-query]').onclick=()=>run(async()=>{
  const hostId=$('[data-host]').value,saved=await api('trafficRead',{hostId});if(!saved.configured)throw Error('请先保存配置');
  const provider=form.elements.provider.value,p=providers[provider];
  if(provider!==(saved.provider||'tencent')||p.fields.filter(k=>!secrets.includes(k)).some(k=>valueOf(k)!==(saved[k]||''))||secrets.some(k=>form.elements[k].value)||form.elements.clearToken.checked)throw Error('配置有未保存修改，请先保存');
  $('[data-status]').textContent='正在查询云服务商…';$('[data-result]').replaceChildren();
  const data=await api('trafficQuery',{hostId}),summary=data.summary;
  const divisor=summary?.divisor||1073741824,unit=divisor===1e9?'GB':'GiB';
  const n=v=>Number.isFinite(v)?(v/divisor).toLocaleString('zh-CN',{maximumFractionDigits:2}):'—';
  const cards=data.provider==='localNet'?localNetCards(data,unit,n):standardCards(data,unit,n,summary,p.name);
  $('[data-result]').replaceChildren(...(cards.length?cards:[emptyCard('这家服务商没有返回可用的流量数据。')]));
  $('[data-status]').textContent=(cards.length?`${p.name} 查询完成`:'暂无流量数据')+' · '+new Date(data.at).toLocaleString();
 });
})();
