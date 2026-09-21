# 机器管理与 Widget 布局回归

## 当前入口

- 机器管理由 `src/fleet/main.tsx` 的单个 React 根节点管理。页签、机器编辑器、监控与采集弹窗通过 React 属性、状态和 ref 协作，不使用旧全局导航接口。
- Widget 卡片与详情由 `src/widget/card.tsx`、`src/widget/detail.tsx` 渲染；编辑器由 `src/widget-editor/main.tsx` 渲染。
- Widget 宿主初始化可以重复发送，每页只能创建一个 React 根节点。保留消息来源、Token 和请求关联校验，不把宿主桥接误当作无用渲染代码删除。
- 公共交互组件来自 `@flowhub/plugin-common/react`；打包产物不依赖源码目录或 CDN。

## 验证

从插件目录运行：

```sh
node scripts/layout-audit.mjs --check
node scripts/preview-fingerprint.mjs
node scripts/preview-fingerprint.mjs --screenshots
npm test
```

`layout-audit` 使用真实 React 页面和模拟机器数据，检查机器列表、Netdata、云流量在 1400、1024、850、600、380px 下的溢出与旧节点，以及页签键盘导航、草稿保持、选择同步和编辑弹窗。

`preview-fingerprint` 先构建 React 产物，再检查卡片、详情、编辑器在 1400、600、380px 下的真实渲染和公共 Select 样式。资源缺失、空页面、无法展开下拉、曲线未加载或页面溢出必须失败，不能通过更新空基线掩盖问题。交互回归覆盖重复初始化、目标移除、查询错误、请求乱序和曲线放大弹窗。

确实改变下拉外观时，先检查截图，再运行 `node scripts/preview-fingerprint.mjs --write` 更新基线。没有 Chrome 时浏览器工具会跳过，可用 `CHROME_PATH` 指定浏览器；跳过不等于完成视觉验证。

仓库根目录联合验收：

```sh
npm test
npm run layout:machines -- --check
npm run build
```

## 开发预览

`npm run dev -- --port 5183` 提供机器页及三个 Widget 页，并构建、监听 React/common 源码。所有调试使用模拟数据，不执行真实 SSH 或修改用户配置。

## 样式边界

- 主页面旧静态兼容 CSS 放在 `flowhub-legacy` 层；已替代的脚本、HTML 和专用样式实际删除。
- Widget 展示与机器管理可保留不同主题，交互行为统一使用公共组件。
- 详情页的 Tailwind 仅加载 theme/utilities，不引入全局 preflight；公共弹窗与下拉必须有对应构建样式。
- 静态资源顺序、重复选择器、无效声明、DOM id 和发布产物自包含均有测试约束。
