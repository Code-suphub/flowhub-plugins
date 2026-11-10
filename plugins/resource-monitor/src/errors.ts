const labels:Record<string,string>={script_observer_status:'读取自动观察状态',script_observer_event:'读取认证窗口线索',script_observer_config:'设置自动观察',services_snapshot:'读取后台服务',service_preview:'核对后台服务操作',service_confirm:'停止或恢复后台服务',status_snapshot:'读取监控卡片',snapshot:'读取进程快照',ranking_snapshot:'读取应用排行',group_detail:'读取进程详情',script_activity:'读取脚本来源',refresh:'刷新采样',refresh_summary:'刷新采样',application_state:'检查应用状态',application_metadata:'读取应用名称与图标',privileged_status:'检查授权状态',privileged_enable:'安装或升级系统服务',privileged_disable:'卸载系统服务',terminate_preview:'核对结束范围',terminate_confirm:'结束所选进程',quit_preview:'核对退出范围',quit_confirm:'正常退出应用',contexts:'读取页面与对话',arc_tasks:'读取浏览器任务',focus_app:'打开应用',open_context:'打开页面或对话',accessibility_settings:'打开辅助功能设置',flowhub_status:'打开桌面与菜单栏'};
Object.assign(labels,{startup_snapshot:'读取自启动状态',startup_set:'更改自启动设置',startup_stop:'停止数据库后台服务',login_items_settings:'打开登录项设置'});
Object.assign(labels,{finder_extensions_snapshot:'读取访达扩展',finder_extension_set:'更改访达扩展'});
Object.assign(labels,{configureCard:'保存卡片设置',set_view_preferences:'保存排行显示设置'});
export const requestLabel=(method:string)=>Object.hasOwn(labels,method)?labels[method]:'插件请求';
export type DisplayError=Error|string;
export const displayError=(error:unknown):DisplayError=>error instanceof Error?error:String(error);
export const errorText=(error:unknown)=>String(error instanceof Error?error.message:error??'').replace(/^(?:Error:\s*)+/, '');

export class RequestError extends Error {
  readonly name='RequestError';
  readonly label:string;
  constructor(message:string,readonly method:string,readonly traceId:string,readonly surface:string,readonly started:number,readonly elapsedMs:number,readonly code:string){
    super(errorText(message));this.label=requestLabel(method);
  }
  report(){return `${this.message}\n请求：${this.label} (${this.method})\ntraceId：${this.traceId}\n页面：${this.surface}\n开始时间：${new Date(this.started).toISOString()}\n耗时：${this.elapsedMs} ms\n错误类型：${this.code}`;}
}
