import type {BackgroundService,Identity} from './types';
export type ServiceScope={appPath?:string;ids?:string[];name?:string};
export const sameServiceProcess=(service:BackgroundService,process:Identity)=>!!service.loaded&&!!service.identity&&(['pid','uid','started','executable'] as const).every(key=>service.identity![key]===process[key]);
export const restartLabel=(service:BackgroundService)=>({always:'会自动重启','abnormal-exit':'强制结束后重启','successful-exit':'正常退出后重启',conditional:'按条件重启',demand:'可能按需启动',login:'登录或开机启动'} as Record<string,string>)[service.restart]??'启动条件未确认';
export const serviceInScope=(service:BackgroundService,scope?:ServiceScope)=>!scope||!!scope.appPath&&service.appPath===scope.appPath||!!scope.ids?.includes(service.id);
