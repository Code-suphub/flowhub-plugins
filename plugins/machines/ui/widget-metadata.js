((root)=>{
  const flag=code=>/^[A-Z]{2}$/.test(code||'')?[...code].map(c=>String.fromCodePoint(127397+c.charCodeAt(0))).join(''):'';
  function expiry(at,now=Date.now()){
    if(!Number.isFinite(at))return null;
    const remaining=at-now,minutes=Math.ceil(Math.abs(remaining)/60000),days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60);
    const duration=days?`${days} 天 ${hours} 小时`:hours?`${hours} 小时 ${minutes%60} 分钟`:`${Math.max(1,minutes)} 分钟`;
    return {text:remaining>0?`剩余 ${duration}`:remaining===0?'已到期':`已过期 ${duration}`,urgent:remaining<=7*86400000,expired:remaining<=0};
  }
  const api={flag,expiry};if(typeof module!=='undefined')module.exports=api;else root.MachineMetadata=api;
})(globalThis);
