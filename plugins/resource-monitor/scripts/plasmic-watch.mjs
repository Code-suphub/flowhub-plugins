import path from 'node:path';
import {localState,remoteRevision,syncLayout} from './plasmic-sync.mjs';

const messages={
  credentials:'请设置有效的 PLASMIC_AUTH_FILE，并检查项目访问权限。',
  'local-edits':'生成目录有本地改动，请先处理改动；自动同步不会覆盖它们。',
  validation:'布局接口或资源校验未通过，请运行单次同步检查。',
  busy:'另一个布局同步正在运行，稍后重试。',
  network:'暂时无法连接 Plasmic，稍后自动重试。'
};

/** A single serial loop: unchanged revisions cost only a metadata read; failed
 * requests back off. Shutdown aborts pending requests before any source write. */
export function createLayoutWatcher({
  readLocal,readRevision,sync,onStatus=()=>{},onUpdated=()=>{},
  intervalMs=3000,maxRetryMs=30000,setTimer=setTimeout,clearTimer=clearTimeout,now=Date.now
}){
  const controller=new AbortController();
  let stopped=false,timer,running,failures=0,stamp;
  let status={phase:'checking',revision:null,remoteRevision:null,lastCheckedAt:null,error:null,nextCheckMs:intervalMs};
  const publish=patch=>{status={...status,...patch};onStatus({...status});};
  async function run(){
    try{
      const local=await readLocal();
      controller.signal.throwIfAborted();
      const previous=stamp??JSON.stringify(local.files);
      publish({revision:local.revision});
      const revision=await readRevision(controller.signal);
      controller.signal.throwIfAborted();
      publish({remoteRevision:revision});
      if(revision!==local.revision){
        publish({phase:'syncing',error:null});
        await sync(revision,controller.signal);
      }
      const current=await readLocal();
      controller.signal.throwIfAborted();
      const nextStamp=JSON.stringify(current.files);
      if(previous!==nextStamp)await onUpdated(current);
      controller.signal.throwIfAborted();
      stamp=nextStamp;
      failures=0;
      publish({phase:'ready',revision:current.revision,lastCheckedAt:now(),error:null,nextCheckMs:intervalMs});
    }catch(error){
      if(stopped)return;
      const code=Object.hasOwn(messages,error?.code)?error.code:'network';
      failures++;
      publish({phase:'error',error:{code,message:messages[code]},nextCheckMs:Math.min(maxRetryMs,intervalMs*2**Math.min(failures-1,5))});
    }
  }
  function check(){
    if(stopped)return Promise.resolve();
    if(running)return running;
    clearTimer(timer);
    running=run().finally(()=>{
      running=undefined;
      if(!stopped)timer=setTimer(check,status.nextCheckMs);
    });
    return running;
  }
  return {
    start:check,check,
    getStatus:()=>({...status}),
    async stop(){stopped=true;clearTimer(timer);controller.abort();await running;}
  };
}

/** Dev-only Vite plugin. Credentials stay in this Node process. No reload or
 * installation commands are available on its read-only status endpoint. */
export function plasmicAutoSync({authFile=process.env.PLASMIC_AUTH_FILE,enabled=process.env.PLASMIC_AUTOSYNC!=='0',fetchImpl=fetch,intervalMs=3000}={}){
  let state={phase:'disabled',revision:null,error:null},watcher;
  return {
    name:'flowhub-plasmic-auto-sync',apply:'serve',
    configureServer(server){
      const sourceRoot=server.config.root;
      server.middlewares.use('/__plasmic/status',(req,res)=>{
        if(req.method!=='GET'){res.writeHead(405);res.end();return;}
        res.setHeader('Content-Type','application/json; charset=utf-8');
        res.setHeader('Cache-Control','no-store');
        res.end(JSON.stringify(state));
      });
      const publish=value=>{
        const changed=value.phase!==state.phase||value.revision!==state.revision||value.error?.code!==state.error?.code;
        state=value;
        server.ws.send({type:'custom',event:'flowhub:plasmic-sync',data:state});
        if(changed){
          const line=`[Plasmic] ${state.phase}${state.revision?` · revision ${state.revision}`:''}${state.error?` · ${state.error.message}`:''}`;
          if(state.error)server.config.logger.warn(line);else server.config.logger.info(line);
        }
      };
      if(!enabled||!authFile){
        state={phase:'disabled',revision:null,error:!enabled?null:{code:'credentials',message:messages.credentials}};
        if(enabled)server.config.logger.warn('[Plasmic] 自动同步未开启：请设置 PLASMIC_AUTH_FILE 后重新启动开发服务。');
        return;
      }
      watcher=createLayoutWatcher({
        readLocal:()=>localState(sourceRoot),
        readRevision:signal=>remoteRevision({authFile,fetchImpl,signal}),
        sync:(minimumRevision,signal)=>syncLayout({sourceRoot,authFile,fetchImpl,signal,minimumRevision}),
        intervalMs,onStatus:publish,
        onUpdated(){
          // Generated files are excluded from chokidar in Plasmic mode. This
          // prevents intermediate folder swaps from resetting the Studio host.
          // Invalidate only generated modules and their importers, then refresh
          // the standalone preview; the editor itself keeps its current state.
          const generated=path.join(sourceRoot,'src/plasmic')+path.sep;
          for(const [file,modules]of server.moduleGraph.fileToModulesMap){
            if(file.startsWith(generated))for(const module of modules)server.moduleGraph.invalidateModule(module);
          }
          server.ws.send({type:'full-reload',path:'/plasmic-preview.html'});
        }
      });
      void watcher.start();
      // Vite also calls this hook for restart/close, including middleware mode.
      const close=server.close.bind(server);
      server.close=async()=>{await watcher.stop();return close();};
      server.httpServer?.once('close',()=>{void watcher.stop();});
    }
  };
}
