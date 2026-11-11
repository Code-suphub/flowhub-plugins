import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundled=await build({entryPoints:[new URL('../src/history-model.ts',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'esm'});
const {historyModel}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const row=(at,cpu,footprint,rss,run=1,segment=1)=>({at,cpu,footprint,rss,run,segment});
test('history keeps separate metrics, scales memory and permits multicore CPU above 100%',()=>{
 const report={points:[row(1,250,2*1024**3,16*1024**2),row(2,null,null,0)]};
 const cpu=historyModel(report,'cpu');assert.equal(cpu.max,300);assert.deepEqual(cpu.points,[{at:1,value:250},{at:2,value:null}]);
 const footprint=historyModel(report,'footprint');assert.equal(footprint.unit,' GiB');assert.equal(footprint.points[0].value,2);assert.equal(footprint.points[1].value,null);
 const rss=historyModel(report,'rss');assert.equal(rss.unit,' MiB');assert.deepEqual(rss.points.map(p=>p.value),[16,0]);
});
test('restart and app-lifetime transitions break the line; invalid values are missing',()=>{
 const report={points:[row(1,1,1,1),row(60001,2,2,2,2),row(120001,-1,Infinity,NaN,2,2)]};
 for(const metric of ['cpu','footprint','rss']){
  const result=historyModel(report,metric);assert.equal(result.points.length,5);assert.equal(result.points[1].value,null);assert.equal(result.points[3].value,null);assert.equal(result.points[4].value,null);
 }
 assert.deepEqual(historyModel({points:[]},'cpu').points,[]);
});
