# 插件自动构建与发布

`Plugin CI and Release` 工作流在 main 推送、PR 和 `<插件 ID>-v<版本>` 标签推送时运行。

- 普通改动：按 `plugins/<id>/` 选择受影响插件；公共脚本或工作流改动验证全部插件。只测试和构建，不发布安装包。
- 标签：只构建该插件，要求清单、npm 包及 Cargo 版本一致。Apple Silicon 和 Intel 分别原生构建并测试，全部成功后发布完整 Release。
- 不缓存 Rust target；临时上传产物保留 3 天。正式 Release 独立按插件版本保留，不标记为仓库级 latest。

## 发布步骤

先更新插件的 `flowhub-plugin.json`、`package.json`、`package-lock.json`、`backend/Cargo.toml` 和 `backend/Cargo.lock` 版本，提交并推送，再执行：

```sh
git tag machines-v0.2.1
git push origin machines-v0.2.1
gh run list --workflow plugins.yml
```

第一次发布沿用现有未发布版本 `machines-v0.2.0`。标签版本不匹配时在构建前失败。禁止覆盖已发布标签；发布任务失败留下的 draft 可删除后重跑，已公开版本请发新标签。

## 产物与签名

每个架构生成 `.fhplugin`（schema 2 JSON，内含清单、UI 和可执行文件的 Base64）、`.minisig` 和 `.sha256`。两个架构完成后重新验签，再生成 `catalog.json` 和 `release-key.pub`。

私钥从 Actions Secret `PLUGIN_SIGNING_KEY` 读取，只在签名步骤写入临时文件，用完删除。仓库仅保存 `release-key.pub` 公钥。不要随发布更换密钥；更换前需安排来源公钥迁移。

FlowHub 来源地址使用具体插件 Release 的 `catalog.json`，不能使用全仓库的 `releases/latest`。当前索引为每次发布版本的完整双架构清单，尚未提供自动合并所有插件最新版的统一索引。

本仓库是私有仓库：Actions 和 Releases 可以正常使用，但 FlowHub 目前的 HTTPS 来源不支持 GitHub 私有仓库鉴权。可以用 `gh release download` 下载包，或另行将签名产物托管至可访问的 HTTPS 来源；工作流不会自动改变仓库可见性。
