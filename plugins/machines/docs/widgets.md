# 机器监控桌面组件

组件页面与机器后端一起打包发布：

- `ui/widget-card.html` + `ui/widget/widget-card.*`：卡片、仪表、网速和底部状态。
- `src/widget-editor/index.html` + `src/widget-editor/*`：机器选择、显示指标配置；构建后输出为 `ui/widget-editor.html` 和 `ui/react/widget-editor.*`。
- `ui/widget-detail.html` + `ui/widget/widget-detail.*`：历史曲线概览、点击放大和时间范围。设置入口复用 `machines.html?widgetSettings=1` 的完整机器编辑表单，通过 `ui/widget/widget-settings-bridge.js` 连接插件设置接口；无需另行维护缩减版表单。
- `ui/widget/widget-bridge.js`：卡片、详情页和 React 编辑器共用的宿主消息通信边界；插件后端 `widget_api` 允许历史读取及有限的机器信息设置。

入口页与 `widget-*.html` 固定放在 `ui/` 根目录：`flowhub-plugin.json` 的 `ui` 取文件名，宿主按 `<id>/<文件名>` 加载；`widget-preview.json` 也留在根目录，宿主预览按 `<previewBase>/widget-preview.json` 取用。

FlowHub 只提供通用容器和布局。修改以上页面不再需要修改或重建宿主；首次使用需要安装支持 manifest `widget` 的宿主版本。`flowhub-plugin.json` 声明三个页面的入口，发布脚本自动把 UI 目录包含在插件产物中。

配置为 `{view:"machine",row:"机器 ID",metrics:["cpu","memory","disk","rx","tx","load","uptime"]}`，由宿主作为不透明对象保存。旧宿主布局的同名字段可直接读取。详情页不绘制运行时间曲线。

机器配置可选 `countryCode`（两位地区代码）和 `expiresAt`（UTC 毫秒时间戳）。管理页按本地时区输入到期时间，随机器配置复制、备份与恢复。单机卡片标题显示国旗，底部显示剩余时间；7 天内用提醒色，已到期显示过期时长。倒计时每分钟更新，不依赖重新采集。未设置字段的旧机器不显示这些内容。

`widget_api` 历史请求示例：`{action:"history",row:"机器 ID",metric:"cpu",seconds:86400}`。数据来自插件本地 SQLite，不通过宿主解释指标。`settings` 读取名称、分组、地区和到期时间，`saveSettings` 只允许修改这四项，并用 `expected` 比对原值防止覆盖其他页面的修改；不提供命令执行或 SSH 配置修改。

运行 `npm run dev:machines -- --port 5182` 后，以 FlowHub 预览页 `plugin-canvas.html?preview=http://127.0.0.1:5182/` 验证；模拟状态存放在 `ui/widget-preview.json`。浏览器预览不连接真实机器。

早期卡片布局方案对比见 [machine-widget-layouts.html](machine-widget-layouts.html)（静态设计稿，四种方案示意，未接入运行时）。
