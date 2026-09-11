(() => {
  function view(snapshot,config={}){
    const project=typeof config.project==='string'?config.project:'*';
    const rows=(Array.isArray(snapshot?.rows)?snapshot.rows:[]).filter(r=>(project==='*'||(r.project||'')===project)&&(config.type==='compose'?!!r.project:config.type==='standalone'?!r.project:true));
    const error=snapshot?.error || (snapshot?.at&&Date.now()-snapshot.at>60000?'状态已过期，等待重新采集':'');
    return {rows,project,error,pending:!snapshot||snapshot.pending,running:rows.filter(r=>r.state==='running').length,
      stopped:rows.filter(r=>['exited','created','paused'].includes(r.state)).length,
      issues:rows.filter(r=>r.status==='error').length,
      visible:config.onlyIssues?rows.filter(r=>r.status==='error'):rows};
  }
  globalThis.DockerWidgetModel={view};
  if(typeof module!=='undefined')module.exports={view};
})();
