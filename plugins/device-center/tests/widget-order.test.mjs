import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const window={};vm.runInNewContext(fs.readFileSync(new URL('../ui/widget-order.js',import.meta.url),'utf8'),{window});
const order=window.FlowHubDeviceOrder;
const plain=value=>JSON.parse(JSON.stringify(value));
test('ordering retains absent devices for reconnect and appends new identities without mutating snapshots',()=>{
 const saved=['b','offline','a'],devices=[{id:'a'},{id:'b'},{id:'new'}];
 assert.deepEqual(plain(order.sort(devices,saved)).map(device=>device.id),['b','a','new']);
 assert.deepEqual(plain(order.merge(saved,devices)),['b','offline','a','new']);
 assert.deepEqual(plain(order.sort([...devices,{id:'offline'}],saved)).map(device=>device.id),['b','offline','a','new']);
 assert.deepEqual(devices.map(device=>device.id),['a','b','new']);
});
test('moving in a filtered category preserves the relative order of other categories and supports either drop edge',()=>{
 const saved=['bt-a','usb-a','bt-b','usb-b','offline'];
 assert.deepEqual(plain(order.move(saved,'usb-b','usb-a')),['bt-a','usb-b','usb-a','bt-b','offline']);
 assert.deepEqual(plain(order.move(saved,'usb-a','usb-b',true)),['bt-a','bt-b','usb-b','usb-a','offline']);
 assert.deepEqual(saved,['bt-a','usb-a','bt-b','usb-b','offline']);
 for(const [source,target] of [['missing','usb-a'],['usb-a','missing'],['usb-a','usb-a']])assert.equal(order.move(saved,source,target),saved);
});
test('the bounded identity cache drops absent entries before losing live devices',()=>{
 const saved=Array.from({length:1024},(_,i)=>'old-'+i),devices=[{id:'live'},{id:'old-0'}];
 const next=plain(order.merge(saved,devices));assert.equal(next.length,1024);assert.ok(next.includes('live'));assert.ok(next.includes('old-0'));assert.equal(new Set(next).size,next.length);
});
test('a grouped phone inherits its old route position until the phone has its own saved position',()=>{
 const phone={id:'phone',adb:{legacyIds:['old-usb','old-tcp']}};
 const devices=[{id:'monitor'},phone,{id:'mouse'}];
 const old=['old-usb','monitor','old-tcp','mouse'];
 assert.deepEqual(plain(order.sort(devices,old)).map(device=>device.id),['phone','monitor','mouse']);
 assert.deepEqual(plain(order.merge(old,devices)),['phone','monitor','mouse']);
 assert.deepEqual(plain(order.sort(devices,['old-tcp','mouse','phone','monitor'])).map(device=>device.id),['mouse','phone','monitor']);
});
