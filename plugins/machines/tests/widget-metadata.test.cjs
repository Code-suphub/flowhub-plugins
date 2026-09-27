const {test}=require('node:test'),assert=require('node:assert/strict');
const {flag,expiry}=require('../src/widget/metadata.cjs');
test('optional country and expiry render without fabricated defaults',()=>{assert.equal(flag('SG'),'🇸🇬');assert.equal(flag(''), '');assert.equal(flag('<x>'),'');assert.equal(expiry(null),null);assert.equal(expiry(undefined),null);});
test('countdown handles future, expired and exact expiry',()=>{assert.equal(expiry(90000000,0).text,'剩余 1 天 1 小时');assert.equal(expiry(0,3600000).text,'已过期 1 小时 0 分钟');assert.equal(expiry(0,0).text,'已到期');assert.equal(expiry(8*86400000,0).urgent,false);assert.equal(expiry(86400000,0).urgent,true);});

const {traffic}=require('../src/widget/metadata.cjs');
test('traffic distinguishes exhausted quota from missing and stale data',()=>{const at='2026-09-13T00:00:00Z',now=Date.parse(at);assert.match(traffic({remaining:0,total:1073741824,at},now).label,/0\/1 GB/);assert.match(traffic(null,now).hint,/请先配置/);assert.match(traffic({remaining:9,total:10,at},now+900001).hint,/已过期/);assert.match(traffic({error:'<script>'},now).hint,/查询失败/);assert.doesNotMatch(traffic({error:'<script>'},now).hint,/<script>/);});

test('small but nonzero cloud usage stays visible in the remaining quota',()=>{
 const at='2026-09-13T00:00:00Z',now=Date.parse(at),gib=1073741824;
 assert.equal(traffic({remaining:299.98*gib,total:300*gib,at},now).label,'299.98/300 GB');
});

test('local usage keeps its number but moves the collection caveat to the tooltip',()=>{
 const at='2026-09-13T00:00:00Z',now=Date.parse(at);
 assert.equal(traffic({mode:'usage',used:2e9,divisor:1e9,at},now).label,'2 GB');
 assert.doesNotMatch(traffic({mode:'usage',used:2e9,divisor:1e9,at},now).label,/本期/);
 assert.match(traffic({scope:'account',remaining:9e9,total:10e9,divisor:1e9,at},now).label,/共享 9\/10 GB/);
 assert.match(traffic({scope:'region:us-east',remaining:0,total:1e9,divisor:1e9,at},now).label,/共享 0\/1 GB/);
 assert.match(traffic({mode:'usage',used:2e9,at},now+900001).hint,/已过期/);
 assert.equal(traffic({mode:'usage',used:1048576,partial:true,at},now).label,'1 MiB');
 assert.match(traffic({mode:'usage',used:1048576,partial:true,at},now).title,/历史不完整/);
 assert.equal(traffic({mode:'usage',used:250*1073741824,bootBaseline:true,at},now).label,'250 GiB');
 assert.match(traffic({mode:'usage',used:250*1073741824,bootBaseline:true,at},now).title,/开机时间吻合/);
 assert.equal(traffic({mode:'usage',used:40.76*1073741824,total:500*1073741824,partial:true,at},now).label,'40.76/500 GiB');
 assert.match(traffic({mode:'usage',used:40.76*1073741824,total:500*1073741824,partial:true,at},now).title,/配置额度，不代表可用余额/);
 assert.equal(traffic({mode:'usage',used:1048576,total:500*1073741824,partial:true,at},now).label,'1 MiB/500 GiB');
});
