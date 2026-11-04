// The only app quit by this test is its own disposable AppKit fixture.
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,renameSync,realpathSync,rmSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import assert from 'node:assert/strict';
const root=realpathSync(mkdtempSync('/tmp/flowhub-quit-')),appPath=root+'/FlowHubQuitSmoke.app';
const contents=appPath+'/Contents',executable=contents+'/MacOS/Fixture';
let backend,helper,sequence=0;const pending=new Map(),apps=[],fixturePids=new Set();
const bundleId=`local.flowhub.quit-smoke.${process.pid}`;
function rpc(method,params={}){return new Promise((resolve,reject)=>{
  const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout'));},15000);
  pending.set(id,{resolve,reject,timer});backend.stdin.write(JSON.stringify({id,method,params})+'\n');
});}
try{
  mkdirSync(contents+'/MacOS',{recursive:true});mkdirSync(contents+'/Resources');
  writeFileSync(contents+'/Info.plist',`<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleName</key><string>FlowHubQuitSmoke</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  writeFileSync(root+'/main.swift',`import AppKit
let app = NSApplication.shared
app.setActivationPolicy(CommandLine.arguments.contains("--background") ? .prohibited : .regular)
class Delegate: NSObject, NSApplicationDelegate {
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    try? "normal quit".write(toFile: "${root}/quit-received-\\(ProcessInfo.processInfo.processIdentifier)", atomically: true, encoding: .utf8)
    return .terminateNow
  }
}
let delegate = Delegate()
app.delegate = delegate
app.run()
`);
  execFileSync('/usr/bin/xcrun',['swiftc','-framework','AppKit',root+'/main.swift','-o',executable],{stdio:'pipe'});
  copyFileSync('/bin/sleep',contents+'/Resources/background-helper');
  helper=spawn(contents+'/Resources/background-helper',['180'],{stdio:'ignore'});
  const launch=(background=false)=>{const child=spawn('/usr/bin/open',['-n','-g','-W',appPath,...(background?['--args','--background']:[])],{stdio:'ignore'});apps.push(child);return child;};
  launch();
  backend=spawn(new URL('../bin/flowhub-resource-monitor',import.meta.url).pathname,[],{stdio:['pipe','pipe','inherit']});
  createInterface({input:backend.stdout}).on('line',line=>{
    const result=JSON.parse(line),item=pending.get(result.id);if(!item)return;
    pending.delete(result.id);clearTimeout(item.timer);result.error?item.reject(Error(result.error)):item.resolve(result.result);
  });
  let group,state;
  async function read(){
    const snapshot=await rpc('refresh');group=snapshot.groups.find(group=>group.appPath===appPath);
    for(const g of snapshot.groups)for(const p of g.processes)if(p.executable.startsWith(root)&&p.executable.endsWith('/Fixture'))fixturePids.add(p.pid);
    if(group)state=await rpc('application_state',{groupId:group.id});
  }
  for(let attempt=0;attempt<30;attempt++){
    await read();if(state?.canQuit)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(state?.canQuit,'disposable GUI app must be recognized: '+JSON.stringify(state));
  const stale=await rpc('quit_preview',{groupId:group.id});
  assert.equal(stale.targets.length,1);
  const originalPid=stale.targets[0].pid;
  const named=group.processes.find(p=>p.pid===originalPid);
  assert.equal(named.name,'Fixture','keep executable basename for search and diagnostics');
  assert.equal(named.displayName,'FlowHubQuitSmoke','read the OS registered name of this exact running PID');
  // Reproduce Chrome: the running vnode moves to a signing clone, while
  // Launch Services still registers the original app/executable URL.
  const cloneRoot=`${root}/X/${bundleId}.code_sign_clone/code_sign_clone.Abc123/FlowHubQuitSmoke.app.bundle`;
  const cloneExe=cloneRoot+'/Contents/MacOS/Fixture';
  mkdirSync(cloneRoot+'/Contents/MacOS',{recursive:true});
  renameSync(executable,cloneExe);copyFileSync(cloneExe,executable);
  launch();launch(true);
  let plan,secondPlan;
  for(let attempt=0;attempt<30;attempt++){
    await read();
    if(state?.instances===2&&group.processes.filter(p=>p.executable.endsWith('/Fixture')).length===3){
      assert.equal(state.canQuit,false,'multiple GUI instances require explicit selection');
      await assert.rejects(rpc('quit_preview',{groupId:group.id}),/多个.*实例/);
      const first=group.instances.find(instance=>instance.root.pid===originalPid);
      const second=group.instances.find(instance=>state.quitInstances.includes(instance.id)&&instance.id!==first.id);
      plan=await rpc('quit_preview',{groupId:group.id,instanceId:first.id});
      secondPlan=await rpc('quit_preview',{groupId:group.id,instanceId:second.id});break;
    }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(plan?.targets.length,1,'quit preview must contain only the selected GUI instance');
  assert.equal(secondPlan.targets.length,1);
  assert.ok(group.processes.some(p=>p.pid===originalPid&&p.executable===cloneExe),'keep real executable while attributing clone');
  assert.equal(plan.appPath,appPath);
  assert.ok(plan.targets.some(p=>p.pid===originalPid));
  const backgroundPid=group.processes.find(p=>p.executable.endsWith('/Fixture')&&![...plan.targets,...secondPlan.targets].some(target=>target.pid===p.pid)).pid;
  await assert.rejects(rpc('quit_confirm',{token:stale.token,confirmed:true}),/实例|身份/);
  for(const target of plan.targets)process.kill(target.pid,0);
  await assert.rejects(rpc('quit_confirm',{token:plan.token}),/确认/);
  await assert.rejects(rpc('quit_confirm',{token:'forged',confirmed:true}),/失效/);
  const result=await rpc('quit_confirm',{token:plan.token,confirmed:true});
  assert.equal(result.requested,true);assert.equal(result.results.length,1);
  process.kill(secondPlan.targets[0].pid,0); // The other GUI instance must remain alive.
  const secondResult=await rpc('quit_confirm',{token:secondPlan.token,confirmed:true});
  assert.equal(secondResult.requested,true);assert.equal(secondResult.results.length,1);
  await Promise.race([Promise.all(apps.slice(0,2).map(child=>child.exitCode===null?once(child,'exit'):Promise.resolve())),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('fixture did not quit')),5000);timer.unref();})]);
  for(const child of apps.slice(0,2)){assert.equal(child.exitCode,0);assert.equal(child.signalCode,null);}
  for(const target of [...plan.targets,...secondPlan.targets])assert.equal((await import('node:fs')).readFileSync(`${root}/quit-received-${target.pid}`,'utf8'),'normal quit');
  assert.equal(helper.exitCode,null);assert.equal(helper.signalCode,null,'background service must remain running');
  process.kill(backgroundPid,0);
  await assert.rejects(rpc('quit_confirm',{token:plan.token,confirmed:true}),/失效/);
  await read();assert.equal(state.canQuit,false);assert.match(state.message,/无界面|后台模式/);
  process.kill(backgroundPid,'SIGTERM');
  for(let attempt=0;attempt<30;attempt++){await read();if(!group.processes.some(p=>p.pid===backgroundPid))break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(group.processes.some(p=>p.pid===helper.pid));
  assert.equal(state.canQuit,false);assert.match(state.message,/只剩后台或辅助/);
  console.log('PASS: signing-clone attribution, explicit GUI instance selection, isolated normal quit, changed-root rejection, confirmation/token checks and preserved headless/background processes');
}finally{
  backend?.stdin.end();for(const item of pending.values())clearTimeout(item.timer);
  for(const child of [...apps,helper])if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
  for(const pid of fixturePids){try{const path=execFileSync('/bin/ps',['-p',String(pid),'-o','comm='],{encoding:'utf8'}).trim();if(path.startsWith(root)&&path.endsWith('/Fixture'))process.kill(pid,'SIGTERM');}catch{}}
  rmSync(root,{recursive:true,force:true});
}
