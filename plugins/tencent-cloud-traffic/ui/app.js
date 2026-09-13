(() => {
  const $ = s => document.querySelector(s);
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = v => Number.isFinite(v) ? v.toLocaleString('zh-CN',{maximumFractionDigits:2}) : '—';
  let busy = false;
  document.body.innerHTML = `<header><div><span class="eyebrow">FLOWHUB / LIGHTHOUSE</span><h1>腾讯云流量</h1><p class="hint">轻量应用服务器 · 官方套餐用量</p></div></header>
  <section class="panel"><h2>连接腾讯云</h2><p class="hint">使用具有 lighthouse:DescribeInstancesTrafficPackages 查询权限的凭证。当前版本仅在此页面会话中使用凭证，不保存到磁盘。</p>
  <form id="cfg"><div class="fields"><label>SecretId<input id="sid" autocomplete="off" required></label><label>SecretKey<input id="sk" type="password" autocomplete="new-password" required></label><label>地域<input id="region" value="ap-shanghai" required></label><label>轻量实例 ID（可选）<input id="instance" placeholder="lhins-…，留空查询该地域全部实例"></label><label>临时凭证 Token（可选）<input id="token" type="password" autocomplete="off"></label></div>
  <div class="actions"><button class="primary" id="query">查询流量</button><button type="button" id="demo">查看演示数据</button></div></form><p id="status" class="status" role="status">尚未查询。请选择实例所在地域。</p></section>
  <section class="panel"><h2>套餐流量余量</h2><p class="hint" id="source">暂无数据</p><div id="cards" class="cards"></div></section>`;
  function render(data, demo=false) {
    $('#source').textContent = demo ? '演示数据 · 非真实用量' : `腾讯云官方查询 · ${data.region} · ${new Date(data.queriedAt).toLocaleString()}`;
    $('#cards').innerHTML = (data.packages||[]).map(x=>`<article class="card"><small>${esc(x.name)}</small><div class="value">${number(x.remainGb)} GiB</div><small>剩余 · 已用 ${number(x.usedGb)} / ${number(x.totalGb)} GiB</small><div class="bar"><i style="width:${x.totalGb>0?Math.max(0,Math.min(100,x.usedGb/x.totalGb*100)):0}%"></i></div><p><small>统计周期结束：${esc(x.expires||'—')}</small></p><small>超额 ${number(x.overflowGb)} GiB · ${esc(x.status||'—')}</small></article>`).join('') || '<p class="hint">该地域或实例暂无流量包。请确认地域、实例 ID 和账号。</p>';
  }
  $('#demo').onclick=()=>{if(busy)return;render({packages:[{name:'轻量实例 · 演示',totalGb:1000,usedGb:286,remainGb:714,overflowGb:0,expires:'示例周期结束时间',status:'NETWORK_NORMAL'}]},true);$('#status').textContent='当前为演示数据，未调用腾讯云 API。';};
  $('#cfg').onsubmit=async e=>{
    e.preventDefault();if(busy)return;
    if(!window.FlowHubPlugin){$('#status').textContent='请在 FlowHub 中打开此插件；浏览器预览只支持演示。';return;}
    busy=true;$('#query').disabled=true;$('#demo').disabled=true;$('#status').textContent='正在查询腾讯云…';$('#cards').replaceChildren();$('#source').textContent='查询中';
    try{const r=await FlowHubPlugin.invoke('query',{secretId:$('#sid').value.trim(),secretKey:$('#sk').value,token:$('#token').value,region:$('#region').value.trim(),instanceId:$('#instance').value.trim()});render(r);$('#status').textContent='查询完成';}
    catch(err){$('#status').textContent='查询失败：'+err.message;$('#source').textContent='查询失败，暂无当前数据';}
    finally{busy=false;$('#query').disabled=false;$('#demo').disabled=false;}
  };
})();
