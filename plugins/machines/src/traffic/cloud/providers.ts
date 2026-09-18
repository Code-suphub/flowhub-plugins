import type { CloudField, CloudProvider, CloudTrafficDraft } from './types';

export const FIELD_LABELS: Record<CloudField,string>={region:'地域',instanceId:'实例 ID / 名称',secretId:'Access Key ID / SecretId',secretKey:'Access Key Secret / SecretKey',token:'临时会话 Token（可选）',veid:'VEID',apiKey:'API Key / 只读 Token',packageId:'流量包 ID',site:'华为云站点',apiToken:'API Token',cookie:'Cookie 串',xsrfToken:'XSRF Token',serverId:'Server ID',limitGB:'套餐流量 / GB（可选）',netdataId:'Netdata 节点'};
export const SECRET_FIELDS:readonly CloudField[]=['secretId','secretKey','token','apiKey','apiToken','cookie','xsrfToken'];
export const CLOUD_PROVIDERS:readonly CloudProvider[]=[
 {id:'tencent',name:'腾讯云 · Lighthouse',fields:['region','instanceId','secretId','secretKey','token'],required:['region','instanceId'],help:'查询单台轻量实例套餐余量；只读权限 lighthouse:DescribeInstancesTrafficPackages。'},
 {id:'bandwagon',name:'搬瓦工 · KiwiVM',fields:['veid','apiKey'],required:['veid'],help:'从 KiwiVM API 获取 VEID 和 API Key。'},
 {id:'aliyun',name:'阿里云 · 轻量应用服务器',fields:['region','instanceId','secretId','secretKey','token'],required:['region','instanceId'],help:'查询轻量实例本月套餐余额；不适用于 ECS 按量公网账单。'},
 {id:'huawei',name:'华为云 · Flexus L',fields:['site','packageId','secretId','secretKey'],required:['site','packageId'],help:'填写流量包 ID（不是服务器 ID），凭证需要资源包查询权限。'},
 {id:'linode',name:'Linode / Akamai · 共享流量',fields:['region','apiKey'],required:[],help:'账户本月共享流量，可选地域；共享余量不是单机专属。'},
 {id:'vultr',name:'Vultr · 共享流量',fields:['apiKey'],required:[],help:'账户本月至今共享额度和出站用量。'},
 {id:'aws',name:'AWS · Lightsail 监控用量',fields:['region','instanceId','secretId','secretKey','token'],required:['region','instanceId'],help:'本月 UTC 监控用量，只表示已用量。'},
 {id:'zgocloud',name:'ZgoCloud · API Token',fields:['apiToken','serverId','limitGB'],required:['apiToken','serverId'],help:'填写 API Token 与整数 Server ID。'},
 {id:'zgocloudCookie',name:'ZgoCloud · Session Cookie',fields:['cookie','xsrfToken','serverId','limitGB'],required:['cookie','xsrfToken','serverId'],help:'填写浏览器 Cookie 和 x-xsrf-token；Cookie 过期后需更新。'},
 {id:'localNet',name:'网卡计数器 · 本地 Netdata',fields:['netdataId','limitGB'],required:['netdataId'],help:'按北京时间自然月累计 Netdata rx/tx，并计算日均和剩余天数。'},
];
export const emptyCloudDraft=():CloudTrafficDraft=>({provider:'tencent',clearToken:false,region:'',instanceId:'',secretId:'',secretKey:'',token:'',veid:'',apiKey:'',packageId:'',site:'cn',apiToken:'',cookie:'',xsrfToken:'',serverId:'',limitGB:'',netdataId:''});
