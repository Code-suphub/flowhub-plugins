# Netdata 节点监控

机器页面的「Netdata 监控」连接每台机器已有的 Agent 地址，如 `http://node:19999`，也支持反向代理的路径前缀。当前接入 Agent HTTP API，不接入 Netdata Cloud；地址必须能从运行 FlowHub 的电脑访问。需要认证的反向代理及自动 SSH 隧道尚未接入。

测试连接会发现指标，可选择 `system.net` 或具体 `net.*` 网卡。保存后，节点会出现在桌面组件目标列表中，每 30 秒刷新。CPU、内存、根文件系统使用率与收发网速来自 Agent；缺失指标显示空值。网速由 kbit/s 换算为 KB/s。历史曲线直接查询远端 Agent，可选 1 小时、1 天、7 天和 30 天。

接入地址和网卡选择保存在插件 `state.json` 的 `netdata` 字段，随现有加密备份迁移。历史数据留在 Agent，由远端 Netdata 管理，不包含在 FlowHub 的备份中。

安装入口先展示目标与完整命令，再提交安装任务；结果保存在命令执行记录中。仅支持普通 SSH、Linux、curl、root 或免密 sudo。只读机器不能安装。已有可检测的原生安装或名为 `netdata` 的容器会被保留。其他名称的容器应使用已有地址接入，避免重复安装。

新安装使用官方 kickstart 稳定版，关闭自动更新和遥测，不加入 Cloud。安装配置为每 5 秒采集、一个存储层、7/30/90 天和 512 MiB/1/2/4 GiB 目标容量，先达到的限制触发清理。容量是软目标，包含元数据的实际占用可能更高。仅本机监听为默认值；如需网络访问，应使用可信网络或受控代理。已有实例不自动改配置或迁移历史数据。

官方依据：
- https://learn.netdata.cloud/docs/netdata-agent/installation/linux
- https://learn.netdata.cloud/docs/netdata-agent/configuration/database
- https://learn.netdata.cloud/docs/developer-and-contributor-corner/rest-api

兼容既有 Agent 的 v1 allmetrics/data JSON 接口；后端 HTTP 合约测试覆盖指标单位转换、地址约束和历史查询。
