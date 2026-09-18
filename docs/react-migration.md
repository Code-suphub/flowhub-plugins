# React + Tailwind 渐进迁移

## 原则

- 插件发布包继续保持自包含，不在运行时依赖仓库路径或 CDN。
- `plugins/common` 提供 React 组件与设计 token；插件桥接、业务状态和凭证逻辑仍归具体插件。
- 保留现有 Vanilla 页面，按入口逐个迁移；每个入口迁移完成后再删除对应旧脚本和样式。
- React、Tailwind 和公共组件全部在构建阶段打进 `plugins/<id>/build/`。

## 任务

1. **公共组件库**：Button、Field、Checkbox、Select、HelpPopover、Pagination、DataTable。
2. **构建基座**：React 19、TypeScript、Vite、Tailwind CSS 4，以及 common 本地包解析。
3. **首个入口**：迁移机器组件编辑器，保持 `FlowHubWidget` 保存协议完全兼容。
4. **回归保护**：类型检查、构建产物自包含检查、现有 Rust/DOM/布局测试。
5. **后续入口**：机器配置弹窗、云流量、Netdata、列表与命令工作台，按风险逐步迁移。

## 完成标准

- `npm --prefix plugins/machines run typecheck` 通过。
- `npm --prefix plugins/machines run build` 生成 React 入口且不引用仓库外资源。
- `npm test` 全部通过。
- 构建后的 widget editor 能读取初始化数据，并返回与旧页面一致的配置对象。

## 构建与发布

`plugins/machines` 通过本地 `file:../common` 依赖使用公共源码。Vite 会把 React、Tailwind 与公共组件合并到 `build/ui/react/`，发布页面不需要同步 common 文件，也不会在运行时跨目录加载依赖。构建失败会删除不完整的 `build/`，避免误装旧页面；发布构建不包含 source map。
