(()=>{
 const invoke=window.FlowHubPlugin?.invoke;if(!invoke)return;
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
  ,localNet:{name:'网卡计数器 · 本地 Netdata',fields:['netdataId','limitGB'],required:['netdataId'],hideHost:true,help:'复用已在 FlowHub 机器管理接入的 Netdata 节点（每 5 分钟自动抓取）；按 30 天 rx/tx 累计算日均和剩余天数。limitGB 是套餐流量（手动填），用于显示百分比和剩余天数。'}
 };
 const fields={region:'地域',instanceId:'实例 ID / 名称',secretId:'Access Key ID / SecretId',secretKey:'Access Key Secret / SecretKey',token:'临时会话 Token（可选）',veid:'VEID',apiKey:'API Key / 只读 Token',packageId:'流量包 ID',site:'华为云站点',apiToken:'API Token',cookie:'Cookie 串（浏览器）',xsrfToken:'XSRF Token（x-xsrf-token）',serverId:'Server ID（整数）',limitGB:'套餐流量 / GB（可选）'};
 const secrets=['secretId','secretKey','token','apiKey','apiToken','cookie','xsrfToken'];
 const button=document.createElement('button');button.type='button';button.textContent='云流量';document.querySelector('header .actions').prepend(button);
 const dialog=document.createElement('dialog');dialog.className='netdata-dialog';
 dialog.innerHTML=`<div class="section-head"><h2>云流量</h2><button data-close type="button">关闭</button></div><p class="netdata-note">按机器关联云服务商。凭证加密保存在本机，组件每 5 分钟更新；更换服务商需要重新保存。</p><label data-host-row>关联机器<select data-host></select></label><label data-netdata-row hidden>关联 Netdata 节点<select data-netdata></select></label><form><label>云服务商<select name="provider"></select></label><p data-provider-help class="netdata-note"></p><div class="netdata-fields" data-fields></div><label data-clear-token><input name="clearToken" type="checkbox">清除已保存的临时 Token</label><div class="actions"><button type="submit" class="primary">保存配置</button><button type="button" data-query>查询已保存配置</button></div></form><p data-status role="status"></p><section data-result></section>`;
 document.body.append(dialog);
 const $=s=>dialog.querySelector(s),form=$('form');let busy=false;
 for(const [key,p]of Object.entries(providers)){const o=document.createElement('option');o.value=key;o.textContent=p.name;form.elements.provider.append(o);}
 for(const [key,label]of Object.entries(fields)){
  const row=document.createElement('label');row.textContent=label;
  const input=document.createElement(key==='site'?'select':'input');input.name=key;
  if(key==='site'){for(const [value,name]of [['cn','中国站'],['intl','国际站']]){const o=document.createElement('option');o.value=value;o.textContent=name;input.append(o);}}
  else{input.type=secrets.includes(key)?'password':'text';input.autocomplete=secrets.includes(key)?'new-password':'off';input.maxLength=secrets.includes(key)?8192:128;if(secrets.includes(key))input.placeholder='已保存时留空保留';}
  row.append(input);$('[data-fields]').append(row);
 }
 function clearSecrets(){for(const k of secrets)form.elements[k].value='';form.elements.clearToken.checked=false;}
 function syncProvider(){
  const p=providers[form.elements.provider.value];
  for(const k of Object.keys(fields)){const input=form.elements[k],show=p.fields.includes(k);input.closest('label').hidden=!show;input.disabled=busy||!show;input.required=show&&p.required.includes(k);}
  form.elements.region.placeholder=p.region||'';
  form.elements.instanceId.placeholder=p.instance||'';
  form.elements.serverId.placeholder=p.serverIdHint||'';
  $('[data-clear-token]').hidden=!p.fields.includes('token');form.elements.clearToken.disabled=busy||!p.fields.includes('token');
  $('[data-provider-help]').textContent=p.help;
  $('[data-host-row]').hidden=!!p.hideHost;
  $('[data-netdata-row]').hidden=!p.hideHost;
  $('[data-host]').disabled=busy||!!p.hideHost;
  $('[data-netdata]').disabled=busy||!!p.hideHost;
 }
 async function run(fn){if(busy)return;busy=true;dialog.querySelectorAll('button,select,input').forEach(e=>e.disabled=true);try{await fn();}catch(e){$('[data-status]').textContent=e.message||String(e);}finally{busy=false;dialog.querySelectorAll('button,select,input').forEach(e=>e.disabled=false);syncProvider();}}
 form.elements.provider.onchange=()=>{clearSecrets();for(const k of Object.keys(fields).filter(k=>!secrets.includes(k)))form.elements[k].value=k==='site'?'cn':'';$('[data-result]').replaceChildren();syncProvider();$('[data-status]').textContent='服务商已切换，请填写并保存对应配置';};
 async function load(){clearSecrets();$('[data-result]').replaceChildren();const v=await api('trafficRead',{hostId:$('[data-host]').value});form.elements.provider.value=providers[v.provider]?v.provider:'tencent';for(const k of Object.keys(fields).filter(k=>!secrets.includes(k)))form.elements[k].value=v[k]||(k==='site'?'cn':'');syncProvider();
  if(v.netdataId){const n=$('[data-netdata]');for(const o of n.options)if(o.value===v.netdataId){n.value=v.netdataId;break;}}
  $('[data-status]').textContent=v.configured?'已保存 · 密钥留空保留，可直接查询':'尚未配置，请填写后保存';}
 button.onclick=()=>run(async()=>{const s=await api('state',{});const select=$('[data-host]');select.replaceChildren();for(const h of s.config.hosts){const o=document.createElement('option');o.value=h.id;o.textContent=h.name;select.append(o);}
  const netSel=$('[data-netdata]');netSel.replaceChildren();
  const netList=s.config.netdata||[];
  if(netList.length===0){const o=document.createElement('option');o.value='';o.textContent='（请先去机器管理接入 Netdata 节点）';netSel.append(o);netSel.disabled=true;}
  else{for(const i of netList){const o=document.createElement('option');o.value=i.id;o.textContent=i.name+' · '+i.url;netSel.append(o);}}
  if(netSel.disabled&&!busy)$('[data-status]').textContent='还没有接入 Netdata 节点。请去机器管理接入至少一个后再来配置';

  dialog.showModal();syncProvider();if(select.value)await load();else $('[data-status]').textContent='请先添加机器';});
 $('[data-close]').onclick=()=>dialog.close();dialog.addEventListener('close',clearSecrets);dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});$('[data-host]').onchange=()=>run(load);
 form.onsubmit=e=>{e.preventDefault();run(async()=>{const p={hostId:$('[data-host]').value,provider:form.elements.provider.value};for(const k of providers[p.provider].fields){const v=k==='netdataId'?$('[data-netdata]').value.trim():form.elements[k].value.trim();p[k]=v;}p.clearToken=form.elements.clearToken.checked;await api('trafficSave',p);clearSecrets();$('[data-status]').textContent='配置已加密保存，关闭页面或重启后仍可查询';$('[data-result]').replaceChildren();});};
 $('[data-query]').onclick=()=>run(async()=>{
  const hostId=$('[data-host]').value,saved=await api('trafficRead',{hostId});if(!saved.configured)throw Error('请先保存配置');
  const provider=form.elements.provider.value,p=providers[provider];
  if(provider!==(saved.provider||'tencent')||p.fields.filter(k=>!secrets.includes(k)).some(k=>form.elements[k].value.trim()!==(saved[k]||''))||secrets.some(k=>form.elements[k].value)||form.elements.clearToken.checked)throw Error('配置有未保存修改，请先保存');
  $('[data-status]').textContent='正在查询云服务商…';$('[data-result]').replaceChildren();
  const data=await api('trafficQuery',{hostId}),summary=data.summary;
  const divisor=summary?.divisor||1073741824,unit=divisor===1e9?'GB':'GiB';
  const n=v=>Number.isFinite(v)?(v/divisor).toLocaleString('zh-CN',{maximumFractionDigits:2}):'—';let count=0;
 if(data.provider==='localNet'){
  for(const row of data.rows||[])for(const pack of row.TrafficPackageSet||[]){
   const card=document.createElement('article');card.className='panel';
   const heading=document.createElement('h3');heading.textContent=(data.instanceName||row.InstanceId)+' 当前流量（网卡计数器，双向口径）';card.append(heading);
   const lines=[['入站 RX',pack.RxBytes],['出站 TX',pack.TxBytes]];
   for(const [label,bytes] of lines){const p=document.createElement('p');p.textContent=label.padEnd(4,'　')+' '+n(bytes)+' '+unit;card.append(p);}
   const limitGB=pack.LimitGB||0;const pct=pack.PercentUsed||0;
   const pTotal=document.createElement('p');pTotal.textContent='双向合计'+' '.repeat(2)+n(pack.TrafficUsed)+' '+unit+(limitGB>0?' （'+pct.toFixed(1)+'% / '+limitGB+' '+unit+'）':'（未设置套餐流量）');card.append(pTotal);
   const avg=pack.DailyAverage||0;
   const pAvg=document.createElement('p');pAvg.textContent=avg>0?'当前日均'+' '.repeat(2)+n(avg)+' '+unit+'/天（按近 '+(pack.PeriodDays||30)+' 天累计口径）':'当前日均'+' '.repeat(4)+'暂无数据（Netdata 累计样本不足）';card.append(pAvg);
   const days=pack.DaysRemaining||0;
   const pDays=document.createElement('p');pDays.textContent=(avg>0&&limitGB>0)?'按此速率可再用'+days.toFixed(1)+' 天':(limitGB>0?'按此速率可再用'+'暂无数据':'按此速率可再用'+'请先填写套餐流量');card.append(pDays);
   if(pack.EndTime){const pAt=document.createElement('p');pAt.textContent='查询时间：'+new Date(pack.EndTime).toLocaleString();card.append(pAt);}
   $('[data-result]').append(card);count++;
  }
 }else{
  for(const row of data.rows||[])for(const pack of row.TrafficPackageSet||[]){
   count++;const card=document.createElement('article');card.className='panel';const title=document.createElement('h3');
   const shared=summary?.scope==='account'||summary?.scope?.startsWith('region:');
   title.textContent=summary?.mode==='usage'?`本月监控已用 ${n(pack.TrafficUsed)} ${unit}`:`${shared?'共享':''}剩余 ${n(pack.TrafficPackageRemaining)} ${unit}`;
   const detail=document.createElement('p');detail.textContent=summary?.mode==='usage'?data.note||'监控用量，不代表套餐余额':`已用 ${n(pack.TrafficUsed)} / ${n(pack.TrafficPackageTotal)} ${unit} · 超额 ${n(pack.TrafficOverflow)} ${unit}`;
   const scope=document.createElement('p');scope.textContent=shared?(summary.scope==='account'?'范围：账户汇总（包含多台机器；地域独立池不可互相抵扣）':`范围：地域共享池 ${summary.scope.slice(7)}`):`范围：${row.InstanceId==='instance'?form.elements.instanceId.value||form.elements.packageId.value:row.InstanceId}`;
   card.append(title,detail,scope);
   if(pack.EndTime){const period=document.createElement('p');period.textContent='周期结束：'+new Date(pack.EndTime).toLocaleString();card.append(period);}
   $('[data-result]').append(card);
  }
 }
  $('[data-status]').textContent=(count?`${p.name} 查询完成`:'暂无流量数据')+' · '+new Date(data.at).toLocaleString();
 });
})();
