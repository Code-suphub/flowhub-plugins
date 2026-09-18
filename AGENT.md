# FlowHub Plugins 开发规范

## 页面与组件

- 机器管理页面的预览入口是 `plugins/machines/ui/machines.html`；本地预览使用 `npm run dev -- --port 5183`。
- 页面中的说明性内容优先放进统一的帮助气泡或弹窗，主界面只保留操作所需的短标签和状态。
- `plugins/common` 是跨插件公共 UI 包的唯一源码；插件构建时由 `scripts/package-plugin.mjs` 内联到 `plugins/<id>/build/`，不要在各插件 `ui/` 下提交公共资源副本。独立发布的插件不能依赖仓库外的源码路径。
- 新 React 页面从 `@flowhub/plugin-common/react` 导入组件，并由各插件的 Vite 构建打进最终产物；禁止从发布页面直接引用 `plugins/common`、CDN 或裸模块导入。
- 渐进迁移优先使用 React island：源码 HTML 保留可用回退，构建阶段替换资源标记；React 挂载成功后再移除重复旧节点，并用显式事件桥复用原有业务能力。Tailwind island 不启用全局 preflight。
- 公共层负责无主题的行为和基础组件：帮助气泡、数字输入、下拉交互、分页、字段、复选框、表格及按钮基础类；业务状态、插件桥接逻辑、颜色和页面布局仍由具体插件维护。
- 机器管理页和 widget 页可以保留各自的下拉视觉主题；公共层统一下拉行为，不强行合并页面皮肤。改动下拉外观后运行预览指纹检查。
- Widget 编辑器使用异步模块时，应在编辑器保存回调注册完成后再向宿主发送 ready；构建产物必须验证初始化与保存协议。

## 验证命令

```sh
npm test
npm run layout:machines -- --check
npm run build
```

机器管理页面的布局或下拉样式变化，还应在 1400、600、380 像素宽度下打开 `/machines.html` 检查滚动、弹窗和键盘操作。

## 代码与提交

- 保持插件边界，不把机器管理页面的业务逻辑复制到其他插件。
- 凭证、Token 和密钥不得写入日志、测试快照或提交内容。
- 提交信息使用简短的动词开头，说明用户可感知的变化。
