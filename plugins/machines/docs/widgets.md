# 机器监控桌面组件

组件页面与机器后端一起打包发布：

- `ui/widget-card.*`：卡片、仪表、网速和底部状态。
- `ui/widget-editor.*`：机器选择、显示指标配置。
- `ui/widget-detail.*`：历史曲线概览、点击放大和时间范围。设置入口复用 `machines.html?widgetSettings=1` 的完整机器编辑表单，通过 `widget-settings-bridge.js` 连接插件设置接口；无需另行维护缩减版表单。
- `ui/widget-bridge.js`：宿主消息通信；插件后端 `widget_api` 允许历史读取及有限的机器信息设置。

FlowHub 只提供通用容器和布局。修改以上页面不再需要修改或重建宿主；首次使用需要安装支持 manifest `widget` 的宿主版本。`flowhub-plugin.json` 声明三个页面的入口，发布脚本自动把 UI 目录包含在插件产物中。

配置为 `{view:"machine",row:"机器 ID",metrics:["cpu","memory","disk","rx","tx","load","uptime"]}`，由宿主作为不透明对象保存。旧宿主布局的同名字段可直接读取。详情页不绘制运行时间曲线。

机器配置可选 `countryCode`（两位地区代码）和 `expiresAt`（UTC 毫秒时间戳）。管理页按本地时区输入到期时间，随机器配置复制、备份与恢复。单机卡片标题显示国旗，底部显示剩余时间；7 天内用提醒色，已到期显示过期时长。倒计时每分钟更新，不依赖重新采集。未设置字段的旧机器不显示这些内容。

`widget_api` 历史请求示例：`{action:"history",row:"机器 ID",metric:"cpu",seconds:86400}`。数据来自插件本地 SQLite，不通过宿主解释指标。`settings` 读取名称、分组、地区和到期时间，`saveSettings` 只允许修改这四项，并用 `expected` 比对原值防止覆盖其他页面的修改；不提供命令执行或 SSH 配置修改。

运行 `npm run dev:machines -- --port 5182` 后，以 FlowHub 预览页 `plugin-canvas.html?preview=http://127.0.0.1:5182/` 验证；模拟状态存放在 `ui/widget-preview.json`。浏览器预览不连接真实机器。
