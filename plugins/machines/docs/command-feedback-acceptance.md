# 命令反馈可见性验收

目标为机器管理 `0.4.1`。在 `0.4.0` 的 800×560 隔离 WKWebView 中，命令成功后，完成提示及共享终端输出落在可视区域下方；需要主动滚动才能确认结果。

本次将共享会话的运行／完成状态和错误放在命令栏上方，复用公共按钮提供“查看输出”；完成状态先显示成功／失败计数，再显示目标，长别名不会把关键结果挤到尾部。终端展示去除 tmux 捕获末尾的填充空白，避免自动跟随停在空屏；原始会话与执行记录保持原内容。用户点击按钮才滚动到最新输出并聚焦终端，后台轮询不滚动整个页面，也不修改连接、执行及凭证处理。

## 验证步骤

- [x] 在隔离真实后端和自建回环 SSH 上，连接后执行公开标记命令；800×560 完成提示在原视口可见，点击输出入口后实际终端标记与退出码 0 可见，结果与后端一致。运行中状态的进一步宽窄覆盖继续按下列步骤核对。
- [x] 隔离 WKWebView 的输出入口显示最终标记与退出码；Chromium 点击后焦点为终端，切换机器再返回保留原命令草稿。这里不把 DOM／CDP 结果记为硬件键盘通过。
- [x] 390×560 的深浅主题分别实际执行模拟命令，47 字符别名下完成计数与输出入口可见；独立深色执行中的全局提交状态可见。390／800／1200 无横向溢出，800×560 真实回环 WKWebView 的最终标记及退出码可见。原有全套布局继续覆盖 380／600／850／1024／1400。
- [x] Chromium 点击输出入口后，等待两次会话轮询，页面及终端滚动位置均保持；模拟认证失败显示未成功计数与错误，恢复后重试成功。切去另一目标时保留的旧完成提示明确标出原目标。
- [x] 类型检查、完整插件测试、机器布局检查和自包含构建通过，包清单、前后端版本均为 `0.4.1`。
- [x] 正式安装版经正常市场重新加载 `0.4.1`，注册仍为原目录且保持启用；27 文件 SHA256／权限与最终构建一致，新后端由原宿主启动，其他五条注册逐项不变。真实页面显示 `0.4.1`，列表与任务导航通过；未执行用户机器命令。
- [ ] 普通安装版用专用测试目标复验同一命令可见性、真实 Tab／输入法、系统焦点及更多窗口尺寸；隔离 `synthetic-dom` 不替代此项。

原始截图、RPC 轨迹和日志保存在 Git 外 `/Users/bilibili/.local/state/flowhub-full-flow-qa-20261107/`。修复前证据为 `terra/machines-command-complete-wk.png`；各项须按实际构建、驱动与结果更新，不继承旧包结论。

最终补修的隔离证据为 `terra/machines-final-before-cta.png`、`terra/machines-final-after-cta.png` 及 `terra/ui-machines/ui-test-rpc.jsonl`。事件为 `synthetic-dom`，不证明普通安装版、硬件键盘或系统焦点。最后一轮完整测试、独立布局和全量构建日志分别为 `plugins-feedback-final-tests.log`、`plugins-feedback-final-layout.log`、`plugins-feedback-final-build.log`；中间版本的截图不代表最终输出修复通过。

窄窗续修将反馈放到折行命令栏之前，并优先显示计数。该改动之后再次完成自包含构建、完整机器测试（含布局和指纹）及仓库契约检查，日志为 `machines-feedback-narrow-build.log`、`machines-feedback-narrow-tests.log`。最终截图与几何为 `terra/machines-execution-390.png`、`terra/machines-running-dark.png`、`terra/machines-execution-390-dark.png`、`terra/machine-layout.json`；真实回环最终图为 `terra/machines-last-output-polled.png`。完成后手动调整 DOM 的原型截图不能代替这些源码重建结果。

安装使用原登记目录 `/Users/bilibili/.codex/worktrees/machines-redesign/flowhub-plugins/plugins/machines/build`；维护源码位于本次 `codex/full-flow-qa-20261107` 的 `307c869`，旧工作树源码未改。备份和逐文件证明在上述私有证据根目录的 `machines-install-041/`，最终指纹为 `86cdd6da8e474896bf2a024ebb7e25d75d84ba95c229ae8b5242932a705b5422`（相对路径对应 SHA256 与权限的 JSON 哈希）。原目录的旧源码再次构建会覆盖本次包，后续合并或迁移安装来源时应核对源码提交。

重载后，原有监控按保存的配置自动产生采集队列；未为验收清空、暂停或触发用户机器任务。此安装版冒烟不替代前述独立回环场景的普通安装版命令验收。
