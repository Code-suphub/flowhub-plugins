# FlowHub Plugins

FlowHub 官方插件集中在本仓库维护。每个插件保留独立的清单、版本、依赖、构建命令和安装包；宿主在 [flowhub](https://github.com/Code-suphub/flowhub) 仓库维护。

## 插件目录

| 插件 | ID | 目录 | 文档 |
| --- | --- | --- | --- |
| 机器管理 | `machines` | `plugins/machines` | [说明](plugins/machines/README.md) |
| Docker 管理 | `docker` | `plugins/docker` | [说明](plugins/docker/README.md) |
| 社交聚合 | `social-hub` | `plugins/social-hub` | [说明](plugins/social-hub/README.md) |
| 2FA 验证码 | `twofa` | `plugins/twofa` | [说明](plugins/twofa/README.md) |

每个插件使用同一套目录布局：

```text
flowhub-plugins/
  plugins/
    <插件 ID>/
      flowhub-plugin.json     # 清单：ID、版本、入口页、可执行文件与权限
      backend/                # Rust 后端源码（独立 Cargo 工程）
      ui/                     # 插件页面
      scripts/build.mjs       # cargo build --release 后复制到 bin/
      dev/                    # 本地预览（可选）：vite.config.mjs 或独立静态服务
      tests/                  # 自动化测试与手工冒烟脚本
      docs/                   # 插件自身的说明（可选，简单插件只用 README.md）
      bin/                    # 本地构建产物，不提交
```

约定：`scripts/` 只放构建脚本，预览放 `dev/`，测试与冒烟放 `tests/`，其余说明优先写进 `README.md`。`node scripts/check-plugins.mjs` 会逐项校验下列要求，并拦下 schema 1 清单、`.codex-plugin/` 脚手架等历史残留：

- 清单 `schema` 为 2，`id` 与目录名一致，`version` 为 `x.y.z`，且与 `package.json`、`backend/Cargo.toml` 三处一致；
- `ui` 指向存在的 HTML 页面，`widget.card/editor/detail` 若声明也必须是存在的 HTML 页面；
- `executable` 是插件目录内的相对路径（禁止绝对路径与 `..`）；
- 存在 `README.md`、`package-lock.json`、`backend/Cargo.toml`，以及 `build`、`test` 两个 npm 脚本。

## 在仓库根目录开发

```sh
npm run install:machines      # 等价于 npm ci --prefix plugins/machines
npm run dev:machines          # 仅 machines、docker 提供 dev 预览
npm run build                 # 依次构建全部插件
npm run check                 # 校验插件目录约定
npm test                      # 先校验约定，再依次测试全部插件
```

`build`、`test` 由 `scripts/run-all.mjs` 遍历 `plugins/*/flowhub-plugin.json` 执行，并跳过没有对应脚本的插件；也可以进入单个插件目录直接运行 `npm run build`、`npm test`。每个插件独立维护依赖锁文件。CI 在 `plan` 阶段就会跑 `check-plugins`，缺文件或版本不一致不会拖到打标签发布时才暴露。

FlowHub 从本地目录安装时，选择 **`plugins/<插件 ID>`**，不是仓库根目录。发布插件时只打包该目录的 `flowhub-plugin.json`、`ui/` 和 `bin/`。

## 添加新插件

在 `plugins/<插件名>/` 下创建独立插件，使用唯一的插件 ID，并在上表登记。插件版本由各自的 `flowhub-plugin.json` 管理，无需与宿主或其他插件一起升级。发布标签使用各插件前缀，例如 `machines-v0.2.1`。已配置按变更验证、按标签发布的工作流，详见 [自动发布说明](docs/releases.md)。当前构建约定为每个插件提供 npm build/test 和 Rust backend，其他技术栈需扩展发布工作流。

## 从旧仓库迁移

本仓库由 `Code-suphub/flowhub-machines-plugin` 重命名而来，保留完整 Git 历史。已有克隆可更新远程后拉取：

```sh
git remote set-url origin https://github.com/Code-suphub/flowhub-plugins.git
git pull --ff-only
```

迁移后需要在 FlowHub 中重新选择 `plugins/machines` 安装。插件 ID 仍为 `machines`，原运行数据目录不变，机器配置、加密凭据、备份和历史无需搬进源码仓库。
