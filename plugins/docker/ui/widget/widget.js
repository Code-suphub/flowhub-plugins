(() => {
  const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const active=r=>['running','restarting','paused'].includes(r.state);
  let context,busy=false,operating=false,pending=null;
  const collapsed=new Set();let filterType=null;
  const navigate=selection=>FlowHubWidget.navigate('detail',{...selection,context:context?.snapshot?.context});
  const confirm=document.createElement('section');confirm.id='confirm';confirm.hidden=true;confirm.setAttribute('role','dialog');confirm.setAttribute('aria-modal','true');confirm.setAttribute('aria-label','确认停止容器');document.body.append(confirm);
  const result=document.createElement('div');result.id='result';result.setAttribute('role','status');$('#content').after(result);
  if(document.body.classList.contains('card')){
    const nav=document.createElement('nav');nav.className='card-navigation';nav.setAttribute('aria-label','组件页面');nav.innerHTML='<button data-page="detail">详情 ↗</button><button data-page="images">镜像</button><button data-page="editor">配置</button>';document.querySelector('header').append(nav);
    const filters=document.createElement('div');filters.className='type-filter';filters.setAttribute('aria-label','容器类型');filters.innerHTML='<button data-type="all">全部</button><button data-type="compose">Compose</button><button data-type="standalone">独立容器</button>';document.querySelector('header').after(filters);
    document.body.addEventListener('click',e=>{
      if(busy||pending||operating)return;
      const button=e.target.closest('button');
      if(button){if(button.dataset.page==='images')navigate({kind:'images'});else if(button.dataset.page)FlowHubWidget.navigate(button.dataset.page);else if(button.dataset.type){filterType=button.dataset.type;render(context.snapshot);}return;}
      if(e.target.closest('a,input,select,textarea,#confirm')||window.getSelection()?.toString())return;
      FlowHubWidget.navigate('detail');
    });
  }
  function render(snapshot){
    if(pending||operating)return;
    const v=DockerWidgetModel.view(snapshot,{...context.config,type:filterType??context.config?.type});
    document.querySelectorAll('[data-type]').forEach(b=>{const selected=b.dataset.type===(filterType??context.config?.type??'all');b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',selected);});
    $('#title').textContent=context.title||(v.project==='*'?'Docker 容器':v.project||'独立容器');
    $('#context').textContent=snapshot?.context||'';
    $('#updated').textContent=snapshot?.at?`更新 ${new Date(snapshot.at).toLocaleTimeString()}${context.preview?' · 模拟':''}`:'等待首次采集';
    if(v.error||v.pending){$('#content').innerHTML=`<p class="message ${v.error?'alert':''}">${esc(v.error||'正在采集本机容器状态…')}</p>`;return;}
    const groups=new Map();for(const r of v.visible){const key=r.project||'';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
    const rows=[...groups].map(([project,rows])=>{
      const count=v.rows.filter(r=>(r.project||'')===project&&active(r)).length;
      return `<section class="project"><div class="project-head">${project?`<button class="fold" data-fold="${esc(project)}" aria-expanded="${!collapsed.has(project)}" aria-label="${collapsed.has(project)?'展开':'收起'} ${esc(project)}">${collapsed.has(project)?'▸':'▾'}</button><button class="object-link" data-open-project="${esc(project)}">${esc(project)}</button><button data-project="${esc(project)}" ${context.preview||!count?'disabled':''} aria-label="停止项目 ${esc(project)} 的全部容器">停止全部${count?' · '+count:''}</button>`:'<strong>独立容器</strong>'}</div>${project&&collapsed.has(project)?'':rows.map(r=>`<div class="row"><button class="object-link" data-open-container="${esc(r.id)}"><strong>${esc(r.name)}</strong><small class="${['healthy','error','stale','unknown'].includes(r.status)?r.status:'unknown'}">${esc(r.summary)}</small></button><button data-stop="${esc(r.id)}" ${context.preview||!active(r)?'disabled':''} aria-label="停止容器 ${esc(r.name)}">${active(r)?'停止':'已停止'}</button></div>`).join('')}</section>`;
    }).join('');
    const html=`<div class="overview"><strong>${v.running}<small> / ${v.rows.length} 运行</small></strong><span class="${v.issues?'alert':''}">● ${v.issues} 异常</span></div><div class="rows">${rows||`<p class="empty">${v.rows.length?'当前没有异常容器':'此范围暂无容器'}</p>`}</div>`;
    if($('#content').innerHTML!==html)$('#content').innerHTML=html;
  }
  async function refresh(){if(!context||context.preview||busy||pending||operating)return;busy=true;try{context.snapshot=await FlowHubWidget.invoke({action:'snapshot'});render(context.snapshot);}catch(e){render({...context.snapshot,error:e.message});}finally{busy=false;}}
  function dismiss(){pending=null;confirm.hidden=true;$('#content').inert=false;render(context.snapshot);}
  async function prepare(request){
    if(context.preview||busy||pending||operating)return;busy=true;result.textContent='正在核对停止目标…';
    try{const plan=await FlowHubWidget.invoke({action:'stop_preview',context:context.snapshot.context,...request});
      if(!plan.targets?.length){result.textContent='目标已停止，无需重复操作。';return;}
      pending={...request,context:plan.context,ids:plan.targets.map(r=>r.id)};result.textContent='';$('#content').inert=true;confirm.hidden=false;
      confirm.innerHTML=`<h2>${request.scope==='project'?'停止整个项目？':'停止容器？'}</h2><p>${esc(plan.context)} · ${plan.targets.length} 个容器<br>保留容器、网络和数据卷。</p><ul>${plan.targets.map(r=>`<li>${esc(r.name)}</li>`).join('')}</ul><div class="confirm-actions"><button id="cancel">取消</button><button id="execute" class="danger">确认停止</button></div>`;
      $('#cancel').onclick=dismiss;$('#execute').onclick=execute;$('#cancel').focus();
    }catch(e){result.textContent=e.message;}finally{busy=false;}
  }
  async function execute(){
    if(!pending||operating)return;const request=pending;operating=true;$('#execute').disabled=true;$('#cancel').disabled=true;$('#execute').textContent='停止中…';
    try{const response=await FlowHubWidget.invoke({action:'stop_confirm',...request,confirmed:true});context.snapshot=response.snapshot;
      const failures=response.results.filter(r=>!r.stopped),success=response.results.length-failures.length;
      result.innerHTML=`<strong>${success} 个已停止${failures.length?'，'+failures.length+' 个未确认停止':''}</strong>${failures.length?`<ul>${failures.map(r=>`<li>${esc(r.name)}：${esc(r.error)}</li>`).join('')}</ul>`:''}`;
    }catch(e){result.textContent=e.message;}finally{operating=false;dismiss();await refresh();}
  }
  $('#content').onclick=e=>{const b=e.target.closest('button');if(!b||b.disabled||busy||pending||operating)return;if(b.dataset.stop)prepare({scope:'container',id:b.dataset.stop});else if(b.dataset.project)prepare({scope:'project',project:b.dataset.project});else if(b.dataset.openContainer)navigate({kind:'container',id:b.dataset.openContainer});else if(b.dataset.openProject)navigate({kind:'project',project:b.dataset.openProject});else if(b.dataset.fold){collapsed.has(b.dataset.fold)?collapsed.delete(b.dataset.fold):collapsed.add(b.dataset.fold);render(context.snapshot);}};
  addEventListener('keydown',e=>{if(e.key==='Escape'&&pending&&!operating){e.preventDefault();dismiss();}});
  FlowHubWidget.onInit(data=>{const previous=context?.snapshot;context={...data,snapshot:previous?.at>data.snapshot?.at?previous:data.snapshot};render(context.snapshot);refresh();});
  setInterval(()=>{if(!document.hidden)refresh();},5000);
})();
