# 插件布局自动预览

各插件在自己的目录运行 `pnpm plasmic:dev`，私有认证文件通过环境变量 `PLASMIC_AUTH_FILE` 提供。按需启动正在编辑的模块，停止后保留最后一次同步的本地 CSS；不要为查看设计而更新安装版。资源监控的既有 SDK 卡片继续使用原来的 `plasmic:host`。

| 插件 | 页面预览端口 | 管理页入口 |
| --- | --- | --- |
| resource-monitor | 5201 | /ui/index.html |
| twofa | 5202 | /ui/index.html |
| device-center | 5203 | /ui/index.html |
| docker | 5204 | /ui/index.html |
| machines | 5205 | /machines.html |
| social-hub | 5206 | /ui/index.html |

各插件的 `design/plasmic/layouts.json` 显式列出“联动 · …”组件及管理页、卡片、详情和编辑器入口。当前插件新增映射覆盖页面外层布局，原控件、业务内容、内部结构和动态状态由源码维护；更细的区域需要逐个加入映射。源设计里的 HTML ID `flowhub-layout-root` 是稳定接口，保留该 ID 后可以修改其样式。原 110 个设计视图继续保留。

服务每三秒检查 Plasmic main 的保存版本，只将绑定区域相对基线的样式差异生成到 `ui/plasmic-layouts.css`。Vite 更新开发页面，角落显示状态。普通开发、构建和安装版不启动监听，不将 Node 工具、认证或示例业务内容打进生产 JS。

运行 `pnpm plasmic:layouts:sync --check` 离线检查，`--apply` 单次同步。手改生成文件、修改未绑定内容或结构、新增未适配变体、外部 URL 和可执行内容会停止覆盖并显示原因。认证、原始设计模型、截图及运行日志不进入 Git。

复测时先在 Plasmic 将根区域间距临时改为 17px，确认开发页面自动更新，再恢复并确认生成 CSS 回到原样；检查深浅主题、380 / 1150px、Tab / Esc、控制台和原业务测试。模块验收记录在各插件 `docs/plasmic-layouts.md`，具体提交看 Git 历史。浏览器事件不证明普通安装版的系统焦点、IME、多屏或实际硬件通过；安装版在独立验收后再更新。
