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
  function reconcileStopResult(operation,snapshot){
    if(!operation||!snapshot)return operation;
    if(snapshot.context&&snapshot.context!==operation.context)return null;
    if(snapshot.context!==operation.context||snapshot.error||snapshot.pending||!Array.isArray(snapshot.rows)||typeof snapshot.at!=='number'||snapshot.at<operation.at)return operation;
    const rows=new Map(snapshot.rows.map(row=>[row.id,row]));
    return {...operation,results:operation.results.map(row=>!row.stopped&&['exited','created'].includes(rows.get(row.id)?.state)?{...row,state:rows.get(row.id).state,stopped:true,error:null}:row)};
  }
  globalThis.DockerWidgetModel={view,reconcileStopResult};
  if(typeof module!=='undefined')module.exports={view,reconcileStopResult};
})();
