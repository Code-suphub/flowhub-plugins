import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const result=await build({entryPoints:[new URL('../src/service-model.ts',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'esm'});
const {sameServiceProcess,restartLabel,serviceInScope}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const identity={pid:10,uid:501,started:100,executable:'/Applications/Fixture.app/helper'};
const service={id:'registered',loaded:true,identity,appPath:'/Applications/Fixture.app',restart:'always'};
test('restart evidence requires the exact live PID generation, uid and executable',()=>{
 assert.equal(sameServiceProcess(service,identity),true);
 for(const changed of [{pid:11},{uid:0},{started:101},{executable:'/Applications/Other.app/helper'}])assert.equal(sameServiceProcess(service,{...identity,...changed}),false);
 assert.equal(sameServiceProcess({...service,loaded:false},identity),false);
 assert.equal(sameServiceProcess({...service,identity:null},identity),false);
 assert.equal(restartLabel(service),'会自动重启');assert.equal(restartLabel({...service,restart:'login'}),'登录或开机启动');
});
test('service presentation never expands a selected scope by process name or source application',()=>{
 assert.equal(serviceInScope(service,{ids:['registered']}),true);
 assert.equal(serviceInScope({...service,id:'another',appPath:'/Applications/Other.app'},{ids:['registered'],appPath:service.appPath}),false);
 assert.equal(serviceInScope({...service,loaded:false,identity:null},{appPath:service.appPath}),true,'paused entries remain discoverable without a process');
 assert.equal(serviceInScope(service,{ids:[]}),false);assert.equal(serviceInScope(service),true);
});
