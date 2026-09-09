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

## 数据与迁移

宿主通过 FLOWHUB_PLUGIN_DATA 传入独立数据目录。插件 ID 仍为 machines，继续使用原 FlowHub 数据根目录下的 machines/state.json 和 machines/commands.sqlite3。现有 SSH 文件、私钥引用、堡垒机配置及执行记录无需搬迁。不要将真实配置或数据库加入仓库。

旧的声明式包信息仅用于读取旧配置及默认模板，legacy-package.json 不是安装入口。安装入口是 flowhub-plugin.json。

后台监控在插件进程运行时工作；插件停用、卸载或 FlowHub 退出后进程停止。启动插件后按原有监控设置运行；本次迁移验证仅使用临时模拟配置，没有连接真实机器。独立进程拥有当前用户本地权限，不是操作系统沙箱。

## 协议

stdin/stdout 每行一条 JSON：

```json
{"id":1,"method":"health","params":{}}
{"id":1,"result":{"protocol":1,"name":"flowhub-machines","version":"0.2.0"}}
```

多个请求可并发，通过 id 配对。错误响应使用 error 字段。stdout 只输出协议，诊断写 stderr。页面只通过 plugin-bridge.js 请求当前插件进程，不能直接调用宿主 Tauri 命令。
