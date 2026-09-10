# Agent CLI

先在 FlowHub 中启用或重新加载机器插件。CLI 连接该进程的本地 Unix socket，复用机器配置、加密凭据、会话与执行记录，不独立启动监控或写数据库。不需要额外 MCP 服务。

在插件仓库目录执行：

```sh
./bin/flowhub-machines --cli list
./bin/flowhub-machines --cli status
./bin/flowhub-machines --cli collect <机器ID或别名>
./bin/flowhub-machines --cli query <机器ID或别名> 'uptime'
./bin/flowhub-machines --cli exec <机器ID或别名> 'ls -lah'
```

Agent 可直接使用可执行文件的绝对路径。默认数据目录为 `~/Library/Application Support/FlowHub/machines`，可用 `FLOWHUB_PLUGIN_DATA` 覆盖。CLI 输出单行 JSON，包含 `result` 或 `error`；任务失败时返回非零退出码。列表不包含密码、私钥路径或 relay 脚本路径。

查询命令仅允许 `uptime`、`hostname`、`uname -a`、`df -h /`、`free -m`。`exec` 在普通 SSH 的非受限机器上支持自由命令；查询限制在后端统一检查，不能通过 `exec` 绕过。堡垒机结构化调用仅支持上述固定查询和采集，须先在页面完成会话连接。忙碌或有系统终端附着时拒绝注入查询。

`cli.sock` 权限为 0600，仅面向本机当前账号；拥有该账号的程序可调用非受限机器的命令。此版本 CLI 不提供修改配置或降低权限的操作。现有 MCP 若需集成，可包装此 CLI，并保留退出码和 JSON 错误。

## 复制与查询权限

机器列表的“复制”打开新增草稿，继承连接参数、分组和查询权限，目标机器名留空，保存前不会创建机器。普通 SSH 密码不复制，私钥仅继承路径引用。

勾选“仅允许查询”后，插件关闭自由输入和系统终端，保留固定查询和采集。堡垒机登录脚本仍会运行；需要手动密码或验证码的环境，应先完成必要的登录脚本/账号配置，受限会话不提供任意文本输入。切换堡垒机权限前须先断开原会话。已打开的普通 SSH 终端不因切换配置而撤销权限。

这是插件操作约束，不是远端权限隔离。生产账号仍需由 SSH/堡垒机权限管理限制写入；插件无法限制用户绕过它直接使用 SSH、修改本地配置或替换远端程序。
