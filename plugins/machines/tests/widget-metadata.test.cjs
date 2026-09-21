const {test}=require('node:test'),assert=require('node:assert/strict');
const {flag,expiry}=require('../src/widget/metadata.cjs');
test('optional country and expiry render without fabricated defaults',()=>{assert.equal(flag('SG'),'🇸🇬');assert.equal(flag(''), '');assert.equal(flag('<x>'),'');assert.equal(expiry(null),null);assert.equal(expiry(undefined),null);});
test('countdown handles future, expired and exact expiry',()=>{assert.equal(expiry(90000000,0).text,'剩余 1 天 1 小时');assert.equal(expiry(0,3600000).text,'已过期 1 小时 0 分钟');assert.equal(expiry(0,0).text,'已到期');assert.equal(expiry(8*86400000,0).urgent,false);assert.equal(expiry(86400000,0).urgent,true);});

const {traffic}=require('../src/widget/metadata.cjs');
test('traffic distinguishes exhausted quota from missing and stale data',()=>{const at='2026-09-13T00:00:00Z',now=Date.parse(at);assert.match(traffic({remaining:0,total:1073741824,at},now).label,/0\/1 GB/);assert.match(traffic(null,now).hint,/请先配置/);assert.match(traffic({remaining:9,total:10,at},now+900001).hint,/已过期/);assert.match(traffic({error:'<script>'},now).hint,/查询失败/);assert.doesNotMatch(traffic({error:'<script>'},now).hint,/<script>/);});

test('cloud usage and shared quota cannot be confused with instance balance',()=>{
 const at='2026-09-13T00:00:00Z',now=Date.parse(at);
 assert.match(traffic({mode:'usage',used:2e9,divisor:1e9,at},now).label,/已用 2 GB/);
 assert.doesNotMatch(traffic({mode:'usage',used:2e9,divisor:1e9,at},now).label,/2\//);
 assert.match(traffic({scope:'account',remaining:9e9,total:10e9,divisor:1e9,at},now).label,/共享 9\/10 GB/);
 assert.match(traffic({scope:'region:us-east',remaining:0,total:1e9,divisor:1e9,at},now).label,/共享 0\/1 GB/);
 assert.match(traffic({mode:'usage',used:2e9,at},now+900001).hint,/已过期/);
});
