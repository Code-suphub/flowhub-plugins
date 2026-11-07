import type {ReactNode} from 'react';
import {Button,HelpPopover} from '@flowhub/plugin-common/react';
import type {Device} from './model';

export function UsbTree({devices,renderCard}:{devices:Device[];renderCard:(device:Device)=>ReactNode}) {
 const ids=new Set(devices.map(device=>device.id));
 const children=new Map<string|undefined,Device[]>();
 for(const device of devices){
  const parent=device.usb?.parentId;
  const key=parent&&ids.has(parent)?parent:undefined;
  const branch=children.get(key);
  if(branch)branch.push(device);else children.set(key,[device]);
 }
 function branch(device:Device){
  const ports=children.get(device.id)??[];
  return <li key={device.id}>{renderCard(device)}
   {ports.length?<ul className="dc-usb-ports" aria-label={device.name+' 下游设备'}>{ports.map(branch)}</ul>:null}
  </li>;
 }
 return <ul className="dc-device-grid dc-usb-tree" aria-label="USB 连接树">
  {(children.get(undefined)??[]).map(branch)}
 </ul>;
}

export function UsbPath({device,devices,onOpen}:{device:Device;devices:Device[];onOpen:(device:Device)=>void}) {
 const parent=devices.find(item=>item.id===device.usb?.parentId);
 const children=devices.filter(item=>item.usb?.parentId===device.id);
 const billboard=device.usb?.function==='billboard';
 if(!parent&&!children.length&&device.kind!=='hub'&&!billboard)return null;
 return <section className="dc-usb-path" aria-label="USB 连接位置">
  <div className="dc-device-reference">
   <h4>{billboard?'USB-C 模式报告':'USB 连接位置'}</h4>
   <HelpPopover label="USB 连接位置说明">这里显示 macOS 枚举到的 USB 节点和上下游关系。一个扩展坞可以有多级 Hub；显示输出和物理线缆数量需要结合显示器信息判断。</HelpPopover>
  </div>
  {billboard?<p>此 USB 节点用于报告替代模式。这里的 USB 速率对应报告接口。</p>:null}
  <div><span>上游</span>{parent?<Button variant="ghost" className="dc-button" onClick={()=>onOpen(parent)}>{parent.name}{parent.usb?.manufacturer?' · '+parent.usb.manufacturer:''}</Button>:<strong>Mac 的 USB 总线</strong>}</div>
  {children.length?<ul aria-label="直连下游设备">{children.map(child=><li key={child.id}><Button variant="ghost" className="dc-button" onClick={()=>onOpen(child)}>{child.name}{child.usb?.manufacturer?' · '+child.usb.manufacturer:''}</Button></li>)}</ul>:null}
 </section>;
}

export function KeyboardConnections({device,devices,onOpen}:{device:Device;devices:Device[];onOpen:(device:Device)=>void}) {
 const isK75=(item:Device)=>item.keyboardModeCandidate||item.catalogKey==='kzzi-k75';
 if(!isK75(device))return null;
 const routes=devices.filter(item=>item.category!==device.category&&isK75(item));
 return <section className="dc-usb-path" aria-label="K75 连接方式">
  <div className="dc-device-reference"><h4>连接方式</h4>
   <HelpPopover label="K75 连接方式说明">有线和蓝牙由 macOS 分别枚举。同型号入口方便查看另一种连接，出现多把同型号键盘时可分别查看。</HelpPopover>
  </div>
  <div><strong>{device.category==='usb'?'USB 有线':'蓝牙'}</strong><span>{device.category==='usb'?'厂商配置接口':'输入与系统电量'}</span></div>
  {routes.length?<ul aria-label="同型号的其他连接">{routes.map(route=><li key={route.id}><Button variant="ghost" className="dc-button" onClick={()=>onOpen(route)}>{route.category==='usb'?'USB':'蓝牙'} · {route.name}</Button></li>)}</ul>:null}
 </section>;
}
