# 外设中心 · Device Center

独立的 FlowHub macOS schema 2 原生设备插件，按最初的 1536 × 1024 视觉原型重建页面和组件。v0.2.4 在紧凑供电显示基础上，区分显示器像素分辨率、界面逻辑尺寸与内置／外接类型。

## 视觉预览

入口 `plugins/device-center/ui/index.html`，支持概览、蓝牙、USB、显示器、供电、历史事件与设备详情。卡片位于 `widget-card.html`，另有 `widget-editor.html` 和 `widget-detail.html`。在 FlowHub 宿主中，使用真实设备数据；单独浏览器预览使用明确标注的模拟数据，避免误认为实际连接状态。

在 `plugins/device-center/` 执行：

```sh
npm ci
npm run dev
# 浏览器打开 http://127.0.0.1:5188/index.html
```

按指定视图访问 `?view=bluetooth`、`?view=usb`、`?view=display`、`?view=power`、`?view=events`。`?embedded=1` 用于观察宿主嵌入时的布局，且预览不会运行设备操作。

### 真实浏览器截图验收

本仓库提供可选的 Playwright 浏览器截图工具，不是生成式效果图：

```sh
python3 -m pip install playwright Pillow
python3 -m playwright install chromium
python3 scripts/capture.py --url http://127.0.0.1:5188 --out screenshots --strict
```

将生成概览（1168/800/520 宽）、五个分类页面、组件卡片、设备详情截图和 `report.json`，浏览器控制台/资源错误在 `--strict` 模式下导致失败。

**本机不允许浏览器请求 localhost 时**可以使用 `--inline` 作为视觉检查的兜底：它将同样的 HTML、CSS、JS 和图片内联进浏览器供渲染，但不能证明最终资源路径、网络或宿主 CSP 行为，因此仍须在 FlowHub 中验收。

原型还原检查见 `docs/visual-acceptance.md`。截图不能由 `npm test` 的编译通过替代。

## 图片策略

当前 9 张小型 PNG 来源于用户确认的最初 AI 原型图裁剪，用作已知演示型号的**原型视觉素材**，非官方授权商品摄影；真实运行时只有确认的名称才命中素材，其余使用包内类别 SVG。原生资源加载由 FlowHub 宿主白名单控制：**`png` / `svg`**，所以不要求主程序放开 WebP MIME 类型或网络图片 CSP。

## 设备数据与安全边界

- Rust 每 45 秒只读运行系统 `system_profiler -json`，解析蓝牙连接列表、USB 拓扑、显示器和电源状态。
- 蓝牙设备缺少电量时，额外只读运行 `pmset -g accps`（3 秒超时、64 KiB 上限），按唯一且完全匹配的设备名补充 macOS 配件电量。它不添加设备，不覆盖系统报告已有电量；查询不可用或同名设备无法区分时仍显示未知，不需要管理员权限。
- 桌面组件展示当前连接设备，按配置显示最多 3/5/8 个；超过上限时标出显示数量。扫描失败或过期时明确标为上次采集结果，不把缓存冒充实时连接状态。
- 不回传蓝牙地址、序列号或手机调试唯一标识；连接事件只保存在进程内存。
- 显示器卡片优先显示系统报告的像素分辨率及刷新率，界面逻辑尺寸单独放在详情中；缺少像素数据时只标为显示模式。内置／外接类型优先读系统报告，缺失时通过在线显示器 ID 查询 CoreGraphics，仍无法确认则显示类型未知。
- 功率采样间隔在组件编辑器配置，支持 5/10/30/60 秒，默认 5 秒；控制可见页面的刷新与后端缓存，编辑器不轮询，多个页面共享较新的采样。主插件页面默认 5 秒，设备目录扫描仍为 45 秒。小窗不显示采样间隔。
- 采样只读调用 `ioreg -a -r -c AppleSmartBattery`（3 秒超时、2 MiB 上限）。输入功率读取 `PowerTelemetryData.SystemPowerIn`（mW），整机功耗读取 `SystemLoad`（mW）；缺失时仅接受 `BatteryData.AdapterPower/SystemPower` 的真实浮点 W 值，不猜测旧整数编码的单位。
- 电池侧功率由电池电压（mV）×有符号电流（mA）/1,000,000 估算，正值为充电、负值为放电、0 为电池待机。拔掉电源后不沿用缓存中的外接输入值。系统传感器本身可能延迟，不能视为外置功率计测量。
- 适配器规格、输入功率、整机功耗与电池功率分别显示；不同字段可能不是同一时刻采样。未知数值显示未提供，查询失败会清除功率值并显示错误。无电池或缺少遥测的机型不保证可读。
- ADB 授权状态、iPhone 信任状态、USB PD 线缆能力以及各外设独立耗电功率尚未实现；整机功耗不代表独立供电的外接显示器耗电量。

## 构建与安装

macOS + Node.js 22+ + Rust stable：

```sh
npm ci
npm test
npm run build
```

FlowHub 的「插件市场 → 安装开发目录」选择 `plugins/device-center/build/`，不要选择源码目录。运行前先检查本地安装来源是否更新到了新的开发分支。保持 Draft PR，待真实 FlowHub 页面视觉与数据双重验收后再合并。
