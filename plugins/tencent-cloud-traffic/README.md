# 腾讯云流量（FlowHub 开发插件）

当前支持 Lighthouse 轻量应用服务器的 DescribeInstancesTrafficPackages（2020-03-24），通过 TC3-HMAC-SHA256 签名调用 lighthouse.tencentcloudapi.com。

在 FlowHub 插件页面输入 SecretId、SecretKey、地域及可选 lhins- 实例 ID；临时凭证需填写 Token。实例 ID 留空时分页查询该地域所有实例的流量包。所需 CAM action 仅 lighthouse:DescribeInstancesTrafficPackages。显示官方总量、已用、剩余、超额及周期结束时间；字节转换为 GiB。

凭证仅在页面会话内使用，不持久化。默认不显示演示数据；只有点击“查看演示数据”才显示，且始终标注。请求失败不会替换为演示数据。不支持普通 CVM、共享流量包或账单查询。

运行依赖 Node.js 18+（FlowHub 进程 PATH 中须能找到 node）。npm test 运行模拟接口分页、错误处理与单位转换等测试。已验证 FlowHub 加载、演示和参数校验；尚未使用真实凭证验证腾讯云响应。

官方接口：https://cloud.tencent.com/document/api/1207/48681
