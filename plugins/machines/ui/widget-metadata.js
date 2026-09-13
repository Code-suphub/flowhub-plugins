((root)=>{
  const flag=code=>/^[A-Z]{2}$/.test(code||'')?[...code].map(c=>String.fromCodePoint(127397+c.charCodeAt(0))).join(''):'';
  function expiry(at,now=Date.now()){
    if(!Number.isFinite(at))return null;
    const remaining=at-now,minutes=Math.ceil(Math.abs(remaining)/60000),days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60);
    const duration=days?`${days} 天 ${hours} 小时`:hours?`${hours} 小时 ${minutes%60} 分钟`:`${Math.max(1,minutes)} 分钟`;
    return {text:remaining>0?`剩余 ${duration}`:remaining===0?'已到期':`已过期 ${duration}`,urgent:remaining<=7*86400000,expired:remaining<=0};
  }
  function traffic(value,now=Date.now()){
    const stale=!value?.at||!Number.isFinite(Date.parse(value.at))||now-Date.parse(value.at)>900000;
    if(!value||value.error||stale||!Number.isFinite(value.remaining)||!Number.isFinite(value.total)||value.total<=0)return '<div class="traffic-metric">剩余流量 —<small>'+(!value?'请先配置并查询腾讯云流量':value.error?'查询失败 / 暂无有效套餐':stale?'流量数据已过期':'暂无数据')+'</small></div>';
    const fmt=n=>(n/1073741824).toLocaleString('zh-CN',{maximumFractionDigits:0});
    return '<div class="traffic-metric" title="剩余流量 / 套餐总量"><b>'+fmt(value.remaining)+'/'+fmt(value.total)+' GB</b></div>';
  }
  const api={flag,expiry,traffic};if(typeof module!=='undefined')module.exports=api;else root.MachineMetadata=api;
})(globalThis);
