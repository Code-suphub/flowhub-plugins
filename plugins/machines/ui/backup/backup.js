(() => {
  const $=s=>document.querySelector(s),dialog=$('#backupDialog');let token=null;
  const invoke=window.FlowHubPlugin?.invoke || window.__TAURI__?.core?.invoke;
  $('#openBackup').disabled=!invoke;
  $('#openBackup').onclick=()=>{dialog.showModal();$('#backupPassword').focus();};
  function clear(){token=null;$('#backupPassword').value='';$('#backupRepeat').value='';$('#restoreBackup').disabled=true;$('#backupSummary').textContent='';}
  $('#closeBackup').onclick=()=>dialog.close();dialog.addEventListener('close',clear);
  $('#backupPassword').oninput=()=>{token=null;$('#restoreBackup').disabled=true;$('#backupSummary').textContent='';};
  async function run(action){
    const password=$('#backupPassword').value;
    if(action!=='restore' && password.length<12){$('#backupStatus').textContent='请输入至少 12 个字符的备份口令。';return;}
    if(['backup','export'].includes(action) && password!==$('#backupRepeat').value){$('#backupStatus').textContent='两次口令不一致。';return;}
    const buttons=[...dialog.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);$('#backupStatus').textContent='正在处理…';
    try{
      const result=await invoke('backup_api',{action,password,token});
      if(result.canceled){$('#backupStatus').textContent='已取消';return;}
      if(action==='inspect'){
        token=result.token;const s=result.summary;
        $('#backupSummary').textContent=`备份时间：${s.created}\n机器：${s.machines} 台 · ${s.files} 个数据文件\n密码：${s.hasPasswords?'包含':'无'} · 执行记录：${s.hasHistory?'包含':'无'}\n恢复将替换当前插件数据，原数据保留为回退副本。恢复后后台监控保持关闭。`;
        $('#backupStatus').textContent='校验通过，请确认恢复。';
      }else if(action==='restore'){
        clear();$('#backupStatus').textContent=`恢复已准备好，请到插件市场重新加载机器插件。\n原数据回退位置：${result.rollback}`;
      }else{clear();$('#backupStatus').textContent=`加密备份已保存：${result.path}`;}
    }catch(error){$('#backupStatus').textContent=String(error);}
    finally{buttons.forEach(b=>b.disabled=false);$('#restoreBackup').disabled=!token;}
  }
  $('#createBackup').onclick=()=>run('backup');$('#exportBackup').onclick=()=>run('export');$('#inspectBackup').onclick=()=>run('inspect');$('#restoreBackup').onclick=()=>run('restore');
})();
