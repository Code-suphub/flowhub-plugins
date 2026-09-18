# React + Tailwind 渐进迁移

## 原则

- 插件发布包继续保持自包含，不在运行时依赖仓库路径或 CDN。
- `plugins/common` 提供 React 组件与设计 token；插件桥接、业务状态和凭证逻辑仍归具体插件。
- 保留现有 Vanilla 页面，按入口逐个迁移；每个入口迁移完成后再删除对应旧脚本和样式。
- React、Tailwind 和公共组件全部在构建阶段打进 `plugins/<id>/build/`。

## 任务

1. **公共组件库（已完成）**：Button、Field、Checkbox、Select、HelpPopover、Pagination、DataTable、Tabs、DialogShell、StatStrip、Toolbar、EmptyState。
2. **构建基座（已完成）**：React 19、TypeScript、Vite、Tailwind CSS 4，以及 common 本地包解析。
3. **组件编辑器（已完成）**：迁移机器组件编辑器，保持 `FlowHubWidget` 保存协议完全兼容。
4. **机器概况与列表（已完成）**：React 接管统计、筛选、选择、响应式表格/卡片和监控开关；原有脚本通过事件桥继续处理采集、编辑和更多操作。
5. **回归保护（持续）**：类型检查、构建产物自包含检查、现有 Rust/DOM/布局测试。
6. **后续入口**：机器配置、云流量、Netdata、命令工作台和执行记录，按风险逐步迁移。

## 完成标准

- `npm --prefix plugins/machines run typecheck` 通过。
- `npm --prefix plugins/machines run build` 生成 React 入口且不引用仓库外资源。
- `npm test` 全部通过。
- 构建后的 widget editor 能读取初始化数据，并返回与旧页面一致的配置对象。
- 构建后的机器页包含 `react/fleet.js` 与 `react/fleet.css`，无裸模块导入、仓库外依赖或 source map。

## 构建与发布

`plugins/machines` 通过本地 `file:../common` 依赖使用公共源码。Vite 会把 React、Tailwind 与公共组件合并到 `build/ui/react/`，发布页面不需要同步 common 文件，也不会在运行时跨目录加载依赖。构建失败会删除不完整的 `build/`，避免误装旧页面；发布构建不包含 source map。

机器列表采用渐进式 island：源码 HTML 中保留可读的 Vanilla 回退结构，并用 `data-flowhub-fleet` 标记资源位置；开发服务器和发布构建分别把标记替换为最终的 `react/fleet.css`、`react/fleet.js`。React 同步挂载后只移除重复的概况与列表节点，机器编辑弹窗会被保留，并通过 `flowhub:fleet-action` 事件复用现有业务能力。

Tailwind 入口只加载 theme 与 utilities，不加载全局 preflight，避免迁移中的 React island 重置旧弹窗、终端和表单样式。每迁移完一个完整入口，才删除对应的 Vanilla DOM、事件绑定和样式。
