(() => {
  const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels={running:'运行中',exited:'已停止',created:'未启动',restarting:'重启中',paused:'已暂停',dead:'异常',removing:'移除中'};
  const samples=[{id:'a'.repeat(64),name:'web-app-api-1',image:'example/api:dev',state:'restarting',status:'Restarting (1)',ports:'127.0.0.1:8080->8080/tcp',project:'web-app',service:'api'},{id:'b'.repeat(64),name:'web-app-postgres-1',image:'postgres:16',state:'running',status:'Up 2 hours (healthy)',ports:'127.0.0.1:5432->5432/tcp',project:'web-app',service:'postgres'},{id:'c'.repeat(64),name:'redis-dev',image:'redis:7',state:'exited',status:'Exited (0)',ports:'',project:'',service:''}];
  const sampleImages=[{ID:'sha256:'+'d'.repeat(64),Repository:'redis',Tag:'7',Size:'117MB',CreatedSince:'2 days ago'},{ID:'sha256:'+'e'.repeat(64),Repository:'postgres',Tag:'16',Size:'432MB',CreatedSince:'5 days ago'}];
  const settingsKey='flowhub.docker.management.settings.v1',defaults={refreshSeconds:15,defaultScope:'all',onlyIssues:false,expandCompose:true,};
  let preview=true,data={containers:[],context:''},images=[],scope='all',selected=null,tab='overview',generation=0,loading=false,operating=false,logLoading=false,logText='',pendingAction=null,connected=false,started=false,initial=null,initialContext='',imageInfo=null,settings=loadSettings(),refreshTimer=0,collapseInitialized=false;
  const collapsed=new Set();
  function loadSettings(){try{const saved=JSON.parse(localStorage.getItem(settingsKey)||'{}');delete saved.theme;return {...defaults,...saved}}catch{return {...defaults}}}
  function persistSettings(){localStorage.setItem(settingsKey,JSON.stringify(settings));$('#settingsSaved').textContent='已保存';setTimeout(()=>$('#settingsSaved').textContent='',1800);}
  function syncThemeControls(){const global=window.FlowHubTheme;$('#theme').hidden=!!global?.hosted;$('#settingTheme').disabled=!!global?.hosted;$('#settingTheme').value=global?.get()||'system';$('#theme').textContent=document.documentElement.dataset.theme==='dark'?'浅色':'深色';}
  window.addEventListener('flowhub-theme-change',syncThemeControls);
  $('#theme').onclick=()=>window.FlowHubTheme?.set(document.documentElement.dataset.theme==='dark'?'light':'dark');
  function fillSettings(){ $('#settingRefresh').value=String(settings.refreshSeconds);$('#settingScope').value=settings.defaultScope;$('#settingIssues').checked=!!settings.onlyIssues;$('#settingExpand').checked=!!settings.expandCompose;syncThemeControls(); }
  function showSettings(show){$('#settingsPanel').hidden=!show;document.querySelector('main').hidden=show;document.querySelector('.summary').hidden=show;document.querySelector('footer').hidden=show;if(show){fillSettings();$('#settingsContext').textContent=data.context||'尚未连接';}}
  $('#settingsForm').onsubmit=e=>{e.preventDefault();settings={...settings,refreshSeconds:Number($('#settingRefresh').value),defaultScope:$('#settingScope').value,onlyIssues:$('#settingIssues').checked,expandCompose:$('#settingExpand').checked};scope=settings.defaultScope;collapsed.clear();if(!settings.expandCompose)for(const c of data.containers)if(c.project)collapsed.add(c.project);collapseInitialized=true;window.FlowHubTheme?.set($('#settingTheme').value);persistSettings();showSettings(false);renderList();refresh();scheduleRefresh();};
  $('#resetSettings').onclick=()=>{settings={...defaults};fillSettings();window.FlowHubTheme?.set($('#settingTheme').value);persistSettings();};
  async function invoke(method,params={}){
    if(!preview)return window.FlowHubWidget?FlowHubWidget.invoke({action:'management',method,params}):FlowHubPlugin.invoke(method,params);
    if(method==='list')return {context:'本机 · 模拟数据',containers:samples};
    if(method==='detail')return {state:samples.find(c=>c.id===params.id)?.state,health:null,exitCode:0,restarts:2,started:'2026-09-10T08:00:00Z',mounts:[],stats:{CPUPerc:'2.1%',MemUsage:'128 MiB / 2 GiB'}};
    if(method==='logs')return {text:'[info] Starting application\n[error] Database connection refused\n[info] Retrying connection…'};
    if(method==='images')return {context:data.context,images:sampleImages};
    if(method==='image_detail')return {id:params.id,tags:[params.id===sampleImages[0].ID?'redis:7':'postgres:16'],digests:[],created:'2026-09-09T08:00:00Z',size:117000000,os:'linux',architecture:'arm64',containers:[]};
    throw Error('浏览器预览不执行操作');
  }
  function notice(message=''){$('#notice').textContent=message;$('#notice').hidden=!message;}
  function current(){return selected?.kind==='container'?data.containers.find(c=>c.id===selected.id):null;}
  function projectRows(){return data.containers.filter(c=>c.project===selected?.project);}
  function imageRef(i){return i.Repository==='<none>'?i.ID:`${i.Repository}:${i.Tag}`;}
  function row(c){return `<button class="container ${selected?.id===c.id?'selected':''}" data-id="${esc(c.id)}"><span class="dot ${esc(c.status?.includes('unhealthy')?'unhealthy':c.state)}"></span><span><strong>${esc(c.name)}</strong><small>${esc(labels[c.state]||c.state)} · ${esc(c.image)}</small></span></button>`;}
  function renderList(){
    if(scope==='settings'){showSettings(true);return;}showSettings(false);
    const q=$('#filter').value.toLowerCase();$('#listTitle').textContent=scope==='images'?'本地镜像':'项目与容器';
    document.querySelectorAll('[data-scope]').forEach(b=>{b.classList.toggle('active',b.dataset.scope===scope);b.setAttribute('aria-pressed',b.dataset.scope===scope);});
    if(scope==='images')$('#containers').innerHTML=images.filter(i=>`${imageRef(i)} ${i.ID}`.toLowerCase().includes(q)).map(i=>`<button class="container image-list ${selected?.reference===imageRef(i)?'selected':''}" data-image="${esc(i.ID)}" data-reference="${esc(imageRef(i))}"><span><strong>${esc(imageRef(i))}</strong><small>${esc(i.Size)} · ${esc(i.CreatedSince)}<br>${esc(i.ID.slice(0,24))}</small></span></button>`).join('')||'<p class="empty">没有匹配的本地镜像</p>';
    else {
      const groups=new Map();for(const c of data.containers){if(scope==='compose'&&!c.project||scope==='standalone'&&c.project)continue;if(settings.onlyIssues&&!(['restarting','dead'].includes(c.state)||c.status?.includes('unhealthy')))continue;if(!`${c.name} ${c.image} ${c.project}`.toLowerCase().includes(q))continue;const key=c.project||'';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(c);}
      $('#containers').innerHTML=[...groups].map(([project,rows])=>`<div class="group">${project?`<button class="fold" data-fold="${esc(project)}" aria-label="${collapsed.has(project)?'展开':'收起'} ${esc(project)}" aria-expanded="${!collapsed.has(project)}">${collapsed.has(project)?'▸':'▾'}</button><button class="project-link" data-project="${esc(project)}">${esc(project)}</button>`:'<span>独立容器</span>'}<small>${rows.filter(c=>c.state==='running').length}/${rows.length} 运行</small></div>${project&&collapsed.has(project)?'':rows.map(row).join('')}`).join('')||'<p class="empty">没有匹配的容器</p>';
    }
    $('#total').textContent=data.containers.length;$('#running').textContent=data.containers.filter(c=>c.state==='running').length;$('#issues').textContent=data.containers.filter(c=>['restarting','dead'].includes(c.state)||c.status?.includes('unhealthy')).length;$('#projects').textContent=new Set(data.containers.map(c=>c.project).filter(Boolean)).size;
  }
  function actions(){
    const c=current();let html='';const button=(a,label,enabled=true)=>`<button data-action="${a}" ${preview||operating||loading||!connected||!enabled?'disabled':''} ${a.includes('remove')?'class="danger"':''}>${label}</button>`;
    if(c)html=button('start','启动',['exited','created'].includes(c.state))+button('stop','停止',['running','restarting'].includes(c.state))+button('restart','重启',['running','restarting'].includes(c.state))+button('container_remove','删除容器',['exited','created','dead'].includes(c.state))+'<button id="copy">复制日志命令</button>';
    else if(selected?.kind==='project')html=button('project_stop','停止整个项目',projectRows().some(c=>['running','restarting','paused'].includes(c.state)));
    else if(selected?.kind==='image')html=button('image_remove','删除镜像标签',!!imageInfo&&!imageInfo.containers?.length);
    $('#actions').innerHTML=html;
  }
  async function refresh(){
    if(loading||operating||$('#confirm').open)return;loading=true;$('#refresh').disabled=true;actions();
    try{const next=await invoke('list');const changed=data.context&&data.context!==next.context;data=next;connected=true;$('#context').textContent=data.context;$('#settingsContext').textContent=data.context||'尚未连接';$('#updated').textContent=new Date().toLocaleTimeString();if(!collapseInitialized){if(!settings.expandCompose)for(const c of data.containers)if(c.project)collapsed.add(c.project);collapseInitialized=true;}
      if(changed){selected=null;generation++;notice('Docker 环境已变化，已清除原环境中的选择。');}
      if(initial){if(initialContext&&initialContext!==data.context&&!preview){notice('悬浮窗所选 Docker 环境已变化，请重新选择对象。');}else{selected=initial;if(selected.kind==='image'||selected.kind==='images')scope='images';}initial=null;}
      if(scope==='images')images=(await invoke('images',{context:data.context})).images;
      if(selected?.kind==='container'&&!current()||selected?.kind==='project'&&!projectRows().length||selected?.kind==='image'&&!images.some(i=>i.ID===selected.id&&imageRef(i)===selected.reference)){selected=null;generation++;notice('所选对象已不存在，请重新选择。');}
      renderList();if(!selected||selected.kind==='images'){selected=null;$('#selection').hidden=true;$('#empty').hidden=false;}else if(!logLoading)await select(selected,{preserveTab:true});
    }catch(e){connected=false;notice(e.message+'\n请检查 Docker 引擎后刷新。');}finally{loading=false;$('#refresh').disabled=false;actions();}
  }
  function setTab(next){tab=next;$('#overview').hidden=next!=='overview';$('#logsPanel').hidden=next!=='logs';document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===next));if(next==='logs')loadLogs();}
  async function select(target,{preserveTab=false}={}){
    if(operating||$('#confirm').open)return;const changed=selected?.id!==target.id||selected?.kind!==target.kind;selected=target;const g=++generation;imageInfo=null;$('#empty').hidden=true;$('#selection').hidden=false;$('#detailTabs').hidden=target.kind!=='container';if(changed){logText='';$('#logs').textContent='正在读取日志…';}if(!preserveTab||target.kind!=='container')setTab('overview');renderList();actions();$('#overview').innerHTML='<p class="empty">正在读取详情…</p>';
    const c=current(),ctx=data.context;$('#name').textContent=c?.name||target.project||target.reference||'镜像';$('#image').textContent=c?.image||'';$('#service').textContent=c?(c.project?`${c.project} / ${c.service}`:'独立容器'):target.kind==='project'?'COMPOSE PROJECT':'LOCAL IMAGE';$('#state').textContent=c?(labels[c.state]||c.state):'';
    if(target.kind==='project'){
      const rows=projectRows();$('#state').textContent=`${rows.filter(c=>c.state==='running').length} / ${rows.length} 运行`;
      $('#overview').innerHTML=`<p class="project-note">${rows.length} 个成员容器 · 点击服务查看资源、日志与操作。</p>${rows.map(c=>`<button class="member" data-id="${esc(c.id)}"><span>${esc(c.service||c.name)}<br><small>${esc(c.name)} · ${esc(c.image)}</small></span><small>${esc(labels[c.state]||c.state)} ↗</small></button>`).join('')}`;return;
    }
    try{
      if(target.kind==='image'){
        const d=await invoke('image_detail',{id:target.id,context:ctx});if(g!==generation)return;imageInfo=d;$('#state').textContent=d.containers.length?'被容器引用':'未被容器引用';
        $('#overview').innerHTML=`<dl><dt>镜像 ID</dt><dd>${esc(d.id)}</dd><dt>全部标签</dt><dd>${esc((d.tags||[]).join('\n')||'无标签')}</dd><dt>平台</dt><dd>${esc(d.os)} / ${esc(d.architecture)}</dd><dt>大小</dt><dd>${(d.size/1048576).toFixed(1)} MiB</dd><dt>创建时间</dt><dd>${esc(new Date(d.created).toLocaleString())}</dd><dt>摘要</dt><dd>${esc((d.digests||[]).join('\n')||'无')}</dd></dl><h2>引用此镜像或其派生镜像的容器</h2>${d.containers.map(r=>`<button class="member" data-id="${esc(r.id)}">${esc(r.name)}<small>${esc(labels[r.state]||r.state)} ↗</small></button>`).join('')||'<p>暂无容器引用，可删除当前标签。</p>'}`;actions();return;
      }
      if(!c)throw Error('容器已不存在');if(tab==='logs')loadLogs();
      const d=await invoke('detail',{id:c.id,context:ctx});if(g!==generation)return;
      $('#overview').innerHTML=`<div class="metrics"><div class="metric"><span>CPU</span><strong>${esc(d.stats?.CPUPerc||'—')}</strong></div><div class="metric"><span>内存 / 上限</span><strong>${esc(d.stats?.MemUsage||'—')}</strong></div></div><dl><dt>运行状态</dt><dd>${esc(labels[d.state]||d.state)}</dd><dt>健康检查</dt><dd>${esc(d.health||'未配置')}</dd><dt>退出码 / 重启</dt><dd>${esc(d.exitCode)} / ${esc(d.restarts)} 次</dd><dt>最近启动</dt><dd>${Date.parse(d.started)>0?esc(new Date(d.started).toLocaleString()):'尚未启动'}</dd><dt>端口映射</dt><dd>${esc(c.ports||'无公开端口')}</dd><dt>挂载目录</dt><dd>${esc((d.mounts||[]).map(m=>`${m.Source} → ${m.Destination}${m.RW?'':' (只读)'}`).join('\n')||'无挂载')}</dd><dt>容器 ID</dt><dd>${esc(c.id)}</dd></dl>${d.statsError?`<p>${esc(d.statsError)}</p>`:''}`;
    }catch(e){if(g===generation)$('#overview').innerHTML=`<p class="empty">${esc(e.message)}</p>`;}
  }
  function renderLogs(){const q=$('#logFilter').value.toLowerCase();$('#logs').textContent=(q?logText.split('\n').filter(l=>l.toLowerCase().includes(q)).join('\n'):logText)||'暂无匹配日志';}
  async function loadLogs(){if(!current()||logLoading||operating)return;const cid=selected.id,g=generation;logLoading=true;$('#reloadLogs').disabled=true;try{const r=await invoke('logs',{id:cid,context:data.context});if(g===generation){logText=r.text;renderLogs();}}catch(e){if(g===generation)$('#logs').textContent=e.message;}finally{logLoading=false;$('#reloadLogs').disabled=false;if(cid!==selected?.id&&tab==='logs')loadLogs();}}
  function openConfirm(method,params,title,text){pendingAction={method,params};$('#confirmTitle').textContent=title;$('#confirmText').textContent=text;$('#confirm').returnValue='cancel';$('#confirm').showModal();}
  async function prepare(action){
    if(preview||!connected||operating||loading)return;const ctx=data.context,c=current();
    if(action==='project_stop'){
      const project=selected.project;operating=true;actions();try{const plan=await invoke('stop_preview',{scope:'project',project,context:ctx});if(!plan.targets.length){notice('项目已全部停止。');return;}openConfirm('stop_confirm',{scope:'project',project,context:ctx,ids:plan.targets.map(t=>t.id)},'停止整个 Compose 项目？',`${ctx} · ${project}\n${plan.targets.map(t=>t.name).join('\n')}\n保留容器、网络和数据卷。`);}catch(e){notice(e.message);}finally{operating=false;actions();}return;
    }
    if(action==='image_remove'&&imageInfo){openConfirm('image_remove',{id:selected.id,reference:selected.reference,context:ctx},'删除镜像标签？',`${ctx}\n${selected.reference}\n${selected.id}\n将删除本地标签；这是最后一个引用时也会删除镜像。此操作不能撤销，需要重新拉取才能恢复。`);return;}
    if(!c)return;
    if(action==='container_remove'){openConfirm(action,{id:c.id,context:ctx},'删除容器？',`${ctx} · ${c.name}\n${c.id}\n将永久删除容器、可写层及容器日志；保留数据卷、挂载目录和镜像。Compose 容器需通过原项目重新创建。`);return;}
    const name={start:'启动',stop:'停止',restart:'重启'}[action];if(name)openConfirm('operate',{id:c.id,action,context:ctx},`${name}容器？`,`${ctx} · ${c.name}\n${name==='启动'?'按原配置启动。':'服务可能暂时中断。'}`);
  }
  $('#confirm').onclose=async()=>{
    const request=pendingAction;pendingAction=null;if($('#confirm').returnValue!=='confirm'||!request)return;operating=true;actions();notice('正在执行，请稍候…');let message='操作完成';
    try{const r=await invoke(request.method,{...request.params,confirmed:true});if(r.results)message=r.results.map(t=>`${t.name}：${t.stopped?'已停止':t.error||'未确认停止'}`).join('\n');}catch(e){message=e.message;}finally{operating=false;}await refresh();notice(message);
  };
  document.body.addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b||b.disabled)return;
    if(b.dataset.fold!==undefined){collapsed.has(b.dataset.fold)?collapsed.delete(b.dataset.fold):collapsed.add(b.dataset.fold);renderList();}
    else if(b.dataset.scope){if(operating||loading)return;scope=b.dataset.scope;selected=null;generation++;$('#filter').value='';if(scope==='settings'){showSettings(true);return;}renderList();refresh();}
    else if(b.dataset.id){if(scope==='images')scope='all';select({kind:'container',id:b.dataset.id});}
    else if(b.dataset.project)select({kind:'project',project:b.dataset.project});
    else if(b.dataset.image)select({kind:'image',id:b.dataset.image,reference:b.dataset.reference});
    else if(b.dataset.action)prepare(b.dataset.action);
    else if(b.dataset.tab)setTab(b.dataset.tab);
    else if(b.id==='copy'&&current()){const text=`docker --context '${data.context.replaceAll("'","'\\''")}' logs --tail 300 --timestamps ${selected.id}`;if(navigator.clipboard)navigator.clipboard.writeText(text).then(()=>notice('已复制日志命令'),()=>notice(text));else notice(text);}
  });
  $('#filter').oninput=renderList;$('#refresh').onclick=()=>{notice();refresh();};$('#reloadLogs').onclick=loadLogs;$('#logFilter').oninput=renderLogs;
  $('#desktop').onclick=async()=>{try{await FlowHubPlugin.invoke('flowhub_status');}catch(e){notice(e.message);}};
  function scheduleRefresh(){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{if(started&&!document.hidden&&scope!=='settings')refresh();scheduleRefresh();},Math.max(15,settings.refreshSeconds)*1000);}
  function start(context){if(started)return;started=true;preview=window.FlowHubWidget?!!context.preview:!window.FlowHubPlugin;initial=context?.config?.selection||null;initialContext=initial?.context||'';if(!initial&&context?.config?.project&&context.config.project!=='*')initial={kind:'project',project:context.config.project};scope=context?.config?.type||settings.defaultScope;if(!['all','compose','standalone','images'].includes(scope))scope='all';$('#preview').hidden=!preview;$('#desktop').hidden=!!window.FlowHubWidget;$('#desktop').disabled=preview;syncThemeControls();if(!preview)fillSettings();refresh();scheduleRefresh();}
  if(window.FlowHubWidget)FlowHubWidget.onInit(start);else start({});
  setInterval(()=>{if(started&&!document.hidden&&tab==='logs'&&$('#follow').checked)loadLogs();},3000);
})();
