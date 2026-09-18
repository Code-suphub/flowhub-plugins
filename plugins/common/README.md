# FlowHub plugin common

插件公共 UI 基础层。源码只维护一份，运行时资源由根目录的
`scripts/sync-common.mjs` 同步到每个插件的 `ui/common/`，这样独立发布的
`.fhplugin` 不依赖仓库外路径。

## 组件边界

- `flowhub-common.css`：无主题的按钮、帮助气泡、数字输入、字段、表单网格、表格和分页基础样式。
- `flowhub-common.js`：帮助气泡和数字输入的行为，以及表单、表格、分页的轻量 DOM API。
- 颜色、字体、面板背景和页面布局由具体插件覆盖；公共层不读取业务状态，也不包含插件桥接逻辑。

## 使用方式

```html
<link rel="stylesheet" href="common/flowhub-common.css">
<script src="common/flowhub-common.js"></script>
```

脚本暴露 `window.FlowHubCommon`。主要 API 包括：

- `bindHelp()`、`mountNumberFields()`：说明气泡和数字输入行为。
- `selects.mount()`：把原生 `select` 接入统一键盘、搜索和选项同步行为；页面仍可通过兼容类名保留自己的皮肤。
- `field()`、`checkbox()`、`table()`、`pagination()`：用于新页面或逐步迁移的轻量 DOM 组件。

组件逐步迁移，不要求一次性重写所有页面。
