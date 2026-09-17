# 机器管理页面的布局约束与工具

页面布局的问题大多不是"没写对"，而是**写过好几种**：同一个选择器在多个样式表里定义、
同一段布局叠了好几代、资源顺序散在文档里。这里记录当前生效的规则和用来守住它们的工具。

## 度量与回归工具

```sh
node scripts/layout-audit.mjs            # 三个视图 × 六档宽度的几何数字
node scripts/layout-audit.mjs --check    # 超阈值 exit 1（已接入 npm test）
node scripts/preview-fingerprint.mjs     # 自绘下拉的计算样式与基线比对（已接入 npm test）
node scripts/preview-fingerprint.mjs --write   # 确实要改外观时更新基线
node scripts/prune-dead-css.mjs --apply  # 删除永不生效的声明
npm test                                 # cargo + node --test + 上面两项
```

没有 Chrome 时两个浏览器工具都会跳过（不失败）；用 `CHROME_PATH` 指定其它浏览器。

## 真实预览复核

几何度量用的是"真实 CSS + 合成 DOM"，要看**真实渲染与真实数据**时走插件自带的预览：

```sh
npm run dev -- --port 5183        # 启动 ui/ 的 vite 预览（dev/machines-preview.js 提供模拟数据）
# 浏览器打开 http://127.0.0.1:5183/machines.html ，或在 FlowHub 里用
# plugin-canvas.html?preview=http://127.0.0.1:5183/ 加载
```

2026-09-17 用 headless Chrome 依次在 1400/600/380px 复核过：预览横幅与 2 台模拟机器
正常渲染（概况合计 2），概况栏 4/2/1 列随宽度切换，380px 横向滚到最右仍能看到机型列，
直连与堡垒机两个终端外壳都在，无 JS 异常与控制台错误。

## 强制约束

- **面板内边距**只有 `--panel-pad` 一个来源，表格的负边距与首末列内边距都跟着它走：
  窄断点改一个变量即可，不会出现首列与面板文字错位（历史问题：≤850px 时差 5px）。
- **控件高度**统一到 `--control-h`（输入框、原生下拉、按钮、自绘下拉触发器），
  紧凑场景（表格行内按钮、命令输入行）才另给尺寸。
- **概况栏**在 ≤760px 变两列、≤420px 变一列，分隔线随列数切换。
- **机器表格**首列（勾选）与机型列 sticky；窄窗限制机型列宽与末列 `min-width`，
  保证横向滚动时不遮住操作列。
- **终端**：直连命令与堡垒机共用 `.terminal-shell` + `.console-toolbar` +
  `.console-output-area` + `.terminal-input`；输出框只有在紧跟工具栏时才去掉上边框与上圆角。
- **帮助气泡**：宽屏按所在行布局左右对齐（默认右对齐，`.discovery-heading` 内左对齐），
  ≤760px 固定贴住可视区底部，不再逐处写定位补丁。
- **一个页面内不允许重复定义同一选择器**：谁生效只由 `<link>` 顺序决定，等价于随机
  （`tests/css-scope.test.cjs`）。样式表全部在 `<head>`、脚本全部集中在文档末尾。
- **不允许永不生效的声明**：同文件里后面还有一条同选择器、同属性、无条件声明的，
  前面那条在任何视口都不会赢（`tests/css-dead-declarations.test.cjs`）。
- **DOM id 契约**：脚本里 `$('#id')` 引用的元素必须在页面或脚本自身渲染的标记里存在
  （`tests/dom-id-contract.test.cjs`）。
- **自绘下拉**的外观由 `tests/fixtures/select-control-fingerprint.json` 锁定：
  4 个页面 × 2 档宽度，逐属性比对计算样式。

## 有意保留的重复

三套自绘下拉样式（`machine-controls.css`、`widget/widget-editor.css`、
`widget/widget-detail.css`）**刻意不合并**：实测三页在 padding、控件高度、配色、
圆角、字体、箭头几何、菜单偏移/阴影/z-index 等 **71 处**属性上各不相同，真正一致且
有意义的只有 9 处（多数还来自各自页面的 `button` 规则）。抽公共文件需要按页提供
70 多个变量去复现三套设计，比三份小副本更难维护；改为用上面的指纹基线锁住它们，
避免以后悄悄漂移。整页机器管理页与 widget 页面配色本就分属两套主题，同理。
