# pnpm 迁移验收

2026-11-06：在最新 main 的独立工作树整理本地主检出中的迁移草稿，保留 Docker 0.4.0、2FA 0.5.0 的功能、依赖与许可。没有纳入资源监控会话未提交的业务代码。

- [x] 根目录及 common、Docker、机器管理、社交聚合、2FA 固定 pnpm 10.15.1；开发／构建／测试命令与 CI 的计划、发布入口同步。无 JS 依赖的外设中心保留原 npm 锁文件和兼容入口。
- [x] 从最新 npm 锁文件导入对应 pnpm 锁文件，包含 jsQR 1.4.0、qrcode 1.5.4；保留 2FA 构建时复制 jsQR 许可的步骤。配置文件不含仓库凭据。
- [x] 在新工作树内从空 node_modules 安装，各目录 `pnpm install --frozen-lockfile` 通过；复用的是已有 Rust 编译缓存，没有使用主检出的 node_modules。
- [x] 插件仓库 `pnpm run build`、`pnpm test`、`pnpm run layout:machines -- --check` 完整通过；包内资源、类型、行为、机器下拉指纹和全部布局断点通过。
- [x] 只提交包管理器、锁文件、构建／CI 命令及文档；构建输出、缓存链接、资源监控业务改动不纳入提交。原主检出保持不变。
- [ ] 推送后的 GitHub Actions 冷环境构建／测试仍需通过；本次没有发布标签或正式发布。

原始日志在仓库外 `/tmp/flowhub-pnpm-{typecheck,build,test,layout}-20261106.log`。本批不改插件版本，不替换安装版。
