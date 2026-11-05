import type {Api} from './types';

export interface ApplicationInfo {path:string;name:string;bundleId:string;iconUrl:string;relatedApplication?:{path:string;name:string;bundleId:string;iconUrl:string;evidence:string}|null}
export type ApplicationMap=Record<string,ApplicationInfo>;

interface Clock {
  now():number;
  setTimeout(callback:()=>void,delay:number):ReturnType<typeof setTimeout>;
  clearTimeout(timer:ReturnType<typeof setTimeout>):void;
}

const systemClock:Clock={now:()=>Date.now(),setTimeout:(callback,delay)=>setTimeout(callback,delay),clearTimeout:timer=>clearTimeout(timer)};
const batchSize=64,maxConcurrentBatches=2,maxAttempts=4;
// Initial request plus three retries, shared by transport errors, missing rows
// and empty icons. Hiding/showing a path never resets this budget.
const retryDelay=(attempts:number)=>Math.min(1000*2**(attempts-1),4000);
const pngPrefix='data:image/png;base64,';

export function isNativeApplicationIcon(url?:string|null):url is string {
  return !!url&&url.startsWith(pngPrefix)&&!!url.slice(pngPrefix.length).trim();
}

function unsupported(error:unknown) {
  const detail=error&&typeof error==='object'?error as {code?:unknown;message?:unknown}:undefined;
  if(detail?.code===-32601||['METHOD_NOT_FOUND','UNKNOWN_METHOD','UNSUPPORTED_METHOD','UNKNOWN_COMMAND'].includes(String(detail?.code)))return true;
  const message=typeof error==='string'?error:typeof detail?.message==='string'?detail.message:'';
  // These Chinese messages are the legacy plugin and widget dispatch errors.
  // A missing application/icon or a transport timeout is not a capability error.
  return /未知插件方法|不支持的组件操作|\b(?:unknown|unsupported|unrecognized)\s+(?:(?:plugin|ipc|rpc)\s+)?(?:method|command)\b|\bmethod not found\b/i.test(message)
    || /\bapplication_metadata\b['"`]?\s+(?:(?:is|was)\s+)?(?:not (?:found|supported|implemented)|does not exist|unsupported)\b/i.test(message)
    || /(?:未知|不支持|未实现)(?:的|该)?(?:插件)?(?:方法|命令|接口)?[：:\s]*['"`]?application_metadata\b|\bapplication_metadata\b['"`]?\s*(?:不受支持|不支持|未实现)/i.test(message);
}

function readApplication(value:unknown):ApplicationInfo|undefined {
  if(!value||typeof value!=='object')return;
  const row=value as Record<string,unknown>;
  if(typeof row.path!=='string'||typeof row.name!=='string'||!row.name.trim())return;
  const text=(value:unknown)=>typeof value==='string'?value:'';
  const icon=(value:unknown)=>typeof value==='string'&&isNativeApplicationIcon(value)?value:'';
  const app:ApplicationInfo={path:row.path,name:row.name,bundleId:text(row.bundleId),iconUrl:icon(row.iconUrl)};
  if(row.relatedApplication&&typeof row.relatedApplication==='object') {
    const related=row.relatedApplication as Record<string,unknown>;
    if(typeof related.path==='string'&&typeof related.name==='string'&&related.name.trim()) {
      app.relatedApplication={path:related.path,name:related.name,bundleId:text(related.bundleId),iconUrl:icon(related.iconUrl),evidence:text(related.evidence)};
    }
  }
  return app;
}

const hasIcon=(app:ApplicationInfo)=>!!(app.iconUrl||app.relatedApplication?.iconUrl);
interface PathState {active:boolean;revision:number;attempts:number;retryAt:number;complete:boolean;pending?:object}
interface RequestPath {path:string;state:PathState;revision:number}

/** One API connection/view lifetime. invoke has its own bounded host timeout;
 * it cannot be aborted, so disposal and path revisions invalidate late replies. */
export function createApplicationMetadataRequests(api:Pick<Api,'invoke'>,onApplications:(applications:ApplicationMap)=>void,clock:Clock=systemClock) {
  const entries=new Map<string,PathState>();
  let applications:ApplicationMap={},activePaths=new Set<string>();
  let capability:'unknown'|'supported'|'unsupported'='unknown';
  let disposed=false,inFlight=0,pumping=false,timer:ReturnType<typeof setTimeout>|undefined;
  const stopped=()=>disposed||capability==='unsupported';

  function clearTimer() {
    if(timer!==undefined)clock.clearTimeout(timer);
    timer=undefined;
  }

  function settle(batch:RequestPath[],token:object,rows?:unknown[]) {
    const allowed=new Set(batch.map(item=>item.path)),received=new Map<string,ApplicationInfo>();
    for(const row of rows??[]) {
      const app=readApplication(row);
      if(!app||!allowed.has(app.path))continue;
      // Duplicate/partial rows cannot replace an already usable native icon.
      const previous=received.get(app.path);
      if(!previous||!hasIcon(previous))received.set(app.path,app);
    }
    const updates: Array<[string,ApplicationInfo]>=[];
    for(const {path,state,revision} of batch) {
      if(state.pending!==token)continue;
      state.pending=undefined;
      if(state.active&&state.revision===revision) {
        const app=received.get(path);
        if(app) {
          updates.push([path,app]);
          state.complete=hasIcon(app);
        }
      }
      // Publish names immediately even if their icon is absent. Failed or
      // omitted rows retain any previously cached name while using fallbacks.
      state.retryAt=clock.now()+retryDelay(state.attempts);
    }
    if(updates.length) {
      applications={...applications,...Object.fromEntries(updates)};
      onApplications(applications);
    }
  }

  async function request(batch:RequestPath[],token:object) {
    try {
      const result=await api.invoke<{applications?:unknown}>('application_metadata',{paths:batch.map(item=>item.path)});
      if(stopped())return;
      const rows=result&&Array.isArray(result.applications)?result.applications:undefined;
      if(rows)capability='supported';
      settle(batch,token,rows);
    } catch(error) {
      if(stopped())return;
      if(unsupported(error)) {
        capability='unsupported';
        clearTimer();
      } else settle(batch,token);
    } finally {
      inFlight--;
      pump();
    }
  }

  function pump() {
    if(pumping)return;
    pumping=true;
    try {
      clearTimer();
      if(stopped())return;
      // Probe once before fanning out: an old host fails only one request,
      // even when the initial view contains several batches of paths.
      const capacity=capability==='unknown'?1:maxConcurrentBatches;
      while(!stopped()&&inFlight<capacity) {
        const batch:RequestPath[]=[];
        for(const path of activePaths) {
          const state=entries.get(path)!;
          if(!state.complete&&!state.pending&&state.attempts<maxAttempts&&state.retryAt<=clock.now())batch.push({path,state,revision:state.revision});
          if(batch.length===batchSize)break;
        }
        if(!batch.length)break;
        const token={};
        for(const {state} of batch) {state.attempts++;state.pending=token;}
        inFlight++;
        void request(batch,token);
      }
      // One wakeup for the earliest eligible path. Full slots are woken by
      // request completion instead of spinning a zero-delay timer.
      if(stopped()||inFlight>=capacity)return;
      let next=Infinity;
      for(const path of activePaths) {
        const state=entries.get(path)!;
        if(!state.complete&&!state.pending&&state.attempts<maxAttempts)next=Math.min(next,state.retryAt);
      }
      if(Number.isFinite(next))timer=clock.setTimeout(()=>{timer=undefined;pump();},Math.max(0,next-clock.now()));
    } finally {pumping=false;}
  }

  return {
    setPaths(paths:readonly string[]) {
      if(disposed)return;
      const next=new Set(paths.filter(Boolean));
      for(const path of activePaths) {
        if(!next.has(path)) {const state=entries.get(path)!;state.active=false;state.revision++;}
      }
      for(const path of next) {
        const state=entries.get(path);
        if(state)state.active=true;
        else entries.set(path,{active:true,revision:0,attempts:0,retryAt:0,complete:false});
      }
      activePaths=next;
      pump();
    },
    dispose() {
      disposed=true;
      clearTimer();
      activePaths.clear();
      entries.clear();
      applications={};
    }
  };
}
