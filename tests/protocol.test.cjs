const {test}=require('node:test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),readline=require('node:readline');
test('independent executable reuses existing machine data without SSH',{timeout:15000},async(t)=>{
  const binary=path.resolve('bin/flowhub-machines');if(!fs.existsSync(binary))throw Error('先运行 npm run build');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'flowhub-plugin-rpc-'));
  fs.writeFileSync(path.join(root,'state.json'),JSON.stringify({hosts:[{id:'retained',name:'Retained',alias:'never-connect.example',group:'Migration'}],monitoring:false}));
  const child=spawn(binary,[],{env:{...process.env,FLOWHUB_PLUGIN_DATA:root},stdio:['pipe','pipe','pipe']});
  t.after(()=>{child.kill();fs.rmSync(root,{recursive:true,force:true});});
  const pending=new Map();let next=1;
  const lines=readline.createInterface({input:child.stdout});lines.on('line',line=>{const value=JSON.parse(line);pending.get(value.id)?.(value);pending.delete(value.id);});
  const call=(method,params={})=>new Promise(resolve=>{const id=next++;pending.set(id,resolve);child.stdin.write(JSON.stringify({id,method,params})+'\n');});
  try{
    const health=await call('health');assert.equal(health.result.protocol,1);
    const state=await call('machines_api',{action:'state',payload:{}});
    assert.equal(state.result.config.hosts[0].id,'retained');assert.equal(state.result.config.monitoring,false);
    const history=await call('machines_api',{action:'history',payload:{}});assert.equal(history.result.total,0);
    assert(fs.existsSync(path.join(root,'commands.sqlite3')));
  }finally{child.stdin.end();await new Promise(resolve=>child.once('exit',resolve));lines.close();fs.rmSync(root,{recursive:true,force:true});}
});
