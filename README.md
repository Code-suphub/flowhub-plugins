# FlowHub 机器管理插件

独立 Git 仓库：[Code-suphub/flowhub-machines-plugin](https://github.com/Code-suphub/flowhub-machines-plugin)。页面、SSH、堡垒机、监控、执行记录均在这里开发，不依赖 FlowHub 的 Rust 源码。宿主只提供插件进程生命周期、静态资源加载和 JSON-line 通信。

## 开发

```sh
npm install
npm run dev
```

访问 http://127.0.0.1:5183/machines.html。预览使用模拟数据，不读取 SSH 配置、不连接机器；刷新恢复模拟初始状态。

## 构建和加载

```sh
npm run build
npm test
```

在支持 schema 2 的 FlowHub 中打开插件市场，选择本仓库目录安装。安装的是目录引用，不复制开发源码。

- 修改 ui 中页面：在插件市场重新加载，然后进入机器管理。
- 修改 backend：先运行 npm run build，再重新加载。
- 普通插件升级不需要编译 FlowHub；只有改变宿主通信协议才需要宿主更新。
- 重新加载会重启插件进程，进行中的命令连接会中断；tmux 堡垒机会话独立存在。
- 发布包包含 flowhub-plugin.json、ui/、bin/；Rust 可执行文件需要按目标系统和架构构建。构建产物不随源码提交，克隆后先运行 npm run build。

## Agent 调用与查询权限

支持复制机器配置、按机器启用仅查询限制，以及本地 CLI。用 `./bin/flowhub-machines --cli --help` 查看入口，详见 [Agent CLI 文档](docs/agent-cli.md)。

## 数据与迁移

宿主通过 FLOWHUB_PLUGIN_DATA 传入独立数据目录。插件 ID 仍为 machines，继续使用原 FlowHub 数据根目录下的 machines/state.json 和 machines/commands.sqlite3。现有 SSH 文件、私钥引用、堡垒机配置及执行记录无需搬迁。不要将真实配置或数据库加入仓库。

旧的声明式包信息仅用于读取旧配置及默认模板，legacy-package.json 不是安装入口。安装入口是 flowhub-plugin.json。

连接参数保存于插件数据目录的 connections/，不再写入 ~/.ssh/config。启动时将原 FlowHub 管理的 ~/.ssh/flowhub.d 配置复制到插件目录；原文件保留供其他 SSH 工具使用。未导入的用户 SSH 别名继续由系统解析，私钥仅引用路径，不复制私钥。

普通 SSH 可选择密码认证，保存后用于命令、采集、测试连接和系统终端。密码使用 AES-256-GCM 加密存入插件 credentials.sqlite3，绑定别名、地址、用户名和端口；不会返回页面或写入 JSON、命令行参数、环境变量及执行记录。编辑时留空保留密码，改变地址或用户名需要重新输入。随机密钥单独保存在插件数据目录 credentials.key，权限为 600。插件可自动解密；备份和迁移需同时保留数据库与密钥，丢失密钥无法恢复密码。拥有数据库和密钥文件的人也能解密，因此这不防范当前用户权限被攻破。密码修改后先保存再测试；仅支持直接 SSH password 认证，交互验证码及跳板机密码请使用堡垒机会话。首次主机指纹仍需在系统 SSH 中确认，后台任务不自动信任未知主机。

后台监控在插件进程运行时工作；插件停用、卸载或 FlowHub 退出后进程停止。启动插件后按原有监控设置运行；本次迁移验证仅使用临时模拟配置，没有连接真实机器。独立进程拥有当前用户本地权限，不是操作系统沙箱。

## 备份、导出与恢复

页面右上角「备份与恢复」支持手动创建本地备份、导出到所选目录、选择备份恢复。先停止后台监控并等待任务结束。备份包含机器与连接配置、命令历史、密码数据库和对应密钥；私钥、relay 脚本和用户 `.ssh` 配置只保留原路径引用，跨电脑时需另行准备。

整个 `.fhbackup` 包使用独立备份口令保护（至少 12 字符，PBKDF2-HMAC-SHA256 600,000 次 + AES-256-GCM）。恢复时无需原电脑密钥，只需备份文件和备份口令。忘记备份口令无法解密。本地备份位于插件数据目录旁的 `machines.backups/`；不会自动删除旧备份，当前为手动备份，没有定时任务。

恢复先校验文件格式、机器配置和密码解密，再展示摘要供确认。确认后将恢复数据暂存，插件市场重新加载时才替换，后台监控保持关闭。原数据完整保留在旁边的 `machines.before-restore-*` 目录中。切换过程有恢复标记，重启可继续未完成的切换。单次数据上限 128 MiB，超限明确报错，不静默遗漏记录。

## 通信协议

stdin/stdout 每行一条 JSON：

```json
{"id":1,"method":"health","params":{}}
{"id":1,"result":{"protocol":1,"name":"flowhub-machines","version":"0.2.0"}}
```

多个请求可并发，通过 id 配对。错误响应使用 error 字段。stdout 只输出协议，诊断写 stderr。页面只通过 plugin-bridge.js 请求当前插件进程，不能直接调用宿主 Tauri 命令。
