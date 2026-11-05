# 插件自动构建与发布

`Plugin CI and Release` 工作流在 main 推送、PR 和 `<插件 ID>-v<版本>` 标签推送时运行。

- 普通改动：按 `plugins/<id>/` 选择受影响插件；`plugins/common/`、公共脚本或工作流改动验证并构建全部插件。构建目录中的 UI 会内联公共包，只测试和构建，不发布安装包。
- 标签：只构建该插件，要求清单、npm 包及 Cargo 版本一致。目前仅构建 Apple Silicon，Intel 暂停；所配置架构全部成功后发布完整 Release。
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

每个架构生成 `.fhplugin`（schema 2 JSON，内含清单、UI 和可执行文件的 Base64）、`.minisig` 和 `.sha256`。所配置架构完成后重新验签，再生成 `catalog.json` 和 `release-key.pub`。恢复 Intel 时，在 `scripts/release.mjs` 的 `releaseTargets` 中添加 `{runner:'macos-15-intel',target:'macos-x86_64'}` 并更新对应测试；构建矩阵和完整性校验共用此配置。旧版 Intel 产物保留。

私钥从 Actions Secret `PLUGIN_SIGNING_KEY` 读取，只在签名步骤写入临时文件，用完删除。仓库仅保存 `release-key.pub` 公钥。不要随发布更换密钥；更换前需安排来源公钥迁移。

FlowHub 来源地址使用具体插件 Release 的 `catalog.json`，不能使用全仓库的 `releases/latest`。索引包含该次发布所配置架构的完整清单，尚未提供自动合并所有插件最新版的统一索引。

当前仓库公开，FlowHub 可直接使用 Release 的 HTTPS 索引。如果以后改为私有仓库，FlowHub 目前的 HTTPS 来源不支持 GitHub 私有仓库鉴权；届时需另行提供可访问的签名产物来源。

## 本机构建并手动发布

Actions 不可用时，可以在对应架构的 Mac 上完成相同的测试、打包和签名，再上传 Release；无需更换已有签名密钥。以下以外设中心为例：

```sh
npm --prefix plugins/device-center test
npm --prefix plugins/device-center run build
export PLUGIN_SIGNING_KEY_FILE=/path/to/existing-plugin-signing.key
export GITHUB_REPOSITORY=Code-suphub/flowhub-plugins
export GITHUB_REF_NAME=device-center-v0.2.7
node scripts/release.mjs bundle device-center macos-aarch64
node scripts/release.mjs catalog
```

按前述规则提交版本和推送新标签。手动发布的提交可加 `[skip ci]`，避免同时触发 Actions；本地测试和验签仍须通过。不要覆盖既有公开版本。

```sh
gh release create "$GITHUB_REF_NAME" --verify-tag --draft --latest=false \
  --title "$GITHUB_REF_NAME" --notes-file /path/to/release-notes.md release-output/*
# 核对草稿中的完整产物、校验值和签名后公开。
gh release edit "$GITHUB_REF_NAME" --draft=false --latest=false
```

外设中心 0.2.7 的来源索引为 `https://github.com/Code-suphub/flowhub-plugins/releases/download/device-center-v0.2.7/catalog.json`，来源公钥使用仓库的 `release-key.pub`。索引指向具体版本，后续发布需更新来源地址；目前没有插件自动升级机制。
