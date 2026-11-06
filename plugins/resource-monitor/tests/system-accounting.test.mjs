import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const output=await build({entryPoints:[new URL('../src/model.ts',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'esm'});
const m=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
test('system accounting survives summary/detail/card transport without changing live metrics or instance controls',()=>{
  const snapshot=m.sampleSnapshot(),g=snapshot.groups[0],before=structuredClone(g);
  g.instances=[{id:'one',root:g.processes[0],count:1,canTerminate:true},{id:'two',root:g.processes[1],count:2,canTerminate:true}];
  const controls=m.detailControls(g,undefined,'one');
  g.systemAccounting={footprint:84*2**30,coalitionCount:1,shared:true};
  const summary=m.rankingFrom(snapshot).groups.find(row=>row.id===g.id),detail=m.detailFrom(snapshot,g.id).group,status=m.statusFrom(snapshot).rows.find(row=>row.id===g.id);
  for(const row of [summary,detail,status])assert.deepEqual(row.systemAccounting,g.systemAccounting);
  assert.equal(summary.footprint,before.footprint);assert.equal(status.values.footprint,before.footprint);
  assert.deepEqual(g.processes,before.processes);assert.deepEqual(m.detailControls(g,undefined,'one'),controls);
  assert.equal(m.detailControls(g,undefined,'one').instance.id,'one');
  assert.equal(m.updateDetail(g,undefined).systemAccounting,null,'exited app must not keep an old ledger');
});
test('accounting sort keeps unknown data last, preserves active ranking and does not mutate input',()=>{
  const groups=m.sampleSnapshot().groups;groups[0].systemAccounting={footprint:100,coalitionCount:1,shared:false};groups[1].systemAccounting={footprint:200,coalitionCount:1,shared:false};
  const ids=groups.map(g=>g.id),active=m.filterGroups(groups,'',false,'footprint').map(g=>g.id);
  assert.deepEqual(m.filterGroups(groups,'',false,'accounting').slice(0,2).map(g=>g.id),[groups[1].id,groups[0].id]);
  assert.deepEqual(m.filterGroups(groups,'',false,'accounting','ascend').slice(0,2).map(g=>g.id),[groups[0].id,groups[1].id]);
  assert.deepEqual(m.widgetRows(m.statusFrom({...m.sampleSnapshot(),groups}),{sort:'accounting'}).slice(0,2).map(g=>g.id),[groups[1].id,groups[0].id]);
  assert.deepEqual(m.filterGroups(groups,'',false,'footprint').map(g=>g.id),active);assert.deepEqual(groups.map(g=>g.id),ids);
});


test('accounting availability distinguishes independent tasks, missing main apps, failed reads and valid zero',()=>{
  assert.equal(m.accountingDisplay({appPath:null}).text,'不适用');
  assert.equal(m.accountingDisplay({appPath:'/Applications/Python.app'}).text,'未获取');
  assert.equal(m.accountingDisplay({appPath:'/Applications/App.app',systemAccounting:{footprint:null,coalitionCount:1,shared:false}}).text,'暂不可读');
  const zero=m.accountingDisplay({appPath:'/Applications/App.app',systemAccounting:{footprint:0,coalitionCount:1,shared:false}});
  assert.equal(zero.available,true);assert.equal(zero.text,'0 MiB');
  assert.equal(m.accountingDisplay({appPath:'/Applications/App.app',origin:{name:'other'},systemAccounting:{footprint:123,coalitionCount:1,shared:false}}).available,false);
});
