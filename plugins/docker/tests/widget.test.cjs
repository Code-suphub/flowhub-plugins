const {test}=require('node:test');
const assert=require('node:assert/strict');
const {view}=require('../ui/widget/widget-model.js');
const snapshot={rows:[{project:'app',state:'running',status:'error'},{project:'app',state:'running',status:'healthy'},{project:'',state:'exited',status:'unknown'}]};
test('project filtering, unhealthy running count and stopped state remain distinct',()=>{
  const v=view(snapshot,{project:'app',onlyIssues:true});assert.equal(v.running,2);assert.equal(v.issues,1);assert.equal(v.stopped,0);assert.equal(v.visible.length,1);
  assert.equal(view(snapshot,{project:''}).stopped,1);assert.equal(view(snapshot,{project:'removed'}).rows.length,0);
});
test('missing and expired snapshots cannot imply healthy live data',()=>{
  assert.ok(view(null).pending);assert.ok(view({...snapshot,at:Date.now()-61000}).error);assert.equal(view({...snapshot,error:'offline'}).error,'offline');
});
test('type filter distinguishes Compose from standalone containers and intersects project selection',()=>{
  assert.equal(view(snapshot,{type:'compose'}).rows.length,2);
  assert.equal(view(snapshot,{type:'standalone'}).rows.length,1);
  assert.equal(view(snapshot,{project:'app',type:'standalone'}).rows.length,0);
  assert.equal(view(snapshot,{type:'compose',onlyIssues:true}).visible.length,1);
});
