# 插件 CLI 验收流程

## 选择入口

| 入口 | 用途 | 覆盖边界 |
| --- | --- | --- |
| 插件 test／build／资源检查 | 业务逻辑、前端、协议、独立包与 CSP | 不证明安装或系统焦点 |
| 构建产物的浏览器验收 | 搜索、布局、弹窗、主题和失败状态 | 夹具数据不能冒充真实设备 |
| 宿主可选的 WKWebView 测试 CLI | 隔离测试构建中的页面控件、桥接与真实后端 | `synthetic-dom` 不证明普通安装版或系统输入 |
| 桌面 CLI／Computer Use | 正常安装版窗口、AX、截图和原生操作 | 全局输入使用桌面，需核对实际结果 |

先查看目标插件的 `package.json` 与 README，执行本次改动需要的测试和构建。以外设中心为例，在插件仓库根执行：

```sh
pnpm --dir plugins/device-center test
pnpm --dir plugins/device-center build
node scripts/check-plugins.mjs
```

浏览器验收使用已构建产物，并把输出放到 Git 外的新目录：

```text
pnpm --dir plugins/device-center exec node scripts/browser-acceptance.mjs <evidence-directory>
```

## 隔离宿主

在所选宿主 checkout 中检查是否存在 `app/scripts/dev/flowhub-ui-test.mjs`。存在时先阅读配套的 `docs/architecture/testing/ui-test-cli.md` 并执行 `node app/scripts/dev/flowhub-ui-test.mjs help`；不要把另一分支有此能力解释为当前分支已有。

测试目录、会话文件和插件包显式指定，使用可丢弃的夹具，不指向正式 FlowHub 数据目录。操作页面真实控件，等待准确结果并核对后端状态，不用直接调用业务函数冒充“按钮通过”。测试事件为 `synthetic-dom`／`isTrusted=false`；原生目录框、硬件键盘、IME、系统焦点和多屏另验。收尾只停止本次测试实例。

旧宿主 `flowhub-cli.mjs` 的 HTTP 配置能力面向旧目录服务，默认端口 4173，不提供正式插件安装或原生按钮控制。其诊断／监控子命令可能写入文件，先读帮助和实现，不能一律当成只读。

## 正常安装版

环境已有 toolkit 时，先发现后端、阅读实时指南，再读窗口：

```sh
toolkit desktop backends
toolkit desktop guide --backend huashu
toolkit desktop huashu mac -- windows FlowHub
toolkit desktop huashu mac -- idle
```

没有适用后端时使用已有 Computer Use，不自动安装全局工具。Huashu 操作模板如下；尖括号必须替换为本轮读取的目标和 Git 外证据路径：

```text
toolkit desktop huashu mac -- see <window-id> --out <evidence.png>
toolkit desktop huashu mac -- op <window-id> <x> <y> "" --dry
toolkit desktop huashu mac -- op <window-id> <x> <y> "" shot <after.png>
```

先检查控件身份、坐标系、遮挡与用户在场状态，再执行已授权操作；不要按可能包含父窗口的组合截图盲目换算坐标。操作后读取选中页、结果、弹窗和字段；保存／安装还要核对持久化与进程等副作用。命令成功不等于业务成功，命令超时也不等于未生效；先读回，不盲目重放。

原生目录选择器可能无法可靠读取或接收自动输入。此时请求用户完成明确的一步，保留已有替换授权，后续步骤继续完成；不要绕过注册流程、盲点默认按钮或重启整个应用来试错。锁屏、切换窗口和其他会话操作会影响原生验收，受干扰的一轮不能记为通过。

## 替换与留档

1. 备份目标旧包及相关注册信息，确认只替换本项插件，保留数据与启停状态。
2. 在正常插件市场选择目标构建包，读取实际更新内容后完成已有授权范围内的更新。
3. 核对 `plugins.json` 中目标版本／目录、最终包指纹、新插件进程可执行路径及宿主父进程；核对其他插件的注册信息未被本次更新改变。仅看到新版源码或预览不能宣布已安装。
4. 在普通安装版检查真实数据、主要页面、筛选与刷新、详情及相关跳转；键盘核对 Tab／Shift+Tab／Esc 和关闭后原卡片焦点。桌面组件、配置保存、主题、IME、热插拔按实际条件逐项留档。
5. 每次改动或重新构建后重测受影响项目，写明提交、版本、环境、驱动方式、通过／失败／受干扰／待验、证据位置。截图、会话文件、用户数据与日志留在 Git 外，不覆盖用户剪贴板或其他临时状态。

外设中心的具体实测和 WebKit 差异见[正式安装版验收记录](../plugins/device-center/docs/installed-acceptance-2026-11-07.md)。其中版本、PID、截图和待验状态属于该次记录，不作为后续操作的固定参数。
