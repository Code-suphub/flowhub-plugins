# FlowHub 机器管理插件

本插件位于 [Code-suphub/flowhub-plugins](https://github.com/Code-suphub/flowhub-plugins) 的 `plugins/machines/` 目录，独立构建和发布。页面、SSH、堡垒机、监控、执行记录均在这里开发，不依赖 FlowHub 的 Rust 源码。宿主只提供插件进程生命周期、静态资源加载和 JSON-line 通信。

## 开发

以下命令在 `plugins/machines` 目录执行。

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

在支持 schema 2 的 FlowHub 中打开插件市场，选择构建后的 `plugins/machines/build` 目录安装。开发预览仍使用 `npm run dev`，不会复制公共源码。

- 修改 ui 或 common 中页面：运行 `npm run build` 后，在插件市场重新加载构建目录。
- 修改 backend：先运行 npm run build，再重新加载。
- 普通插件升级不需要编译 FlowHub；只有改变宿主通信协议才需要宿主更新。
- 重新加载会重启插件进程，进行中的命令连接会中断；tmux 堡垒机会话独立存在。
- `build/` 包含自包含的 flowhub-plugin.json、ui/、bin/；Rust 可执行文件需要按目标系统和架构构建。构建产物不随源码提交，克隆后先运行 npm run build。

## Agent 调用与查询权限

支持复制机器配置、按机器启用仅查询限制，以及本地 CLI。用 `./bin/flowhub-machines --cli --help` 查看入口，详见 [Agent CLI 文档](docs/agent-cli.md)。

## 数据与迁移

宿主通过 FLOWHUB_PLUGIN_DATA 传入独立数据目录。插件 ID 仍为 machines，继续使用原 FlowHub 数据根目录下的 machines/state.json 和 machines/commands.sqlite3。现有 SSH 文件、私钥引用、堡垒机配置及执行记录无需搬迁。不要将真实配置或数据库加入仓库。

旧的声明式包信息仅用于读取旧配置及默认模板，backend/src/builtin-package.json 是后端的构建输入，不是安装入口。安装入口是 flowhub-plugin.json。

连接参数保存于插件数据目录的 connections/，不再写入 ~/.ssh/config。启动时将原 FlowHub 管理的 ~/.ssh/flowhub.d 配置复制到插件目录；原文件保留供其他 SSH 工具使用。未导入的用户 SSH 别名继续由系统解析，私钥仅引用路径，不复制私钥。

普通 SSH 可选择密码认证，保存后用于命令、采集、测试连接和系统终端。密码使用 AES-256-GCM 加密存入插件 credentials.sqlite3，绑定别名、地址、用户名和端口；不会返回页面或写入 JSON、命令行参数、环境变量及执行记录。编辑时留空保留密码，改变地址或用户名需要重新输入。随机密钥单独保存在插件数据目录 credentials.key，权限为 600。插件可自动解密；备份和迁移需同时保留数据库与密钥，丢失密钥无法恢复密码。拥有数据库和密钥文件的人也能解密，因此这不防范当前用户权限被攻破。密码修改后先保存再测试；仅支持直接 SSH password 认证，交互验证码及跳板机密码请使用堡垒机会话。首次主机指纹仍需在系统 SSH 中确认，后台任务不自动信任未知主机。

后台监控在插件进程运行时工作；插件停用、卸载或 FlowHub 退出后进程停止。启动插件后按原有监控设置运行；本次迁移验证仅使用临时模拟配置，没有连接真实机器。独立进程拥有当前用户本地权限，不是操作系统沙箱。

## 备份、导出与恢复

页面右上角「备份与恢复」支持手动创建本地备份、导出到所选目录、选择备份恢复。先停止后台监控并等待任务结束。备份包含机器与连接配置、命令历史、密码数据库和对应密钥；私钥、relay 脚本和用户 `.ssh` 配置只保留原路径引用，跨电脑时需另行准备。

「创建备份」页签需要输入并确认口令；「恢复备份」页签只需输入备份口令，选择文件后先展示校验摘要，再确认替换。修改口令、重新选择文件或关闭窗口会清除当前恢复确认。恢复准备完成后，重新加载机器插件才能继续操作。界面复用 `plugins/common` 的 React 组件，源码位于 `src/backup/`。

整个 `.fhbackup` 包使用独立备份口令保护（至少 12 字符，PBKDF2-HMAC-SHA256 600,000 次 + AES-256-GCM）。恢复时无需原电脑密钥，只需备份文件和备份口令。忘记备份口令无法解密。本地备份位于插件数据目录旁的 `machines.backups/`；不会自动删除旧备份，当前为手动备份，没有定时任务。

恢复先校验文件格式、机器配置和密码解密，再展示摘要供确认。确认后将恢复数据暂存，插件市场重新加载时才替换，后台监控保持关闭。原数据完整保留在旁边的 `machines.before-restore-*` 目录中。切换过程有恢复标记，重启可继续未完成的切换。单次数据上限 128 MiB，超限明确报错，不静默遗漏记录。

## 通信协议

stdin/stdout 每行一条 JSON：

```json
{"id":1,"method":"health","params":{}}
{"id":1,"result":{"protocol":1,"name":"flowhub-machines","version":"0.2.0"}}
```

多个请求可并发，通过 id 配对。错误响应使用 error 字段。stdout 只输出协议，诊断写 stderr。页面只通过 plugin-bridge.js 请求当前插件进程，不能直接调用宿主 Tauri 命令。

## 云流量

机器管理 → 云流量 → 选择机器与云服务商 → 保存配置 → 查询已保存配置。
凭证使用现有加密凭据库，按机器隔离；密钥不回显，留空保留。切换服务商需重新填写凭证。旧腾讯云配置原位兼容，原腾讯云 API 动作保留。
组件编辑可选择“剩余流量（云服务商）”。插件运行时每 5 分钟查询；超过 15 分钟的数据不显示为当前余额。需要机器的 `ssh:configure` 权限，实际查询独立于 SSH 连接。

| 云服务商 / 产品 | 当前支持 | 配置与只读权限 |
| --- | --- | --- |
| 腾讯云 Lighthouse | 单实例套餐余额 | SecretId/SecretKey、地域、lhins- ID；`lighthouse:DescribeInstancesTrafficPackages` |
| 搬瓦工 KiwiVM | 单实例套餐余额及重置日期 | 每实例 VEID/API Key；`getServiceInfo` |
| 阿里云轻量 | 本月单实例套餐余额 | AK/SK、地域、轻量实例 ID；`swas-open:ListInstancesTrafficPackages` |
| 华为云 Flexus L | 指定流量包余额 | AK/SK、中国/国际站、流量包 ID；资源包查询权限 |
| Linode / Akamai | 账户或指定地域共享池 | Token：`account:read_only`；可选地域 ID |
| Vultr | 本月至今账户共享池 | API Key 可读取 `/v2/account/bandwidth`，允许客户端 IP |
| AWS Lightsail | 本月 UTC 入站＋出站监控用量 | AK/SK、地域、实例名称；`lightsail:GetInstanceMetricData` |
| ZgoCloud (VirtFusion · API Token) | 当前周期套餐余量 | Bearer Token + 整数 serverId；`GET /api/v1/servers/{id}/traffic` |
| ZgoCloud (VirtFusion · Session Cookie) | 当前周期累计（限额手动） | 浏览器 Cookie + XSRF Token + 整数 serverId；`GET /server/{id}/resource/traffic.json` |
| 网卡计数器（本地 Netdata） | 自然月累计 rx/tx + 日均 + 剩余天数（限额手动） | 复用 FlowHub 已接入的 Netdata 节点；按北京时间自然月积分 `system.net` 速率；`GET netdata/api/v1/allmetrics` + `api/v1/data` |

- 套餐显示“295/300 GB”，共享池显示“共享 295/300 GB”，仅监控显示“已用 5 GB”。沿用组件的紧凑 GB 标签；详情按原 API 数值尺度区分 GB/GiB。
- Linode 地域独立池不能互相抵扣；账户汇总不代表单台机器专属余量。Vultr 使用已累计额度，不用月底预测额度。
- AWS 监控可能延迟或缺失，不作为账单或套餐余额；不计算虚构的剩余量。
- 华为云填写的是流量包 ID，不是服务器 ID。接口仅接受有效周期内、计量单位为 GB 的资源包。
- 搬瓦工通过固定 HTTPS POST 请求，密钥不在 URL 中。按 `monthly_data_multiplier` 同时换算总量和已用量；实际倍率需用真实账单核对。
- ZgoCloud 提供两种接入：API Token 走 Bearer（接口自带 limit/blocks），Session Cookie 走浏览器 session（接口只给累计，limitGB 由配置项手动填）。两路都把响应统一归一为 `rows[].TrafficPackageSet`，UI 同一套展示。Cookie 会过期，过期需重新从浏览器抓取；服务器重启或会话失效也会让 Cookie 失效。
- 网卡计数器走的是 FlowHub 已接入的 Netdata 节点（无需额外鉴权，HTTP 即可），按北京时间自然月对 rx/tx 速率积分，并以本月已过去时间计算日均和剩余天数。limitGB 必须手动填；Netdata 历史样本不足时不计算日均。
- 腾讯云、阿里云及 AWS 支持临时会话 Token；过期需更新，可显式清除。没有密钥时不生成演示余额。
- 本轮新增厂商尚未使用真实用户凭证联调。已做响应解析、签名向量、配置持久化及交互验证；配置后需与控制台核对一轮。
- 这不是所有云产品的账单查询：ECS/EIP、EC2、DigitalOcean 等不能复用上述轻量套餐接口。尚未提供它们的权威套餐余额适配，不能由 SSH 网卡计数推导。

### 官方接口参考

- [阿里云套餐查询](https://help.aliyun.com/zh/simple-application-server/developer-reference/api-swas-open-2020-06-01-listinstancestrafficpackages/)、[地域端点](https://help.aliyun.com/zh/simple-application-server/developer-reference/api-swas-open-2020-06-01-endpoint)、[ACS3 签名](https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature)
- [华为云 Flexus L 流量包](https://support.huaweicloud.com/intl/zh-cn/api-flexusl/query_traffic_0001.html)、[官方签名实现](https://github.com/huaweicloud/huaweicloud-sdk-go-v3/blob/master/core/auth/signer/signer.go)
- [Linode 账户用量](https://techdocs.akamai.com/linode-api/reference/get-transfer)
- [Vultr 账户流量](https://docs.vultr.com/reference/vultr-cli/account/bandwidth)、[官方返回模型](https://github.com/vultr/govultr/blob/master/account.go)
- [AWS Lightsail 指标](https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/API_GetInstanceMetricData.html)、[流量池口径](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-faq-data-transfer-allowance.html)
