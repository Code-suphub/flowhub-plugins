(() => {
  const select=document.querySelector('#project'),issues=document.querySelector('#onlyIssues');
  function options(snapshot,selected='*'){
    const projects=[...new Set((snapshot?.rows||[]).map(r=>r.project||''))].sort();
    if(selected!=='*'&&!projects.includes(selected))projects.push(selected);
    select.replaceChildren(...[['*','全部容器'],...projects.map(p=>[p,p||'独立容器'])].map(([value,label])=>{const o=document.createElement('option');o.value=value;o.textContent=label;return o;}));select.value=selected;
  }
  FlowHubWidget.onInit(async data=>{
    options(data.snapshot,data.config?.project??'*');issues.checked=data.config?.onlyIssues===true;document.querySelector('#type').value=data.config?.type||'all';
    if(!data.preview){try{const snapshot=await FlowHubWidget.invoke({action:'snapshot'});options(snapshot,select.value);document.querySelector('#notice').textContent=snapshot.error||'';}catch(e){document.querySelector('#notice').textContent=e.message;}}
  });
  FlowHubWidget.editor(()=>({project:select.value,onlyIssues:issues.checked,type:document.querySelector('#type').value}));
})();
