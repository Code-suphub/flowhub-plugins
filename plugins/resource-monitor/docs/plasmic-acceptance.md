# Plasmic 卡片接入验收

试点版本：0.5.1。环境：MacBook、macOS 15.5 / arm64、Node 26.12.0。布局组件：`ResourceMonitorCardLayout`，项目 `rKroot8WmpiogJg8366SaB`，生成版本 revision 127。维护入口与命令见 [接入说明](../design/plasmic/README.md)。

## 可重复检查

1. 在 Studio 修改卡片外框或四个区域的布局，保留 `header` / `alerts` / `list` / `footer` 名称。
2. 用 `pnpm plasmic:sync --apply` 拉取，核对 `src/plasmic/generated.json` 的 revision 和文件指纹；采样、保存与导航逻辑放在生成目录外。
3. 运行 `pnpm typecheck`、`node --test tests/plasmic-sync.test.mjs tests/card-entry.test.mjs`，再构建插件。检查系统字体、包内资源、无动态代码执行，以及原有卡片体积预算。
4. 在隔离宿主中检查采样刷新、列头排序、显示指标 / 范围、选中高亮、保存失败 / 重试、重建卡片恢复配置和 Esc 回到显示设置。
5. 启动 `pnpm plasmic:host`，在 Studio 插入菜单搜索 FlowHub，核对真实卡片组件及公共按钮；设计预览使用合成数据，不连接正常安装版。

## 本轮结果（2026-11-12）

- [x] 布局端到端同步：Plasmic 内边距 10px → 12px，本地读取为 12px；四份业务文件在同步前后指纹一致。后续 Studio 代码组件注册后，revision 127 再次同步成功。
- [x] 源码组件接入：在正常登录的 Studio 编辑器中连接本地 App Host，实际插入菜单出现“FlowHub · 应用资源卡片”“FlowHub · 公共按钮”。
- [x] 类型检查、全仓库 `npm test`、`npm run build`、`npm run layout:machines -- --check` 及 `git diff --check` 通过。Studio 注册后的资源监控复测：80 个 Rust 测试、85 个 Node / 浏览器测试通过。
- [x] 同步保护：拒绝无关项目 / 组件、外部 CSS 资源、缺失区域、未知代码组件依赖、预览组件递归嵌套、生成文件本地改动及未知文件；允许未被布局使用的已知 SDK 注册元数据。
- [x] 开发服务监听回归通过：文档及构建输出不重载 Studio，`src/design` 中的实际界面变更继续通知浏览器；测试使用独立临时目录，不干扰正在运行的编辑器。
- [x] 已构建卡片的宿主协议测试通过：握手 / token、28 行滚动、元数据与图标、排行联动、设置自动保存 / 重建恢复 / 失败重试、Esc 回焦、只读预览和清理行为。
- [x] 深浅主题 × 240 / 380 / 600px 共 6 组独立浏览器布局与键盘检查通过，页面错误 0。
- [x] 实际原生后端 + 隔离 HTTP 宿主 + Chromium：读取本机实际进程，确认采样发布时间前进；列头排序到达真实后端，配置写入测试目录并在重载后恢复，Esc 回到打开按钮。该测试不改安装版卡片配置，不执行进程结束或真实导航。
- [x] 最终卡片 JS 为 334,762 字节 / gzip 109,923 字节；基线为 291,853 / gzip 95,788 字节，gzip 增加约 14.1 KB，仍满足原有预算。Studio 注册代码与预览夹具不进入生产 IIFE。
- [x] 打包资源检查通过，0.5.1 可独立加载；构建与运行使用已同步的本地文件，无 Google Fonts 或 Plasmic CDN 依赖。
- [x] 正常安装版后台替换：备份 0.5.0 包和登记后，在原登记目录完整替换为 0.5.1，`plugin reload --dry-run` 不改登记，正式重载后核对 12 项 SHA256、版本与入口资源、新插件进程路径及宿主父进程；宿主未重启，其他插件登记及资源监控配置文件不变。
- [x] 正常安装版真实采样：两次 `plugin verify` 的采样时间前进，读取到 94 个应用组；只读历史 CLI 确认原有历史起点保留、最新记录继续前进、保留期仍为 48 小时，历史写入进程是新安装的后端。
- [x] 正常安装版卡片只读检查：通过 `toolkit desktop` 读取实际窗口截图及 AX，确认应用名称、CPU、活跃足迹、列头排序状态、显示设置和打开排行入口正常显示；未发送系统鼠标或键盘事件。
- [ ] 正常安装版卡片配置保存 / 导航、真实 macOS 键盘 / IME / 双屏交互：本轮未执行，不能由隔离 Chromium 或只读截图结果替代。

证据、截图、实际采样数据与日志保留在 Git 外：`~/.local/state/flowhub-plasmic-resource-card/`。主要文件为 `design-roundtrip.json`、`preview-acceptance.json`、`studio-cua-acceptance.json`、`studio-components.png`、`live-acceptance.json`、`resource-tests-final.log`、`card-tests-watch.log`、`resource-build-final.log`、`repo-tests-final.log`、`repo-build.log` 与 `layout.log`。

安装版替换记录位于该目录的 `installed-gdjcbc1y/`：`installation-receipt.json`、替换前后 CLI 读回、包指纹、进程核对及 `installed-widget.png`。安装来源为提交 `0ca07e6`，继续保留在独立试点分支，未合入 main。
