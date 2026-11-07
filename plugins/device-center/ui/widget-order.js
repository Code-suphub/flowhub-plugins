// Device identities are opaque backend IDs. Retain absent devices so a reconnect
// restores their position; category filters only change which rows are visible.
(() => {
  const unique=ids=>[...new Set(ids.filter(id=>typeof id==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)))];
  function resolveOrder(saved,devices){
    const replacements=new Map();
    const known=new Set(saved);
    const live=new Set(devices.map(device=>device.id));
    for(const device of devices){
      if(known.has(device.id))continue;
      for(const id of device.adb?.legacyIds||[]){
        if(!live.has(id))replacements.set(id,device.id);
      }
    }
    return unique(saved.map(id=>replacements.get(id)||id));
  }
  const merge=(saved,devices)=>{const order=unique([...resolveOrder(saved,devices),...devices.map(device=>device.id)]),live=new Set(unique(devices.map(device=>device.id)));let absentSlots=Math.max(0,1024-live.size);return order.filter(id=>live.has(id)||absentSlots-->0).slice(0,1024);};
  function sort(devices,saved){const rank=new Map(resolveOrder(saved,devices).map((id,i)=>[id,i]));return devices.map((device,i)=>({device,i})).sort((a,b)=>(rank.get(a.device.id)??Infinity)-(rank.get(b.device.id)??Infinity)||a.i-b.i).map(item=>item.device);}
  function move(order,source,target,after=false){if(source===target||!order.includes(source)||!order.includes(target))return order;const next=order.filter(id=>id!==source),index=next.indexOf(target);next.splice(index+(after?1:0),0,source);return next;}
  window.FlowHubDeviceOrder={merge,sort,move};
})();
