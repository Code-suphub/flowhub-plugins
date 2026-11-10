(async()=>{
  const checks=[],errors=[];
  const assert=(condition,message)=>{if(!condition)throw Error(message);};
  const wait=async(predicate,message)=>{for(let i=0;i<150;i++){if(predicate())return;await new Promise(done=>setTimeout(done,10));}throw Error(message);};
  const frames=[];
  const token='card-test-token';
  const snapshot={at:Date.now(),system:{totalMemory:34359738368,swapUsed:1048576},rows:Array.from({length:28},(_,index)=>({
    id:`app:${index}`,name:`Application ${index}`,appPath:index===27?'/Applications/Test.app':index===25?'/Applications/Unavailable.app':null,iconKey:index===26?'python':null,
    at:Date.now(),count:index+1,instanceCount:2,incomplete:false,systemAccounting:index===25?{footprint:84*1073741824,coalitionCount:1,shared:false}:null,values:{memory:index*1048576,rss:index*1048576,footprint:index*2097152,cpu:index}
  }))};
  const nativeIcon='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOWQAAAAASUVORK5CYII=';
  let current=snapshot;
  let includeSystem=false;
  let sorting={key:'cpu',order:'descend'};
  const systemRow={...snapshot.rows[0],id:'system:window-server',name:'WindowServer'};
  const changeView=params=>{
    if(typeof params.includeSystem==='boolean')includeSystem=params.includeSystem;
    if(params.sorting)sorting=params.sorting;
  };
  const fixtureProcesses=[101,102,103].map((pid,index)=>({pid,started:1700000000000000+pid,uid:index===2?0:501,name:index===2?'root-helper':'worker',executable:'/Applications/Codex.app/Contents/MacOS/worker',ppid:1,parentName:'launchd',cwd:'',role:'fixture',attribution:'fixture',avd:'',groupId:'app:codex',instanceId:`instance-${pid}`,memory:1048576,footprint:2097152,cpu:0,protected:index===2,protection:index===2?'其他用户或系统账户':''}));
  const fixtureGroup={id:'app:codex',name:'Codex',source:'fixture',memory:3145728,footprint:6291456,cpu:0,appPath:'/Applications/Codex.app',processes:fixtureProcesses,instances:fixtureProcesses.map(p=>({id:p.instanceId,root:p,count:1,memory:p.memory,footprint:p.footprint,cpu:0,canTerminate:!p.protected})),system:false,canTerminate:false,incomplete:false};
  const {processes:unusedProcesses,instances:unusedInstances,...fixtureSummary}=fixtureGroup;
  const fixtureService={id:'a'.repeat(64),label:'test.fixture-service',name:'Fixture service',domain:'gui/501',plistPath:'/Library/LaunchAgents/test.fixture-service.plist',program:fixtureProcesses[0].executable,appPath:'/Applications/Codex.app',restart:'always',restartHint:'服务会自动重新启动',loaded:true,paused:false,identity:fixtureProcesses[0],canStop:true,canResume:false,blockedReason:''};
  const mysqlStartup={id:'homebrew.mxcl.mysql',name:'MySQL',kind:'mysql',state:'enabled',revision:'a'.repeat(64),loaded:true};
  const postgresStartup={id:'homebrew.mxcl.postgresql@14',name:'PostgreSQL 14',kind:'postgresql',state:'enabled',revision:'1'.repeat(64),loaded:true,keepAlive:true,pid:63742};
  const postgresProcess={...fixtureProcesses[0],pid:63742,name:'postgres',executable:'/opt/homebrew/Cellar/postgresql@14/14.19/bin/postgres',groupId:'postgres',instanceId:'instance-63742'};
  const postgresSummary={...fixtureSummary,id:'postgres',name:'PostgreSQL 14',appPath:null,processCount:1,instanceCount:1};
  const postgresGroup={...postgresSummary,processes:[postgresProcess],instances:[{...fixtureGroup.instances[0],id:postgresProcess.instanceId,root:postgresProcess}]};
  const onedriveStartup={id:'com.microsoft.OneDriveLauncher',name:'OneDrive',kind:'onedrive',state:'enabled',revision:null};
  const vivoAgent={id:'com.vivo.pcsuite.SyncService',name:'vivo 同步服务',kind:'vivo',state:'enabled',revision:'c'.repeat(64)};
  const vivoWatch={id:'com.vivo.control.watch',name:'vivo 远控守护服务',kind:'vivo',state:'enabled',revision:'d'.repeat(64),system:true};
  const vivoLogin={id:'com.vivo.control.serviceAgentLogin',name:'vivo 登录窗口远控服务',kind:'vivo',state:'unknown',revision:null,blockedReason:'此服务在 macOS 登录窗口运行，当前用户会话无法配置。'};
  const finderExtension={id:'test.finder',name:'测试访达扩展',appPath:'/Applications/Codex.app',bundlePath:'/Applications/Codex.app/Contents/PlugIns/Finder.appex',state:'enabled',runningCount:1,revision:'finder-enabled'};
  const otherExtension={id:'other.finder',name:'另一应用的扩展',appPath:'/Applications/Other.app',bundlePath:'/Applications/Other.app/Contents/PlugIns/Finder.appex',state:'disabled',runningCount:0,revision:null};
  let servicePlan;
  const hosts=new Map();
  addEventListener('message',event=>{
    const host=hosts.get(event.source);if(!host)return;
    const data=event.data;host.messages.push(data);
    if(data.type==='flowhub:request') {
      if(data.method===host.failMethod){delete host.failMethod;event.source.postMessage({type:'flowhub:response',id:data.id,error:'Error: fixture request failure'},'*');return;}
      if(data.method==='finder_extensions_snapshot'||data.method==='finder_extension_set'){
        const update=data.method==='finder_extension_set';
        if(update){
          assert(data.params.id===finderExtension.id&&data.params.confirmed&&data.params.revision===finderExtension.revision,'Finder update lost confirmed registration');
          finderExtension.state=data.params.enabled?'enabled':'disabled';
          finderExtension.revision='finder-'+finderExtension.state;
          finderExtension.runningCount=0;
        }
        const result=update?{enabled:data.params.enabled,runningCount:finderExtension.runningCount}:{rows:[finderExtension,otherExtension]};
        event.source.postMessage({type:'flowhub:response',id:data.id,result},'*');return;
      }
      if(data.method==='privileged_status'){
        event.source.postMessage({type:'flowhub:response',id:data.id,result:{ok:true,status:'enabled',message:'已授权',checking:true,vivoStartupSupported:true,vivoStartupControl:true}},'*');return;
      }
      if(['startup_snapshot','startup_set','startup_stop','login_items_settings'].includes(data.method)){
        let result={ok:true};
        if(data.method==='startup_snapshot')result={rows:[mysqlStartup,postgresStartup,onedriveStartup,vivoAgent,vivoWatch,vivoLogin]};
        if(data.method==='startup_set'){
          const row=[mysqlStartup,postgresStartup,vivoAgent,vivoWatch].find(row=>row.id===data.params.id);
          assert(data.params.confirmed&&row&&data.params.revision===row.revision,'startup confirmation lost its exact service and revision');
          row.state=data.params.enabled?'enabled':'disabled';
          row.revision=(data.params.enabled?'a':'b').repeat(64);
          if(row===mysqlStartup||row===postgresStartup)row.stopRevision=row.loaded&&!data.params.enabled?(row===mysqlStartup?'e':'f').repeat(64):undefined;
          result={enabled:data.params.enabled,processChanged:false};
        }
        if(data.method==='startup_stop'){
          const row=[mysqlStartup,postgresStartup].find(row=>row.id===data.params.id);
          assert(data.params.confirmed&&row&&data.params.revision===row.stopRevision&&row.loaded&&row.state==='disabled','stop lost the exact disabled, loaded database service');
          row.loaded=false;delete row.stopRevision;delete row.keepAlive;delete row.pid;
        }
        event.source.postMessage({type:'flowhub:response',id:data.id,result},'*');return;
      }
      if(['services_snapshot','service_preview','service_confirm'].includes(data.method)){
        if(data.method==='services_snapshot'){
          assert(!host.serviceReading,'duplicate background-service reads');host.serviceReading=true;
          setTimeout(()=>{host.serviceReading=false;event.source.postMessage({type:'flowhub:response',id:data.id,result:{at:Date.now(),supported:true,services:[fixtureService]}},'*');},75);return;
        }
        assert(!host.serviceReading,'service operation raced an unfinished list read');
        let payload;
        if(data.method==='services_snapshot')payload={at:Date.now(),supported:true,services:[fixtureService]};
        if(data.method==='service_preview'){assert(data.params.id===fixtureService.id,'service scope changed');servicePlan={token:'12345678-1234-4234-8234-123456789abc',expiresIn:60,action:data.params.action,service:{...fixtureService}};payload=servicePlan;}
        if(data.method==='service_confirm'){assert(data.params.token===servicePlan?.token&&data.params.confirmed===true,'service confirmation lost exact token');const paused=servicePlan.action==='stop';Object.assign(fixtureService,{loaded:!paused,paused,identity:paused?null:fixtureProcesses[0],canStop:!paused,canResume:paused});payload={ok:true,message:paused?'后台服务已暂停':'后台服务已恢复'};}
        event.source.postMessage({type:'flowhub:response',id:data.id,result:payload},'*');return;
      }
      const at=Date.now(),owner={pid:100,started:(at-100000)*1000,uid:501,name:'FlowHub',executable:'/Applications/FlowHub.app/Contents/MacOS/flowhub-tauri',appPath:'/Applications/FlowHub.app'},script={pid:101,started:(at-50000)*1000,uid:501,name:'osascript',executable:'/usr/bin/osascript',appPath:null};
      const scriptRecords=[{id:'running',process:script,chain:[owner,script],source:{name:'FlowHub',appPath:owner.appPath,evidence:'已核验当前父进程链'},responsible:owner,firstSeen:at-50000,lastSeen:at,running:true,chainNote:''},{id:'recent',process:{...script,pid:99},chain:[{...script,pid:99}],source:null,responsible:null,firstSeen:at-100000,lastSeen:at-50000,running:false,chainNote:''}];
      if(data.method.startsWith('script_observer_')){
        if(data.method==='script_observer_config'){
          if(typeof data.params.enabled==='boolean')host.observerEnabled=data.params.enabled;
          if(typeof data.params.keychainNames==='boolean')host.keychainNames=data.params.keychainNames;
        }
        const observation={id:'auth-fixture',windowId:42,owner:script,firstSeen:at-3000,lastSeen:at,visible:true,candidateCount:1,requestApp:host.keychainNames?'Arc':null};
        const result=data.method==='script_observer_event'?{...observation,candidates:[scriptRecords[0]],canReplay:true}:data.method==='script_observer_replay'?{shown:true}:{supported:true,enabled:host.observerEnabled!==false,keychainNames:host.keychainNames===true,available:true,revision:at,at,interval:1,records:scriptRecords,observations:[observation]};
        event.source.postMessage({type:'flowhub:response',id:data.id,result},'*');return;
      }
      if(data.method==='set_view_preferences')changeView(data.params);
      const result=data.method==='script_activity'?{at,records:scriptRecords}:data.method==='application_metadata'?{applications:[]}:{at,groups:[{id:'app:codex',name:'Codex',source:'fixture',memory:1048576,footprint:2097152,cpu:1,processes:[],processCount:0,instanceCount:0,system:false,canTerminate:false,incomplete:false}],query:data.params?.query??'',includeSystem,sorting,hasRestrictedProcesses:false,matchedGroupIds:[],system:{},interval:5,memoryMetric:'footprint'};
      const group=data.params?.groupId==='postgres'?postgresGroup:fixtureGroup;
      const rankingGroups=[{...fixtureSummary,processCount:3,instanceCount:3},postgresSummary];
      if(includeSystem)rankingGroups.push({...postgresSummary,id:systemRow.id,name:systemRow.name,system:true});
      const payload=data.method==='group_detail'?{at,groupId:group.id,group,elsewhere:[],contextProcesses:[]}:data.method==='application_state'?{canQuit:false,message:'fixture'}:data.method==='terminate_preview'?{token:'fixture-review-only',expiresIn:30,targets:fixtureProcesses.filter(p=>data.params.instanceIds.includes(p.instanceId)),scope:{kind:'instances',name:'Codex',instances:fixtureGroup.instances.filter(i=>data.params.instanceIds.includes(i.id))}}:['ranking_snapshot','set_view_preferences'].includes(data.method)?{...result,groups:rankingGroups}:result;
      if(data.method==='terminate_confirm')throw Error('browser fixture must never execute termination');
      event.source.postMessage({type:'flowhub:response',id:data.id,result:payload},'*');return;
    }
    if(data.type!=='flowhub:widget-rpc')return;
    let result;
    if(data.params.action==='snapshot')result={...current,sorting,rows:includeSystem?[...current.rows,systemRow]:current.rows};
    else if(data.params.method==='set_view_preferences'){changeView(data.params.params);result={sorting,includeSystem};}
    else if(data.params.action==='configureCard'){
      if(host.failSave){
        host.failSave=false;
        host.send({type:'flowhub:widget-result',id:data.id,error:'模拟磁盘保存失败'});
        return;
      }
      host.config={...host.config,...data.params.patch};
      host.send({type:'flowhub:widget-init',context:{config:host.config,snapshot:current,canSaveConfig:true}});
      result={saved:true};
    }
    else if(data.params.method==='application_metadata')result={applications:[{path:'/Applications/Test.app',name:'Native Test',bundleId:'fixture.app',iconUrl:nativeIcon}]};
    else if(data.params.method==='diagnostic_event')result={ok:true};
    else {errors.push(`unexpected RPC: ${JSON.stringify(data.params)}`);return;}
    event.source.postMessage({type:'flowhub:widget-result',token,id:data.id,result},'*');
  });
  const frame=async(name,hosted=false)=>{
    const element=document.createElement('iframe');element.style.cssText='width:380px;height:320px;border:0';
    element.src=`/ui/${name}?probe=1${hosted?'':'&preview=1'}${hosted?'#flowhubWidgetToken='+token:''}`;
    document.body.append(element);frames.push(element);
    const host={element,messages:[],send(data){element.contentWindow.postMessage({token,...data},'*');}};
    hosts.set(element.contentWindow,host);
    await wait(()=>element.contentDocument?.querySelector('#root')&&element.contentWindow.__probe,'frame failed to load');
    return host;
  };
  const doc=host=>host.element.contentDocument;
  const rows=host=>[...doc(host).querySelectorAll('.widget-row')];
  try {
    const host=await frame('widget-card.html',true);
    await wait(()=>host.messages.some(message=>message.type==='flowhub:widget-ready'),'widget-ready missing');
    await wait(()=>doc(host).body.textContent.includes('正在连接 FlowHub'),'connection placeholder missing');
    assert(!host.messages.some(message=>message.type==='flowhub:widget-rpc'),'RPC ran before context initialization');
    host.send({type:'flowhub:widget-init',token:'wrong',context:{snapshot}});
    await new Promise(done=>setTimeout(done,20));
    assert(rows(host).length===0,'invalid token initialized card');
    host.config={title:'Configured title',limit:5};
    host.send({type:'flowhub:widget-init',context:{title:'Host title',config:host.config,snapshot,canSaveConfig:true}});
    await wait(()=>rows(host).length===28&&rows(host)[0].textContent.includes('Native Test'),'initial context or metadata missing');
    assert(doc(host).querySelector('.widget-header strong').textContent==='Configured title','configured title lost');
    assert(rows(host).every(row=>!row.disabled),'live card navigation disabled');
    assert(rows(host)[0].querySelector('img')?.src===nativeIcon,'native application icon missing');
    assert(rows(host)[0].querySelectorAll('.numeric').length===1&&rows(host)[0].textContent.includes('27.0%'),'default card must show only CPU');
    assert(!rows(host)[0].textContent.includes('进程'),'default card retained process counts');
    assert(rows(host)[1].querySelector('img')?.src.startsWith('data:image/svg+xml'),'bundled runtime icon missing');
    assert(rows(host).at(-1).querySelector('.app-mark').textContent==='A','initial fallback missing');
    const list=doc(host).querySelector('.widget-list');
    assert(list.scrollHeight>list.clientHeight&&list.clientHeight>0,'full list no longer scrolls');
    list.scrollTop=list.scrollHeight;
    assert(list.scrollTop>0&&doc(host).querySelector('footer').getBoundingClientRect().bottom<=320,'scroll pushed footer outside card');
    rows(host)[0].click();doc(host).querySelector('footer button').click();
    await wait(()=>host.messages.filter(message=>message.type==='flowhub:widget-navigate').length===2,'navigation missing');
    const navigation=host.messages.filter(message=>message.type==='flowhub:widget-navigate');
    assert(navigation[0].selection.groupId==='app:27'&&Object.keys(navigation[1].selection).length===0,'detail selection changed');
    checks.push('handshake/token/context; 28-row scroll; metadata/runtime/fallback icons; detail navigation');

    host.element.scrollIntoView({block:'center'});
    const settingsButton=doc(host).querySelector('.widget-settings-trigger');
    list.focus();
    settingsButton.click();
    const settings=()=>doc(host).querySelector('dialog.widget-settings-dialog[open]');
    await wait(settings,'display settings did not open');
    const settingButton=label=>[...settings().querySelectorAll('button')].find(button=>button.textContent===label);
    const metricCheckbox=label=>[...settings().querySelectorAll('label')].find(field=>field.textContent===label).querySelector('input');
    const sortButton=label=>doc(host).querySelector(`.widget-sort[aria-label="按${label}排序"]`);
    assert(!settings().textContent.includes('排序依据'),'sorting still appears in display settings');
    settingButton('前 3').click();
    await wait(()=>rows(host).length===3,'quick range did not select top three');
    const backgroundOf=element=>host.element.contentWindow.getComputedStyle(element).backgroundColor;
    await wait(()=>settingButton('前 3').getAttribute('aria-pressed')==='true'&&backgroundOf(settingButton('前 3'))!==backgroundOf(settingButton('完整列表')),'selected range did not get a visible fill');
    settingButton('完整列表').click();
    await wait(()=>rows(host).length===28,'quick range did not restore complete list');
    metricCheckbox('活跃足迹').click();
    metricCheckbox('RSS').click();
    metricCheckbox('系统归属记账').click();
    settings().dispatchEvent(new Event('cancel',{cancelable:true}));
    await wait(()=>!settings()&&doc(host).activeElement===settingsButton,'settings did not restore the clicked opener');
    sortButton('系统归属记账').click();
    await wait(()=>sortButton('系统归属记账').getAttribute('aria-pressed')==='true'&&rows(host)[0].textContent.includes('84.00 GiB'),'accounting column header did not sort by its metric');
    sortButton('活跃足迹').click();
    await wait(()=>sortButton('活跃足迹').getAttribute('aria-pressed')==='true','footprint column header did not become active');
    assert(sortButton('系统归属记账'),'switching sort unexpectedly hid the accounting column');
    for(const width of [315,260]) {
      host.element.style.width=width+'px';
      const line=rows(host)[0],identity=line.querySelector('.widget-identity').getBoundingClientRect();
      assert([...line.querySelectorAll('.numeric')].every(metric=>{
        const bounds=metric.getBoundingClientRect();
        return Math.abs(bounds.top+bounds.height/2-identity.top-identity.height/2)<1;
      }),'name and metrics must remain on the same row at '+width+'px');
      assert(doc(host).querySelector('.widget-columns .widget-identity').getBoundingClientRect().width>0,'narrow card lost its application header');
    }
    host.element.style.width='380px';
    settingsButton.click();
    await wait(settings,'could not reopen display settings');
    metricCheckbox('活跃足迹').click();
    await wait(()=>!sortButton('活跃足迹')&&doc(host).querySelector('footer').textContent.includes('按活跃足迹 ↓'),'hidden metric changed the shared sort');
    await wait(()=>host.config.showFootprint===false&&host.config.showRss===true,'metrics were not saved');
    host.failSave=true;
    settingButton('前 5').click();
    await wait(()=>doc(host).body.textContent.includes('卡片设置未保存'),'save failure was not visible');
    assert(host.config.display==='all','failed save changed the persisted range');
    settings().dispatchEvent(new Event('cancel',{cancelable:true}));
    await wait(()=>!settings(),'display settings did not dismiss');
    [...doc(host).querySelectorAll('button')].find(button=>button.textContent==='重试').click();
    await wait(()=>host.config.display==='top'&&host.config.limit===5&&!doc(host).body.textContent.includes('卡片设置未保存'),'retry did not persist the range');
    const reopened=await frame('widget-card.html',true);
    await wait(()=>reopened.messages.some(message=>message.type==='flowhub:widget-ready'),'reopened card not ready');
    reopened.send({type:'flowhub:widget-init',context:{config:host.config,snapshot,canSaveConfig:true}});
    await wait(()=>rows(reopened).length===5&&doc(reopened).querySelector('.widget-sort[aria-label="按RSS排序"]'),'reopened card did not read saved range and metrics');
    assert(doc(reopened).querySelector('footer').textContent.includes('按活跃足迹 ↓'),'reopened card did not read shared sort');
    settingsButton.click();
    await wait(settings,'could not reopen to restore the full range');
    settingButton('完整列表').click();
    await wait(()=>rows(host).length===28&&host.config.display==='all','full range was not restored');
    settings().dispatchEvent(new Event('cancel',{cancelable:true}));
    await wait(()=>!settings(),'display settings did not dismiss');
    checks.push('CPU default; header sorting; range and metrics saved in place; persistence after remount; save failure and retry; narrow layout and opener focus');

    host.send({type:'flowhub:theme',theme:'light'});
    await wait(()=>doc(host).documentElement.dataset.theme==='light','light theme missing');
    const background=host.element.contentWindow.getComputedStyle(doc(host).querySelector('.widget')).backgroundColor;
    assert(background==='rgb(255, 255, 255)','card does not consume shared light palette');
    host.send({type:'flowhub:theme',theme:'dark'});
    await wait(()=>doc(host).documentElement.dataset.theme==='dark','dark theme missing');
    assert(host.element.contentWindow.getComputedStyle(doc(host).querySelector('.widget')).backgroundColor!==background,'dark palette did not update');
    checks.push('host light/dark theme without Ant Design provider');

    current={...snapshot,at:snapshot.at+100,rows:snapshot.rows.map(row=>({...row,name:row.name+' updated'}))};
    host.element.contentWindow.__probe.poll();
    await wait(()=>rows(host).at(-1).textContent.includes('updated'),'status polling update missing');
    host.send({type:'flowhub:widget-init',context:{config:{title:'CPU top',sort:'cpu',display:'top',limit:3},snapshot:{...snapshot,at:snapshot.at-100}}});
    await wait(()=>rows(host).length===3,'top-N configuration missing');
    assert(rows(host)[1].textContent.includes('updated'),'old context replaced newer status');
    host.send({type:'flowhub:widget-init',context:{config:{title:'Focus',groupId:'app:5'},snapshot:current}});
    await wait(()=>rows(host).length===1&&rows(host)[0].textContent.includes('Application 5 updated'),'focus configuration missing');
    host.send({type:'flowhub:widget-init',context:{preview:true,config:{},snapshot:current}});
    await wait(()=>rows(host).length===28&&rows(host).every(row=>row.disabled),'host preview is not read-only');
    const previousNavigation=host.messages.filter(message=>message.type==='flowhub:widget-navigate').length;
    rows(host)[0].click();doc(host).querySelector('footer button').click();
    assert(host.messages.filter(message=>message.type==='flowhub:widget-navigate').length===previousNavigation,'preview posted navigation');
    checks.push('status polling; newer snapshot retained; top-N/focus/title config; hosted read-only preview');

    const probe=host.element.contentWindow.__probe,listeners=probe.listeners.size;
    host.element.contentWindow.dispatchEvent(new Event('pagehide'));
    assert(doc(host).querySelector('#root').childElementCount===0,'root not unmounted');
    assert(probe.listeners.size===listeners-1,'API message listener not removed');
    assert(![...probe.timeouts.values()].some(timer=>[5000,20000].includes(timer.delay)),'poll/RPC timer leaked');
    host.send({type:'flowhub:widget-init',context:{snapshot}});
    await new Promise(done=>setTimeout(done,20));
    assert(doc(host).querySelector('#root').childElementCount===0,'disposed card rendered again');
    checks.push('pagehide root/listener/poll/RPC cleanup');

    const preview=await frame('widget-card.html');
    await wait(()=>rows(preview).length>0,'browser card preview failed');
    assert(rows(preview).every(row=>row.disabled),'browser preview is writable');
    assert(!preview.messages.some(message=>message.type==='flowhub:widget-rpc'),'browser preview posted RPC');
    checks.push('browser card preview');

    const editor=await frame('widget-editor.html',true);
    await wait(()=>editor.messages.some(message=>message.type==='flowhub:widget-ready'),'editor ready missing');
    editor.send({type:'flowhub:widget-save',id:'before-init'});
    await wait(()=>editor.messages.some(message=>message.id==='before-init'),'save callback was not registered before ready');
    assert(!editor.messages.find(message=>message.id==='before-init').error,'early editor save failed');
    editor.send({type:'flowhub:widget-init',context:{preview:true,config:{title:'Saved title',sort:'cpu',display:'top',limit:3,showFootprint:true,showRss:true,showAccounting:true,groupId:'app:5'},snapshot}});
    await wait(()=>doc(editor).querySelector('input')?.value==='Saved title','editor context missing');
    editor.send({type:'flowhub:widget-save',id:'configured'});
    await wait(()=>editor.messages.some(message=>message.id==='configured'),'configured editor save missing');
    const saved=editor.messages.find(message=>message.id==='configured').config;
    assert(saved.title==='Saved title'&&saved.sort==='cpu'&&saved.display==='top'&&saved.limit===3&&saved.showFootprint&&saved.showRss&&saved.showAccounting&&saved.groupId==='app:5','saved configuration changed');
    checks.push('editor early save registration and initialized configuration');

    const main=await frame('index.html');
    await wait(()=>doc(main).querySelector('.ant-table-row'),'management preview failed');
    const systemSwitch=doc(main).querySelector('[role=switch]');
    const showsSystem=(surface,selector)=>[...doc(surface).querySelectorAll(selector)].some(row=>row.textContent.includes('WindowServer'));
    reopened.send({type:'flowhub:widget-init',context:{config:{display:'all'},snapshot:current}});
    systemSwitch.click();
    await wait(()=>showsSystem(main,'.ant-table-row'),'ranking did not enable system processes');
    reopened.element.contentWindow.__probe.poll();
    await wait(()=>showsSystem(reopened,'.widget-row'),'card did not enable system processes');
    reopened.send({type:'flowhub:widget-init',context:{config:{display:'all',title:'System card'},snapshot:{...current,at:current.at+1}}});
    await wait(()=>doc(reopened).querySelector('.widget-header strong').textContent==='System card','card did not receive new host context');
    assert(showsSystem(reopened,'.widget-row'),'application-only context replaced shared visibility');
    systemSwitch.click();
    await wait(()=>!showsSystem(main,'.ant-table-row'),'ranking did not hide system processes');
    reopened.element.contentWindow.__probe.poll();
    await wait(()=>!showsSystem(reopened,'.widget-row'),'card did not hide system processes');
    checks.push('ranking toggle synchronizes the card in both directions and survives context refresh');
    const rankingHeader=label=>[...doc(main).querySelectorAll('.ant-table-thead th')].find(th=>th.textContent.trim()===label);
    rankingHeader('进程数').click();
    await wait(()=>rankingHeader('进程数').getAttribute('aria-sort')==='descending','process-count sort did not become active');
    reopened.element.contentWindow.__probe.poll();
    await wait(()=>doc(reopened).querySelector('footer').textContent.includes('按进程数 ↓'),'card did not follow a hidden ranking metric');
    const reopenedCpu=doc(reopened).querySelector('.widget-sort[aria-label="按CPU排序"]');
    reopenedCpu.click();
    await wait(()=>reopenedCpu.textContent.includes('↓'),'card CPU sort did not become active');
    reopenedCpu.click();
    await wait(()=>reopenedCpu.textContent.includes('↑'),'card CPU sort did not switch direction');
    main.element.contentWindow.__probe.poll();
    await wait(()=>rankingHeader('CPU').getAttribute('aria-sort')==='ascending','ranking did not follow card sort and direction');
    reopenedCpu.click();
    await wait(()=>reopenedCpu.textContent.includes('↓'),'card did not restore CPU descending');
    checks.push('shared ranking metric and direction; hidden metrics stay sorted without adding a column');
    // Modal leave motion needs animation frames; Chrome throttles an offscreen iframe.
    main.element.scrollIntoView({block:'center'});
    const scriptEntry=[...doc(main).querySelectorAll('button')].find(button=>button.textContent==='脚本来源');
    assert(scriptEntry,'script source entry missing');scriptEntry.click();
    await wait(()=>doc(main).querySelectorAll('.script-record').length===2,'script drawer did not load preview activity');
    assert(doc(main).querySelector('.ant-drawer-title').textContent==='脚本来源','script drawer title missing');
    doc(main).querySelector('.script-record-toggle').click();
    await wait(()=>doc(main).querySelectorAll('.script-chain li').length===2,'verified script launch chain missing');
    assert(doc(main).querySelector('.script-record-detail').textContent.includes('/usr/bin/osascript'),'script executable missing');
    assert(doc(main).querySelector('.script-drawer').textContent.includes('不能证明它是弹窗发起方'),'script activity is mislabeled as authorization');
    [...doc(main).querySelectorAll('.ant-drawer .ant-tabs-tab')].find(tab=>tab.textContent.includes('本次可见')).click();
    await wait(()=>doc(main).querySelectorAll('.script-record').length===1,'running script filter missing');
    [...doc(main).querySelectorAll('.ant-drawer .ant-tabs-tab')].find(tab=>tab.textContent.includes('认证窗口')).click();
    await wait(()=>doc(main).querySelector('.script-record-toggle')?.textContent.includes('来源待核实'),'authentication observation missing');
    doc(main).querySelector('.script-record-toggle').click();
    await wait(()=>doc(main).body.textContent.includes('不是已确认的发起方'),'candidate ambiguity missing');
    await wait(()=>doc(main).querySelector('.script-record-detail details'),'frozen script evidence missing');
    assert(doc(main).querySelector('.script-record-detail details').open,'the only source clue should open with its chain visible');
    assert(doc(main).querySelector('.script-record-detail').textContent.includes('/usr/bin/osascript'),'observed script chain missing');
    [...doc(main).querySelectorAll('button')].find(button=>button.textContent==='重看右上角提示').click();
    await wait(()=>main.messages.some(message=>message.method==='script_observer_replay'&&message.params.id==='auth-fixture'),'replay did not select the observed window');
    const keychainSwitch=doc(main).querySelector('[aria-label="识别钥匙串请求应用"]');
    assert(keychainSwitch.getAttribute('aria-checked')==='false','keychain source observation should default to off');
    keychainSwitch.click();
    await wait(()=>doc(main).querySelector('.script-record-toggle')?.textContent.includes('钥匙串访问 · Arc'),'keychain requester missing from authorization history');
    assert(doc(main).querySelector('.script-record-detail').textContent.includes('/usr/bin/osascript'),'keychain evidence replaced the independent script chain');
    assert(main.messages.filter(message=>message.method==='script_observer_config'&&message.params.keychainNames===true).length===1,'keychain observation should configure once');
    const observationSwitch=doc(main).querySelector('[aria-label="自动观察与右上角提示"]');observationSwitch.click();
    await wait(()=>observationSwitch.getAttribute('aria-checked')==='false','observer switch did not pause');
    assert(main.messages.filter(message=>message.method==='script_observer_config'&&message.params.enabled===false).length===1,'observer switch duplicated its write');
    doc(main).querySelector('.ant-drawer-close').click();
    await wait(()=>!doc(main).querySelector('.script-drawer'),'script drawer did not close');
    checks.push('script source drawer; source app; launch chain; recent/running records; close cleanup');
    doc(main).querySelector('button[aria-label="查看 Codex 进程"]').click();
    await wait(()=>doc(main).querySelector('input[aria-label="选择实例 PID 103"]'),'instance checkboxes missing');
    await wait(()=>doc(main).querySelector('.detail-modal').textContent.includes('会自动重启'),'verified service restart hint missing');
    const rootCheckbox=doc(main).querySelector('input[aria-label="选择实例 PID 103"]');
    assert(rootCheckbox.disabled,'root instance must remain protected');
    assert(doc(main).body.textContent.includes('root 进程：当前授权仅用于采集，不支持结束。'),'root protection reason missing');
    assert([...doc(main).querySelectorAll('.detail-modal button')].some(button=>button.textContent==='后台服务 (1)'),'matched application service shortcut missing');
    assert([...doc(main).querySelectorAll('button')].some(button=>button.textContent==='结束全部实例'),'initial bulk label missing');
    doc(main).querySelector('.ant-modal .ant-table-thead input[type="checkbox"]').click();
    await wait(()=>[...doc(main).querySelectorAll('button')].some(button=>button.textContent==='结束所选实例'),'checkbox selection did not change bulk action');
    assert(!rootCheckbox.checked,'select all included root instance');
    [...doc(main).querySelectorAll('button')].find(button=>button.textContent==='结束所选实例').click();
    await wait(()=>doc(main).body.textContent.includes('结束这 2 个运行实例？'),'bulk review did not show instance count');
    const bulkRequest=main.messages.findLast(message=>message.method==='terminate_preview');
    assert(JSON.stringify(bulkRequest.params.instanceIds)===JSON.stringify(['instance-101','instance-102']),'bulk preview scope includes unselected/protected instances');
    const cancelReview=[...doc(main).querySelectorAll('.ant-modal-footer button')].find(button=>button.textContent.replace(/\s/g,'')==='取消');
    assert(cancelReview,'bulk review cancel button missing');
    await wait(()=>!cancelReview.disabled,'bulk review remained busy');cancelReview.click();
    await wait(()=>{const action=[...doc(main).querySelectorAll('button')].find(button=>button.textContent==='结束所选实例');return action&&!action.disabled;},'cancel did not release the selected action');
    main.failMethod='terminate_preview';
    [...doc(main).querySelectorAll('button')].find(button=>button.textContent==='结束所选实例').click();
    await wait(()=>doc(main).querySelector('.detail-modal .request-diagnostics'),'failed request details missing');
    const failure=main.messages.findLast(message=>message.method==='terminate_preview');
    const diagnostic=doc(main).querySelector('.detail-modal .request-diagnostics');diagnostic.querySelector('summary').click();
    const report=diagnostic.querySelector('textarea');
    assert(report.value.includes(failure.id)&&report.value.includes('terminate_preview')&&report.value.includes('main'),'copyable request correlation missing');
    assert(!diagnostic.closest('.ant-alert').textContent.includes('Error: fixture'),'raw Error prefix is still shown');
    await wait(()=>main.messages.some(message=>message.method==='diagnostic_event'&&message.params.traceId===failure.id),'UI trace does not match diagnostic event');
    let copied='';Object.defineProperty(main.element.contentWindow.navigator,'clipboard',{configurable:true,value:{writeText:async text=>{copied=text;}}});
    diagnostic.querySelector('button').click();await wait(()=>copied===report.value,'copy action did not include report');
    Object.defineProperty(main.element.contentWindow.navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('clipboard denied');}}});
    diagnostic.querySelector('button').click();await wait(()=>doc(main).activeElement===report,'clipboard fallback did not focus report');
    assert(report.selectionStart===0&&report.selectionEnd===report.value.length,'clipboard fallback did not select report');
    checks.push('request method/elapsed/trace; matched diagnostic event; copy and clipboard-denied fallback');
    doc(main).querySelector('.detail-modal .ant-modal-close').click();
    checks.push('instance select-all; dynamic bulk label; explicit preview scope; visible root restriction; cancellation');
    [...doc(main).querySelectorAll('button')].find(button=>button.textContent==='后台服务').click();
    await wait(()=>doc(main).querySelector('.background-service-record'),'background service drawer missing');
    const serviceDrawer=()=>doc(main).querySelector('.background-service-drawer');
    assert(serviceDrawer().textContent.includes('当前会话')&&serviceDrawer().textContent.includes('永久自启'),'service pause scope is not explained');
    const serviceAction=label=>[...(serviceDrawer()?.querySelectorAll('button')??[])].find(button=>button.textContent===label);
    serviceAction('刷新').click();await wait(()=>main.serviceReading,'background refresh did not start');
    serviceAction('停止后台服务').click();await wait(()=>doc(main).body.textContent.includes('停止这个后台服务？'),'service stop review missing');
    assert(!main.messages.some(message=>message.method==='service_confirm'),'opening service review executed an action');
    let serviceConfirm=[...doc(main).querySelectorAll('.ant-modal-footer button')].find(button=>button.textContent.replace(/\s/g,'')==='确认停止服务');
    await wait(()=>serviceConfirm&&!serviceConfirm.disabled,'service confirmation remained disabled');serviceConfirm.click();
    await wait(()=>serviceAction('恢复启动'),'paused service disappeared with its process');
    serviceDrawer().querySelector('.ant-drawer-close').click();await wait(()=>!serviceDrawer(),'service drawer did not close');
    [...doc(main).querySelectorAll('button')].find(button=>button.textContent.startsWith('后台服务')).click();
    await wait(()=>serviceAction('恢复启动'),'paused service was not recoverable after reopening');serviceAction('恢复启动').click();
    await wait(()=>doc(main).body.textContent.includes('恢复这个后台服务？'),'service resume review missing');
    serviceConfirm=[...doc(main).querySelectorAll('.ant-modal-footer button')].find(button=>button.textContent.replace(/\s/g,'')==='确认恢复启动');
    await wait(()=>serviceConfirm&&!serviceConfirm.disabled,'resume confirmation remained disabled');serviceConfirm.click();
    await wait(()=>serviceAction('停止后台服务'),'restored service did not return to registered state');
    assert(main.messages.filter(message=>message.method==='service_confirm').length===2,'service actions were duplicated');
    assert(!main.messages.some(message=>message.method==='terminate_confirm'),'service control used process termination');
    serviceDrawer().querySelector('.ant-drawer-close').click();await wait(()=>!serviceDrawer(),'service drawer did not close after resume');
    checks.push('service restart hints; explicit stop/resume reviews; paused rows survive closing; exact service tokens; no PID termination');
    const startupStart=main.messages.length;
    [...doc(main).querySelectorAll('button')].find(button=>button.textContent==='自启动').click();
    const startupDrawer=()=>doc(main).querySelector('.startup-drawer');
    const startupAction=label=>[...(startupDrawer()?.querySelectorAll('button')??[])].find(button=>button.textContent===label);
    const startupRow=name=>[...(startupDrawer()?.querySelectorAll('article')??[])].find(row=>row.querySelector('strong')?.textContent===name);
    const startupConfirm=label=>[...doc(main).querySelectorAll('.ant-modal-footer button')].find(button=>button.textContent.replace(/\s/g,'')===label);
    await wait(()=>startupAction('关闭自启动'),'startup state missing');
    assert(startupDrawer().textContent.includes('MySQL已开启')&&startupDrawer().textContent.includes('OneDrive已开启'),'startup statuses missing');
    assert(startupRow(vivoLogin.name).textContent.includes(vivoLogin.blockedReason)&&!startupRow(vivoLogin.name).querySelector('button'),'pre-login vivo agent should be read-only');
    startupAction('关闭自启动').click();
    await wait(()=>startupConfirm('确认关闭'),'startup confirmation missing');
    assert(!main.messages.slice(startupStart).some(message=>message.method==='startup_set'),'opening startup confirmation changed policy');
    startupConfirm('确认关闭').click();
    await wait(()=>startupAction('恢复自启动')&&!startupAction('恢复自启动').disabled,'disabled startup did not expose restore');
    assert(startupRow('MySQL').textContent.includes('结束实例后仍可能被重新拉起')&&!main.messages.slice(startupStart).some(message=>message.method==='startup_stop'),'policy change stopped the running service or omitted the restart warning');
    startupAction('停止后台服务').click();
    await wait(()=>startupConfirm('确认停止'),'separate MySQL stop confirmation missing');
    assert(!main.messages.slice(startupStart).some(message=>message.method==='startup_stop'),'opening the confirmation stopped the service');
    startupConfirm('确认停止').click();
    await wait(()=>startupRow('MySQL').textContent.includes('已关闭服务未加载')&&!startupAction('停止后台服务'),'MySQL stop changed startup policy or did not confirm unload');
    startupAction('恢复自启动').click();
    await wait(()=>startupConfirm('确认恢复'),'restore startup confirmation missing');
    startupConfirm('确认恢复').click();
    await wait(()=>startupAction('关闭自启动')&&!startupAction('关闭自启动').disabled,'startup restore did not refresh state');
    startupAction('前往登录项设置').click();
    await wait(()=>main.messages.some(message=>message.method==='login_items_settings'),'OneDrive settings link missing');
    const rootButton=()=>startupRow('vivo 远控守护服务')?.querySelector('button');
    await wait(()=>rootButton()&&!rootButton().disabled,'authorized vivo root row cannot be configured');
    rootButton().click();
    await wait(()=>startupConfirm('确认关闭'),'vivo root confirmation missing');
    startupConfirm('确认关闭').click();
    await wait(()=>rootButton()?.textContent==='恢复自启动','vivo root policy did not update');
    assert(startupRow('vivo 同步服务').textContent.includes('已开启'),'root change affected a different vivo service');
    const startupMessages=main.messages.slice(startupStart);
    assert(startupMessages.filter(message=>message.method==='startup_set').length===3&&startupMessages.filter(message=>message.method==='startup_stop').length===1,'startup or stop changes were duplicated');
    assert(!startupMessages.some(message=>['terminate_confirm','service_preview','service_confirm'].includes(message.method)),'startup settings touched running services');
    startupDrawer().querySelector('.ant-drawer-close').click();await wait(()=>!startupDrawer(),'startup drawer did not close');
    checks.push('MySQL startup status and separate confirmed stop; individual vivo root service; OneDrive settings navigation');
    doc(main).querySelector('button[aria-label="查看 PostgreSQL 14 进程"]').click();
    const postgresShortcut=()=>[...doc(main).querySelectorAll('.detail-modal button')].find(button=>button.textContent==='自启动 / 后台服务');
    await wait(postgresShortcut,'PostgreSQL service shortcut missing without privileged match');
    postgresShortcut().click();
    await wait(()=>startupRow(postgresStartup.name),'scoped PostgreSQL startup row missing');
    assert(startupDrawer().querySelectorAll('article').length===1,'PostgreSQL shortcut exposed an unrelated service');
    assert(startupDrawer().textContent.includes('PID 63742')&&startupDrawer().textContent.includes('KeepAlive'),'live PostgreSQL PID or restart warning missing');
    const postgresStart=main.messages.length;
    startupAction('关闭自启动').click();
    await wait(()=>startupConfirm('确认关闭'),'PostgreSQL policy confirmation missing');
    startupConfirm('确认关闭').click();
    await wait(()=>startupAction('停止后台服务')&&!startupAction('停止后台服务').disabled,'loaded PostgreSQL service cannot be stopped separately');
    assert(startupDrawer().textContent.includes('PID 63742')&&!main.messages.slice(postgresStart).some(message=>message.method==='startup_stop'),'disabling PostgreSQL startup also stopped the process');
    startupAction('停止后台服务').click();
    await wait(()=>startupConfirm('确认停止'),'PostgreSQL stop confirmation missing');
    startupConfirm('确认停止').click();
    await wait(()=>startupDrawer().textContent.includes('已关闭服务未加载')&&!startupAction('停止后台服务'),'PostgreSQL stop did not confirm unload or retain startup policy');
    assert(main.messages.slice(postgresStart).filter(message=>message.method==='startup_stop').length===1,'PostgreSQL stop was repeated');
    startupDrawer().querySelector('.ant-drawer-close').click();await wait(()=>!startupDrawer(),'PostgreSQL startup drawer did not close');
    doc(main).querySelector('.detail-modal .ant-modal-close').click();
    checks.push('PostgreSQL detail shortcut without privileged match; KeepAlive hint; policy and stop target the exact service');
    const finderStart=main.messages.length;
    [...doc(main).querySelectorAll('button')].find(button=>button.textContent==='访达扩展').click();
    const finderDrawer=()=>doc(main).querySelector('.finder-extensions-drawer');
    const finderAction=label=>[...(finderDrawer()?.querySelectorAll('article button')??[])].find(button=>button.textContent===label&&!button.disabled);
    const finderConfirm=label=>[...doc(main).querySelectorAll('.finder-extension-review .ant-modal-footer button')].find(button=>button.textContent.replace(/\s/g,'')===label);
    await wait(()=>finderAction('停用'),'Finder extension settings did not open');
    assert(finderDrawer().textContent.includes('运行中'),'enabled extension did not show independent process state');
    finderAction('停用').click();
    await wait(()=>finderConfirm('确认关闭'),'Finder extension review did not open');
    assert(!main.messages.slice(finderStart).some(message=>message.method==='finder_extension_set'),'Finder review changed settings before confirmation');
    finderConfirm('取消').click();
    await wait(()=>finderAction('停用'),'Finder cancel did not restore the original action');
    finderAction('停用').click();
    await wait(()=>finderConfirm('确认关闭'),'Finder review did not reopen');
    finderConfirm('确认关闭').click();
    await wait(()=>finderAction('启用'),'Finder settings did not read back the disabled state');
    assert(finderDrawer().textContent.includes('未运行'),'Finder process exit state was not shown');
    finderAction('启用').click();
    await wait(()=>finderConfirm('确认启用'),'Finder enable review did not open');
    finderConfirm('确认启用').click();
    await wait(()=>finderAction('停用'),'Finder settings did not read back the enabled state');
    const finderWrites=main.messages.slice(finderStart).filter(message=>message.method==='finder_extension_set');
    assert(finderWrites.length===2&&finderWrites[0].params.enabled===false&&finderWrites[1].params.enabled===true,'Finder extension writes were duplicated or reversed');
    finderDrawer().querySelector('.ant-drawer-close').click();
    await wait(()=>!finderDrawer(),'Finder drawer did not close');
    checks.push('Finder extension list and runtime state; cancel, disable and enable exact confirmed registration');
    finderExtension.state='disabled';
    doc(main).querySelector('button[aria-label="查看 Codex 进程"]').click();
    const finderDetailAction=()=>[...doc(main).querySelectorAll('.detail-modal button')].find(button=>button.textContent==='访达扩展');
    await wait(finderDetailAction,'Finder shortcut missing when the registered extension process is absent');
    finderDetailAction().click();
    await wait(()=>finderAction('启用'),'disabled extension missing in scoped drawer');
    assert(finderDrawer().querySelectorAll('article').length===1&&finderDrawer().textContent.includes('未运行'),'app details did not show only its registered, stopped extension');
    finderDrawer().querySelector('.ant-drawer-close').click();
    await wait(()=>!finderDrawer(),'scoped Finder drawer did not close');
    doc(main).querySelector('.detail-modal .ant-modal-close').click();
    checks.push('application detail links to registered Finder extensions even when stopped, scoped to its app');
    const detail=await frame('widget-detail.html',true);
    await wait(()=>detail.messages.some(message=>message.type==='flowhub:widget-ready'),'detail ready missing');
    detail.send({type:'flowhub:widget-init',context:{preview:true,config:{selection:{groupId:'app:codex'}}}});
    await wait(()=>doc(detail).querySelector('.ant-modal-title')?.textContent.includes('Codex'),'selected detail failed to open');
    checks.push('management table and selected native detail preview');
    for(const element of frames)assert(element.contentWindow.__probe.errors.length===0,element.contentWindow.__probe.errors.join('; '));
    assert(errors.length===0,errors.join('; '));
    document.querySelector('#result').textContent=JSON.stringify({ok:true,checks});
  } catch(error) {document.querySelector('#result').textContent=JSON.stringify({ok:false,error:String(error),checks,frames:frames.map(element=>({url:element.src,body:element.contentDocument?.body.innerHTML.slice(0,1500),errors:element.contentWindow.__probe?.errors,messages:hosts.get(element.contentWindow)?.messages.slice(-5)}))});}
  finally {for(const element of frames)element.remove();}
})();
