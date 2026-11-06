# pnpm 迁移验收

2026-11-06：在最新 main 的独立工作树整理本地主检出中的迁移草稿，保留 Docker 0.4.0、2FA 0.5.0 的功能、依赖与许可。没有纳入资源监控会话未提交的业务代码。

- [x] 根目录及 common、Docker、机器管理、社交聚合、2FA 固定 pnpm 10.15.1；开发／构建／测试命令与 CI 的计划、发布入口同步。无 JS 依赖的外设中心保留原 npm 锁文件和兼容入口。
- [x] 从最新 npm 锁文件导入对应 pnpm 锁文件，包含 jsQR 1.4.0、qrcode 1.5.4；保留 2FA 构建时复制 jsQR 许可的步骤。配置文件不含仓库凭据。
- [x] 在新工作树内从空 node_modules 安装，各目录 `pnpm install --frozen-lockfile` 通过；复用的是已有 Rust 编译缓存，没有使用主检出的 node_modules。
- [x] 插件仓库 `pnpm run build`、`pnpm test`、`pnpm run layout:machines -- --check` 完整通过；包内资源、类型、行为、机器下拉指纹和全部布局断点通过。
- [x] 只提交包管理器、锁文件、构建／CI 命令及文档；构建输出、缓存链接、资源监控业务改动不纳入提交。原主检出保持不变。
- [x] 首次远端计划任务的 19 项脚本检查与插件校验通过；setup-node 根据新 packageManager 字段自动保存缓存时因任务未安装依赖、缓存目录不存在而失败。计划／发布任务已关闭该自动缓存，构建任务仍显式使用锁文件缓存。
- [x] CI 修正后，GitHub Actions 的计划任务及六个插件的 macOS ARM64 冷环境构建／测试全部通过：[运行记录](https://github.com/Code-suphub/flowhub-plugins/actions/runs/42186098872)。本次没有发布标签或正式发布。
- [x] 文档提交触发的后续 CI 中，机器详情交互检查在固定 30 ms 等待后未及时观察到 React effect；该任务的 Rust、类型、54 项 Node 测试和布局检查均通过。改用最长 3 秒的条件等待，保留六项指标请求、目标切换及错误展示断言，不修改业务实现：[失败记录](https://github.com/Code-suphub/flowhub-plugins/actions/runs/42187071628)。
- [x] 条件等待修改后，本地重新构建并执行完整 `preview-fingerprint.mjs` 通过（3 页面 × 3 宽度、深浅主题及卡片尺寸／指标组合）；日志在 `/tmp/flowhub-pnpm-fingerprint-ci-fix-20261106.log`。最终提交的远端检查结果随 PR #6 留档。

原始日志在仓库外 `/tmp/flowhub-pnpm-{typecheck,build,test,layout}-20261106.log`。本批不改插件版本，不替换安装版。
