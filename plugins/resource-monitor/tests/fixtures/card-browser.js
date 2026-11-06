(async()=>{
  const checks=[],errors=[];
  const assert=(condition,message)=>{if(!condition)throw Error(message);};
  const wait=async(predicate,message)=>{for(let i=0;i<150;i++){if(predicate())return;await new Promise(done=>setTimeout(done,10));}throw Error(message);};
  const frames=[];
  const token='card-test-token';
  const snapshot={at:Date.now(),system:{totalMemory:34359738368,swapUsed:1048576},rows:Array.from({length:28},(_,index)=>({
    id:`app:${index}`,name:`Application ${index}`,appPath:index===27?'/Applications/Test.app':index===25?'/Applications/Unavailable.app':null,iconKey:index===26?'python':null,
    at:Date.now(),count:index+1,instanceCount:2,incomplete:false,systemAccounting:index===27?{footprint:84*1073741824,coalitionCount:1,shared:false}:null,values:{memory:index*1048576,rss:index*1048576,footprint:index*2097152,cpu:index}
  }))};
  const nativeIcon='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOWQAAAAASUVORK5CYII=';
  let current=snapshot;
  const hosts=new Map();
  addEventListener('message',event=>{
    const host=hosts.get(event.source);if(!host)return;
    const data=event.data;host.messages.push(data);
    if(data.type==='flowhub:request') {
      const result={at:Date.now(),groups:[{id:'app:codex',name:'Codex',source:'fixture',memory:1048576,footprint:2097152,cpu:1,processes:[],processCount:0,instanceCount:0,system:false,canTerminate:false,incomplete:false}],query:data.params?.query??'',includeSystem:data.params?.includeSystem??true,hasRestrictedProcesses:false,matchedGroupIds:[],system:{},interval:5,memoryMetric:'footprint'};
      event.source.postMessage({type:'flowhub:response',id:data.id,result},'*');return;
    }
    if(data.type!=='flowhub:widget-rpc')return;
    let result;
    if(data.params.action==='snapshot')result=current;
    else if(data.params.method==='application_metadata')result={applications:[{path:'/Applications/Test.app',name:'Native Test',bundleId:'fixture.app',iconUrl:nativeIcon}]};
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
    host.send({type:'flowhub:widget-init',context:{title:'Host title',config:{title:'Configured title',limit:5},snapshot}});
    await wait(()=>rows(host).length===28&&rows(host)[0].textContent.includes('Native Test'),'initial context or metadata missing');
    assert(doc(host).querySelector('.widget-header strong').textContent==='Configured title','configured title lost');
    assert(rows(host).every(row=>!row.disabled),'live card navigation disabled');
    assert(rows(host)[0].querySelector('img')?.src===nativeIcon,'native application icon missing');
    assert(rows(host)[0].querySelector('.widget-memory').textContent.includes('活跃'),'active footprint label missing');
    assert(rows(host)[0].querySelector('.widget-memory').textContent.includes('记账 84.00 GiB'),'system ledger missing or replaced active footprint');
    assert(!rows(host).find(row=>row.textContent.includes('Application 25')).querySelector('.widget-memory').textContent.includes('记账'),'unavailable accounting should not leave a dash on the card');
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
    editor.send({type:'flowhub:widget-init',context:{preview:true,config:{title:'Saved title',sort:'cpu',display:'top',limit:3,groupId:'app:5'},snapshot}});
    await wait(()=>doc(editor).querySelector('input')?.value==='Saved title','editor context missing');
    editor.send({type:'flowhub:widget-save',id:'configured'});
    await wait(()=>editor.messages.some(message=>message.id==='configured'),'configured editor save missing');
    const saved=editor.messages.find(message=>message.id==='configured').config;
    assert(saved.title==='Saved title'&&saved.sort==='cpu'&&saved.display==='top'&&saved.limit===3&&saved.groupId==='app:5','saved configuration changed');
    checks.push('editor early save registration and initialized configuration');

    const main=await frame('index.html');
    await wait(()=>doc(main).querySelector('.ant-table-row'),'management preview failed');
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
