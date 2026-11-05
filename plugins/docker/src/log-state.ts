export interface LogState {text:string;query:string;auto:boolean;tail:boolean;scrollTop:number;updatedAt:number|null;error:string}
export const emptyLogs=():LogState=>({text:'',query:'',auto:false,tail:true,scrollTop:0,updatedAt:null,error:''});
/** Eight recent container views, in memory only. A Docker context change drops all logs. */
export class LogSessions {
  private context='';
  private entries=new Map<string,LogState>();
  activate(context:string){if(this.context!==context){this.context=context;this.entries.clear();}}
  read(context:string,id:string){const state=context===this.context?this.entries.get(id):undefined;return state?{...state}:undefined;}
  remember(context:string,id:string,state:LogState){
    if(context!==this.context)return;
    this.entries.delete(id);this.entries.set(id,{...state});
    if(this.entries.size>8)this.entries.delete(this.entries.keys().next().value!);
  }
}
