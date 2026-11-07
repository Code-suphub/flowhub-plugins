export interface Identity {pid:number;started:number;executable:string;uid:number}
export interface BackgroundService {id:string;label:string;name:string;domain:string;plistPath:string;program:string;appPath:string|null;restart:string;restartHint:string;loaded:boolean;paused:boolean;identity:Identity|null;canStop:boolean;canResume:boolean;blockedReason:string}
export interface ServiceSnapshot {at:number;supported:boolean;services:BackgroundService[]}
export interface ServicePlan {token:string;expiresIn:number;action:'stop'|'resume';service:BackgroundService}
export type ToolIconKey = 'python'|'postgresql'|'mysql'|'tmux'|'redis'|'android';
export interface SystemAccounting {footprint:number|null;coalitionCount:number;shared:boolean}
export interface Process extends Identity {
  displayName?:string|null;
  launchExecutable?:string|null;
  terminalOwner?:Identity|null;
  instanceId?:string;
  responsible?:Identity|null;
  runtimeProject?:{name:string;root:string;entry:string|null;evidence:string}|null;
  ppid:number;name:string;memory:number|null;footprint:number|null;cpu:number|null;cwd:string;role:string;avd:string;exited?:boolean;moved?:boolean;
  protected:boolean;protection:string;parentName:string;groupId:string;attribution:string;
}
export interface Group {
  systemAccounting?:SystemAccounting|null;
  presentation?:Presentation|null;
  origin?:SourceOrigin|null;
  iconKey?:ToolIconKey|null;
  id:string;name:string;source:string;memory:number|null;footprint:number|null;footprintIncomplete:boolean;appPath:string|null;cpu:number|null;incomplete:boolean;
  system:boolean;processes:Process[];canTerminate:boolean;
  instances?:Instance[];
}
export interface SourceOrigin {name:string;appPath:string|null;evidence:string}
export interface Presentation {name:string|null;sources:SourceOrigin[];services?:Array<{name:string;label:string;evidence:string}>}
export interface Instance {id:string;root:Identity;count:number;memory:number|null;footprint:number|null;cpu:number|null;incomplete:boolean;footprintIncomplete:boolean;canTerminate:boolean;presentation?:Presentation|null}
export interface SystemInfo {totalMemory?:number|null;swapUsed?:number|null;pressure?:string|null}
export interface SnapshotState {at:number;revision?:number;sampling?:boolean;stale?:boolean;scriptRunningCount?:number;system:SystemInfo;error?:string|null;memoryMetric:'footprint';interval:number}
export interface ScriptNode extends Identity {name:string;appPath:string|null}
export interface ScriptRecord {id:string;process:ScriptNode;chain:ScriptNode[];responsible:ScriptNode|null;source:SourceOrigin|null;chainNote:string;firstSeen:number;lastSeen:number;running:boolean}
export interface ScriptActivity extends SnapshotState {records:ScriptRecord[]}
export interface ScriptObservation {id:string;windowId:number;owner:Identity;firstSeen:number;lastSeen:number;visible:boolean;candidateCount:number;candidates?:ScriptRecord[];canReplay?:boolean}
export interface ScriptObserver {supported:boolean;enabled:boolean;available:boolean;at:number;revision?:number;interval:number;records:ScriptRecord[];observations:ScriptObservation[];error?:string|null}
export interface Snapshot extends SnapshotState {groups:Group[]}
export interface GroupSummary extends Omit<Group,'processes'|'instances'> {processCount:number;instanceCount:number;onlyInstanceId?:string|null;permissionLimited:boolean;hasRestrictedProcesses:boolean}
export interface RankingSnapshot extends SnapshotState {groups:GroupSummary[];includeSystem:boolean;hasRestrictedProcesses:boolean;query:string;matchedGroupIds:string[]}
export interface GroupDetail extends SnapshotState {groupId:string;group:Group|null;elsewhere:Identity[];contextProcesses:Process[]}
export interface StatusRow {id:string;name:string;systemAccounting?:SystemAccounting|null;appPath?:string|null;origin?:SourceOrigin|null;presentation?:Presentation|null;iconKey?:ToolIconKey|null;at:number;status:string;summary:string;values:{memory:number|null;footprint:number|null;rss:number|null;cpu:number|null};count:number;instanceCount?:number;incomplete:boolean}
export interface StatusSnapshot {at:number;rows:StatusRow[];system:SystemInfo;error?:string|null}
export type Sort = 'footprint'|'memory'|'cpu'|'accounting';
export type SortOrder = 'ascend'|'descend';
export interface Config {title?:string;sort?:Sort;display?:'all'|'top';limit?:number;groupId?:string;selection?:{groupId?:string};sourceView?:string;scriptEventId?:string}
export interface ApplicationState {canQuit:boolean;message:string;instances?:number;quitInstances?:string[];contextKind?:'arc'|'codex'|null}
export interface QuitPlan {token:string;expiresIn:number;name:string;appPath:string;targets:Identity[];instanceId?:string;root?:Identity}
export interface ContextEntry {id:string;token:string|null;title:string;detail:string;processes:Identity[];source:string;shared:boolean;ambiguous:boolean}
export interface PageContexts {
  kind:'arc'|'codex'|'unsupported';hint:string;mapping:'application-only'|'process-linked';at:number;entries:ContextEntry[];unmappedProcesses:number;
  diagnostics?:{state:string;hint:string;at:number;unreadable?:number;unmatchedTasks?:number;readTasks?:number;partial?:boolean}|null;
}
export interface Context {preview?:boolean;title?:string;config?:Config;snapshot?:StatusSnapshot}
export interface Plan {token:string;force:boolean;expiresIn:number;targets:Process[];scope?:{kind:'instance'|'instances'|'process';name?:string;instanceId?:string;root?:Identity;instances?:Array<{id:string;root:Identity;count:number}>}}
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
