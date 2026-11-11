# 后台资源历史验收

目标为资源监控 0.5.0，分支 `codex/resource-history`。本次不合入 main。

## 可重复步骤

在插件仓库运行：

```sh
npm test
npm run layout:machines -- --check
npm run build
node plugins/resource-monitor/tests/history-smoke.mjs plugins/resource-monitor/build/bin/flowhub-resource-monitor
git diff --check
```

历史专项测试在 `backend/src/history/tests.rs`、`tests/history-model.test.mjs` 和 `tests/history-view.test.mjs`；打包页面交互与 CSP 检查在 `tests/card-entry.test.mjs`。

1. 独立后端在临时数据目录采样，核对同一真实采样版本的 CPU、活跃足迹、RSS。全程不打开页面，等待下一分钟自动积累。
2. 改为 7 天，关闭并重启该独立后端，核对旧点和保留设置，再恢复 48 小时。分别读取普通管理和桌面详情的历史接口。
3. 单元测试验证缩短保留时间会清理旧点、缺失指标留空、跨应用隔离、采样去重、进程身份和采集会话改变处断线。7 天共 10080 个分钟点完整返回，不超过宿主响应限制。
4. 打包浏览器以公开夹具验证三项指标、方向键和 Home/End、48 小时与 7 天选择、重新打开回读、不同应用数据、空状态、错配拒绝与恢复。检查 1024、600、380 像素和深浅主题、控件切换时布局、独立滚动、CSP 和卡片体积预算。
5. 已安装版先备份包、登记和排行偏好；将完整正式构建部署到登记的原目录，用支持 `plugin reload` 的宿主 CLI 预演并重载。核对版本、所有包文件指纹、实际子进程和宿主父进程、其他插件登记及原有排行偏好。
6. 使用安装包自己的只读 CLI 读取历史状态，隔一段时间再次读取，确认写入进程为正常宿主的插件子进程，未打开详情时也有真实记录增长。

## 2026-11-11 结果

环境：macOS 15.5、Apple Silicon；宿主 `/Applications/FlowHub.app`，版本 `0.1.18-local.20261111110747`。原始日志、截图、包备份和用户数据位于 Git 外的 `~/.local/state/flowhub-mail-verification/resource-history.PeESWJKZ/`。

| 层级 | 已验证内容 | 结果 |
| --- | --- | --- |
| 后端与组件测试 | 保留期限、重启、指标口径、缺失与断线、应用身份、独立读取、异步响应竞态、后台页暂停查询和关闭清理 | 通过；资源监控 80 项 Rust、类型检查和 80 项 Node/打包页面测试。 |
| 独立真实后端 RPC + 只读 CLI | 未打开页面时跨分钟积累、与真实快照逐值对照、重启后旧点和 7 天配置读回、通过桌面详情接口恢复 48 小时及不存在应用 | 通过；`real-history-final.log`。最终一轮 20 次排行请求最高约 23.60 ms，仅代表本机这轮检查。 |
| 打包浏览器 | 三指标、键盘图表、设置保存和重开、跨应用隔离、空状态、错误恢复、六种尺寸/主题组合和 CSP | 通过；`resource-tests-final.log`、`resource-browser-final.log`。独立无头浏览器截图为 `history-light-1024.png`、`history-dark-380.png`，均为公开模拟数据。 |
| 全仓检查 | 全仓测试、构建、机器管理布局与补丁检查 | 通过；`repo-build.log`、`repo-tests-after-build.log`、`layout.log`。初次全仓测试因新 worktree 缺机器管理原生构建失败，完整构建后已重跑通过；全仓构建的 12 个资源监控文件与安装包完全一致。 |
| 正常安装版 | 原目录后台重载、包和进程核对、真实记录持续增长 | 通过；已从 0.4.0 更新到 0.5.0，12 个包文件与构建逐一相符，宿主 PID 不变，新后端为宿主子进程，其他插件登记和排行偏好未变。约 86 秒内记录由 401 增至 1245 条；已读到三指标，数据库权限 0600。证据为 `installed-readback.json`、`installed-verify.json`、`installed-live-proof.json`。 |
| 原生输入 | 普通安装版实际鼠标、Tab/Shift+Tab/Esc、中文输入法、系统焦点和多屏 | 待验；用户要求后台推进，本轮不使用系统键鼠。浏览器事件不能证明这些项目。 |
| 管理员控制授权 | 新采集程序与原有进程控制策略比对 | 只读系统采集已连接，历史记录正常；更新二进制后，第三方 root 进程结束及后台服务控制策略需重新确认。未发起管理员弹窗，控制操作未验。见 `privileged-readback.json`。 |

旧版只在页面内积累的五分钟点从未落盘，无法恢复；新记录自 0.5.0 后端启用起生成。FlowHub 退出或插件停用后不继续采集，休眠期间不补造数据。本次不修改管理员授权或其他插件。
