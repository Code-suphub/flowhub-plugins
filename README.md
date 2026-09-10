# FlowHub Plugins

FlowHub 官方插件集中在本仓库维护。每个插件保留独立的清单、版本、依赖、构建命令和安装包；宿主在 [flowhub](https://github.com/Code-suphub/flowhub) 仓库维护。

## 插件目录

| 插件 | ID | 目录 | 文档 |
| --- | --- | --- | --- |
| 机器管理 | `machines` | `plugins/machines` | [开发和安装说明](plugins/machines/README.md) |

```text
flowhub-plugins/
  plugins/
    machines/
      flowhub-plugin.json
      backend/
      ui/
      bin/                  # 本地构建产物，不提交
```

## 开发机器插件

在仓库根目录运行：

```sh
npm run install:machines
npm run dev:machines
npm run test:machines
npm run build:machines
```

也可以进入 `plugins/machines` 使用原来的 `npm run dev`、`npm test`、`npm run build`。每个插件独立维护依赖锁文件。根目录的 `build`、`test` 当前转发至机器插件。

FlowHub 从本地目录安装时，选择 **`plugins/machines`**，不是仓库根目录。发布机器插件时只打包该目录的 `flowhub-plugin.json`、`ui/` 和 `bin/`。

## 添加新插件

在 `plugins/<插件名>/` 下创建独立插件，使用唯一的插件 ID，并在上表登记。插件版本由各自的 `flowhub-plugin.json` 管理，无需与宿主或其他插件一起升级。发布标签使用各插件前缀，例如 `machines-v0.2.1`。已配置按变更验证、按标签发布的工作流，详见 [自动发布说明](docs/releases.md)。当前构建约定为每个插件提供 npm build/test 和 Rust backend，其他技术栈需扩展工作流。

## 从旧仓库迁移

本仓库由 `Code-suphub/flowhub-machines-plugin` 重命名而来，保留完整 Git 历史。已有克隆可更新远程后拉取：

```sh
git remote set-url origin https://github.com/Code-suphub/flowhub-plugins.git
git pull --ff-only
```

迁移后需要在 FlowHub 中重新选择 `plugins/machines` 安装。插件 ID 仍为 `machines`，原运行数据目录不变，机器配置、加密凭据、备份和历史无需搬进源码仓库。
