# FlowHub Plugins 开发规范

## 页面与组件

- 新增和迁移的管理页面统一采用 React + TypeScript + Vite + Tailwind CSS；Rust 后端保留业务与加密存储职责。Tailwind 是样式层，不是 React 的替代；只迁移本次明确范围内的页面。
- 组件优先：按钮、输入、表单字段、弹窗、下拉菜单、帮助提示、空状态优先复用 `@flowhub/plugin-common/react`。不要在业务页重新实现已有交互；确实缺少的通用能力先补公共组件，再接入业务。
- 说明性内容通过统一 HelpPopover 等悬浮组件展示，鼠标悬浮和键盘聚焦均应可访问；长内容使用帮助弹窗。错误、加载状态、删除等风险警告必须就近可见，不能隐藏。
- 布局默认紧凑：避免嵌套边框、巨型详情卡和无意义留白；控件按内容设合理宽度，长选项列表使用可搜索组件。Tab／导航已说明页面用途时不再重复同名标题或英文眉题。
- 迁移验收必须包含类型检查、业务回归、只读预览、键盘操作、深浅主题、窄屏和打包资源检查；统一配色或接入公共脚本不算完成 React 迁移。

- 机器管理页面的预览入口是 `plugins/machines/ui/machines.html`；本地预览使用 `npm run dev -- --port 5183`。
- 页面中的说明性内容优先放进统一的帮助气泡或弹窗，主界面只保留操作所需的短标签和状态。
- Tab 已标明页面用途时，正文不重复同名大标题或导语；页面级说明放在对应 Tab 的悬浮提示中，状态、错误和操作警告仍就近显示。
- `plugins/common` 是跨插件公共 UI 包的唯一源码；插件构建时由 `scripts/package-plugin.mjs` 打包到 `plugins/<id>/build/`，不要在各插件 `ui/` 下提交公共资源副本。独立发布的插件不能依赖仓库外的源码路径。
- 新 React 页面从 `@flowhub/plugin-common/react` 导入组件，并由各插件的 Vite 构建打进最终产物；禁止从发布页面直接引用 `plugins/common`、CDN 或裸模块导入。
- 渐进迁移使用 React island，构建阶段替换资源标记。已由 React 完整接管的功能必须删除旧 HTML、渲染分支和专用样式，不保留隐藏回退；仍在使用的业务能力通过显式接口衔接。Tailwind island 不启用全局 preflight。
- 与 React island 同页加载的静态回退样式必须完整放进 `flowhub-legacy` cascade layer；禁止新增未分层的全局 `button`、`input`、`select`、`textarea` 或组件兼容类规则，以免覆盖 React/Common 组件。
- 公共层负责无主题的行为和基础组件：帮助气泡、Input、Textarea、NumberInput、FormSection、下拉交互、分页、字段、复选框、表格及按钮基础类；业务状态、插件桥接逻辑、颜色和页面布局仍由具体插件维护。
- 机器管理页和 widget 页可以保留各自的下拉视觉主题；公共层统一下拉行为，不强行合并页面皮肤。改动下拉外观后运行预览指纹检查。
- 所有插件页面通过 `data-theme` 与 `--fh-*` 语义颜色变量切换深浅主题，偏好保存到 `flowhub.theme`；新样式复用变量，不写死主题色。宿主通过 flowhub:theme-ready / flowhub:theme 同步主题，嵌入页面只接受父窗口消息，不自行保存主题；独立预览支持 system/light/dark。构建将 common 脚本输出到包内 `ui/_common` 并通过 src 加载，禁止内联可执行脚本或放宽 script-src；CSS 可内联。公共组件保留无主题场景的颜色回退，成功、警告和错误色与操作强调色分开。
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
