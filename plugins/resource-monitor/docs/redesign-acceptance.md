# 资源监控界面改造验收

基线为插件仓库 `6c26410`，工作树分支为 `codex/resource-monitor-redesign`。安装版和实机结果与以下隔离预览分开记录。

| 项目 | 通过的检查 | 实机待验 |
| --- | --- | --- |
| 排行 | 类型检查及 16 项摘要、详情与系统记账回归通过。macOS Chromium 1024 浅色和 380 深色模拟数据验证六列、默认 CPU 排序、进程数鼠标与键盘排序、横向滚动固定应用列、按 PID 查找及打开详情。 | 正式安装版 WebKit 的窄窗口、键盘排序和返回后的焦点。 |
| 详情 | macOS Chromium 1024 浅色、380 深色验证已有采样生成趋势、三个页签外框尺寸固定、应用内自启动和服务入口。打包浏览器通过 CSP、已确认的批量范围、受保护实例排除、取消、服务操作及自启动兼容检查。模型回归覆盖同一时段去重、五分钟上限和缺失采样。 | 正式安装版真实采样、原生键盘焦点和同一应用的服务及实例预览。 |
| 桌面卡片 | macOS Chromium 380 × 280 浅色和 260 × 220 深色验证完整列表滚动、CPU 默认显示、指标切换、活跃足迹排序、前三与完整列表、Esc 和焦点返回。打包浏览器在严格 CSP 下覆盖 28 条、宿主编辑器导航、保存回调、旧配置及只读边界。卡片独立包为 289367 字节，gzip 为 94712 字节，符合原体积预算。 | 正式安装版画布中打开显示设置，保存默认排序、指标和显示范围，重开后回读；验证点击应用和返回画布后的焦点。 |

详情趋势使用宿主页面收到的最近五分钟有效排行采样，页面重新加载后重新积累。桌面卡片的即时设置用于当前卡片页面；通过「编辑默认设置」进入宿主组件编辑器并保存，可持久化到该卡片。

资源监控 0.4.0：`npm run test:resource-monitor` 通过 71 项 Rust 测试、类型检查及 76 项 Node 和打包浏览器测试；`npm run build:resource-monitor` 与包内资源、CSP 检查通过。构建目录为 `plugins/resource-monitor/build/`，尚未替换安装版。

插件仓库的 `npm run build`、构建后的 `npm test`、`npm run layout:machines -- --check` 和 `git diff --check` 均通过。全仓日志为 `repo-build-serial.log` 和 `repo-tests-after-build.log`。独立构建和全仓构建得到的资源监控后端、排行和桌面卡片入口指纹一致。

浏览器截图和构建日志保存在 Git 外的 `~/.local/state/flowhub-resource-monitor-redesign/`。排行、详情和卡片截图分别以 `ranking-`、`detail-` 和 `card-` 开头；专项测试和构建日志是 `resource-monitor-tests.log` 和 `resource-monitor-build.log`。使用测试数据，结束操作的验证使用隔离夹具。
