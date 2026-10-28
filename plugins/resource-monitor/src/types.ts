export interface Identity {pid:number;started:number;executable:string;uid:number}
export interface Process extends Identity {
  ppid:number;name:string;memory:number|null;footprint:number|null;cpu:number|null;cwd:string;role:string;avd:string;exited?:boolean;
  protected:boolean;protection:string;parentName:string;groupId:string;attribution:string;
}
export interface Group {
  id:string;name:string;source:string;memory:number|null;footprint:number|null;footprintIncomplete:boolean;appPath:string|null;cpu:number|null;incomplete:boolean;
  system:boolean;processes:Process[];canTerminate:boolean;
}
export interface SystemInfo {totalMemory?:number|null;swapUsed?:number|null;pressure?:string|null}
export interface Snapshot {at:number;groups:Group[];system:SystemInfo;error?:string|null;memoryMetric:'footprint';interval:number}
export interface StatusRow {id:string;name:string;at:number;status:string;summary:string;values:{memory:number|null;footprint:number|null;rss:number|null;cpu:number|null};count:number;incomplete:boolean}
export interface StatusSnapshot {at:number;rows:StatusRow[];system:SystemInfo;error?:string|null}
export type Sort = 'footprint'|'memory'|'cpu';
export interface Config {title?:string;sort?:Sort;limit?:number;groupId?:string;selection?:{groupId?:string}}
export interface ContextEntry {id:string;token:string|null;title:string;detail:string;processes:Identity[];source:string;shared:boolean;ambiguous:boolean}
export interface PageContexts {
  kind:'arc'|'codex'|'unsupported';hint:string;mapping:'application-only'|'process-linked';at:number;entries:ContextEntry[];unmappedProcesses:number;
  diagnostics?:{state:string;hint:string;at:number;unreadable?:number;unmatchedTasks?:number;readTasks?:number;partial?:boolean}|null;
}
export interface Context {preview?:boolean;title?:string;config?:Config;snapshot?:StatusSnapshot}
export interface Plan {token:string;force:boolean;expiresIn:number;targets:Process[]}
export interface TerminateResult {results:Array<{pid:number;sent:boolean;exited:boolean;error?:string|null}>;refreshError?:string|null;snapshot:Snapshot}
export interface Api {
  readonly preview:boolean;readonly widget:boolean;
  invoke<T>(method:string,params?:Record<string,unknown>):Promise<T>;
  status():Promise<StatusSnapshot>;
  subscribe(handler:(context:Context)=>void):()=>void;
  editor(handler:()=>Config):void;
  ready():void;
  navigate(groupId?:string):void;
  dispose():void;
}
