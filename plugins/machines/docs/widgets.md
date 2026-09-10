# 机器监控桌面组件

组件页面与机器后端一起打包发布：

- `ui/widget-card.*`：卡片、仪表、网速和底部状态。
- `ui/widget-editor.*`：机器选择、显示指标配置。
- `ui/widget-detail.*`：历史曲线、时间范围、全部/单指标模式。
- `ui/widget-bridge.js`：宿主消息通信；插件后端 `widget_api` 当前只允许历史读取。

FlowHub 只提供通用容器和布局。修改以上页面不再需要修改或重建宿主；首次使用需要安装支持 manifest `widget` 的宿主版本。`flowhub-plugin.json` 声明三个页面的入口，发布脚本自动把 UI 目录包含在插件产物中。

配置为 `{view:"machine",row:"机器 ID",metrics:["cpu","memory","disk","rx","tx","load","uptime"]}`，由宿主作为不透明对象保存。旧宿主布局的同名字段可直接读取。详情页不绘制运行时间曲线。

`widget_api` 请求示例：`{action:"history",row:"机器 ID",metric:"cpu",seconds:86400}`。数据来自插件本地 SQLite，不通过宿主解释指标，不在此接口提供命令执行或配置写入。

运行 `npm run dev:machines -- --port 5182` 后，以 FlowHub 预览页 `plugin-canvas.html?preview=http://127.0.0.1:5182/` 验证；模拟状态存放在 `ui/widget-preview.json`。浏览器预览不连接真实机器。
