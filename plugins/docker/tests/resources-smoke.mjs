import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import assert from 'node:assert/strict';

// Real Docker CLI + real plugin, pointed exclusively at this disposable engine fixture.
const directory=mkdtempSync('/tmp/flowhub-resource-rpc-'),socket=directory+'/engine.sock',context='flowhub-resource-test';
const id=char=>char.repeat(64),containerId=id('c');
let volumes=[{Name:'demo_data',Driver:'local',Scope:'local',CreatedAt:'2026-11-06T01:00:00Z',Mountpoint:'/volumes/demo_data',Labels:{},Options:{password:'NEVER_RETURN'}}];
let networks=[{Id:id('a'),Name:'demo_default',Driver:'bridge',Scope:'local',Internal:false,EnableIPv6:false,Created:'2026-11-06T01:00:00Z',Ingress:false,IPAM:{Config:[{Subnet:'172.21.0.0/16',Gateway:'172.21.0.1'}]},Labels:{}},
 {Id:id('b'),Name:'bridge',Driver:'bridge',Scope:'local',Internal:false,EnableIPv6:false,Created:'2026-11-06T01:00:00Z',Ingress:false,IPAM:{Config:[]},Labels:{}}];
let attached=true,requests=[],child,serial=0;const pending=new Map();
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture'),route=url.pathname.replace(/^\/v\d+\.\d+/,'');requests.push([req.method,route]);
 res.setHeader('Api-Version','1.47');res.setHeader('OSType','linux');res.setHeader('Docker-Experimental','false');
 if(route==='/_ping'){res.end('OK');return;}res.setHeader('Content-Type','application/json');
 const done=value=>res.end(JSON.stringify(value)),failure=message=>{res.statusCode=404;done({message});};
 let body='';for await(const chunk of req)body+=chunk;
 if(route==='/containers/json'){done([{Id:containerId,Names:['/demo-db'],Image:'demo:latest',ImageID:'sha256:'+id('d'),Command:'unused',Created:1,State:'exited',Status:'Exited (0)',Ports:[],Labels:{'com.docker.compose.project':'demo'},HostConfig:{NetworkMode:'demo_default'},NetworkSettings:{Networks:{}}}]);return;}
 if(route==='/containers/'+containerId+'/json'){done({Id:containerId,Name:'/demo-db',State:{Status:'exited'},Config:{Env:['NEVER_RETURN'],Labels:{'com.docker.compose.project':'demo'}},Mounts:attached?[{Type:'volume',Name:'demo_data',Destination:'/data',RW:false}]:[],NetworkSettings:{Networks:attached?{demo_default:{NetworkID:'',IPAddress:''}}:{}}});return;}
 if(route==='/volumes' && req.method==='GET'){done({Volumes:volumes,Warnings:[]});return;}
 if(route==='/volumes/create' && req.method==='POST'){const input=JSON.parse(body);assert.equal(input.Driver,'local');assert.equal(input.DriverOpts && Object.keys(input.DriverOpts).length || 0,0);const volume={Name:input.Name,Driver:'local',Scope:'local',CreatedAt:'2026-11-06T02:00:00Z',Mountpoint:'/volumes/'+input.Name,Labels:input.Labels,Options:{}};volumes.push(volume);done(volume);return;}
 if(route.startsWith('/volumes/')){const name=decodeURIComponent(route.slice('/volumes/'.length)),volume=volumes.find(row=>row.Name===name);if(!volume){failure('No such volume');return;}if(req.method==='DELETE'){assert.notEqual(url.searchParams.get('force'),'1');volumes=volumes.filter(row=>row.Name!==name);res.statusCode=204;res.end();return;}done(volume);return;}
 if(route==='/networks' && req.method==='GET'){done(networks);return;}
 if(route==='/networks/create' && req.method==='POST'){const input=JSON.parse(body);assert.equal(input.Driver,'bridge');const network={...networks[0],Id:id('e'),Name:input.Name};networks.push(network);done({Id:network.Id,Warning:''});return;}
 if(route.startsWith('/networks/')){const network=networks.find(row=>row.Id===route.slice('/networks/'.length));if(!network){failure('No such network');return;}if(req.method==='DELETE'){networks=networks.filter(row=>row.Id!==network.Id);res.statusCode=204;res.end();return;}done(network);return;}
 res.statusCode=500;done({message:'Unexpected fixture request '+req.method+' '+route});
});
function call(method,params={}){return new Promise((resolve,reject)=>{const request=++serial,timer=setTimeout(()=>{pending.delete(request);reject(Error('RPC timeout'));},15000);pending.set(request,{resolve,reject,timer});child.stdin.write(JSON.stringify({id:request,method,params})+'\n');});}
try{
 await new Promise(resolve=>server.listen(socket,resolve));
 execFileSync('docker',['--config',directory,'context','create',context,'--docker','host=unix://'+socket],{stdio:'pipe'});
 execFileSync('docker',['--config',directory,'context','use',context],{stdio:'pipe'});
 child=spawn('./bin/flowhub-docker',[],{env:{...process.env,DOCKER_CONFIG:directory},stdio:['pipe','pipe','inherit']});
 createInterface({input:child.stdout}).on('line',line=>{const response=JSON.parse(line),item=pending.get(response.id);if(!item)return;clearTimeout(item.timer);pending.delete(response.id);response.error?item.reject(Error(response.error)):item.resolve(response.result);});
 await assert.rejects(call('volume_create',{context,name:'new_data'}),/确认/);
 await assert.rejects(call('network_create',{context,name:'new_net'}),/确认/);
 await assert.rejects(call('volumes',{context:'other'}),/环境/);
 const list=await call('volumes',{context});assert.equal(list.volumes[0].references,1);
 const volume=await call('volume_detail',{context,name:'demo_data'});assert.equal(volume.containers[0].state,'exited');assert.equal(volume.containers[0].readOnly,true);assert.ok(!JSON.stringify(volume).includes('NEVER_RETURN'));
 const remove={context,name:'demo_data',typedName:'demo_data',confirmed:true,identity:volume.identity};
 await assert.rejects(call('volume_remove',{...remove,typedName:'wrong'}),/名称/);
 await assert.rejects(call('volume_remove',{...remove,identity:{...volume.identity,createdAt:'changed'}}),/身份/);
 await assert.rejects(call('volume_remove',remove),/引用/);
 const netlist=await call('networks',{context});assert.equal(netlist.networks.find(row=>row.id===id('a')).references,1);assert.equal(netlist.networks.find(row=>row.id===id('b')).removable,false);
 const net=await call('network_detail',{context,id:id('a')});assert.equal(net.containers[0].state,'exited');
 const removeNet={context,id:id('a'),name:'demo_default',typedName:'demo_default',confirmed:true};
 await assert.rejects(call('network_remove',removeNet),/引用/);
 await assert.rejects(call('network_remove',{...removeNet,id:id('b'),name:'bridge',typedName:'bridge'}),/默认网络/);
 assert.equal(requests.filter(([method])=>method==='DELETE').length,0);
 await assert.rejects(call('volume_create',{context,name:'demo_data',confirmed:true}),/同名/);
 await call('volume_create',{context,name:'new_data',confirmed:true});assert.ok((await call('volumes',{context})).volumes.some(row=>row.name==='new_data'));
 await call('network_create',{context,name:'new_net',confirmed:true});assert.ok((await call('networks',{context})).networks.some(row=>row.name==='new_net'));
 attached=false;
 await call('volume_remove',remove);assert.equal(volumes.some(row=>row.Name==='demo_data'),false);
 await call('network_remove',removeNet);assert.equal(networks.some(row=>row.Id===id('a')),false);
 assert.deepEqual(requests.filter(([method])=>method==='DELETE').map(([,route])=>route),['/volumes/demo_data','/networks/'+id('a')]);
 assert.equal(volumes.length,1);assert.equal(networks.length,2);
 console.log('PASS: real CLI + isolated engine: volume/network lists, detail, stopped references, metadata allowlist, context/confirmation/identity/protected-resource guards, create, duplicate rejection and guarded delete');
}finally{
 child?.kill();for(const item of pending.values())clearTimeout(item.timer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(directory,{recursive:true,force:true});
}
