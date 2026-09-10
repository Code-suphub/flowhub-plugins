const {test}=require('node:test'),assert=require('node:assert/strict');
const {flag,expiry}=require('../ui/widget-metadata.js');
test('optional country and expiry render without fabricated defaults',()=>{assert.equal(flag('SG'),'🇸🇬');assert.equal(flag(''), '');assert.equal(flag('<x>'),'');assert.equal(expiry(null),null);assert.equal(expiry(undefined),null);});
test('countdown handles future, expired and exact expiry',()=>{assert.equal(expiry(90000000,0).text,'剩余 1 天 1 小时');assert.equal(expiry(0,3600000).text,'已过期 1 小时 0 分钟');assert.equal(expiry(0,0).text,'已到期');assert.equal(expiry(8*86400000,0).urgent,false);assert.equal(expiry(86400000,0).urgent,true);});
