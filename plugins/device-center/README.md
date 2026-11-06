# 外设中心 · Device Center

FlowHub macOS schema 2 原生设备插件。v0.3.2 使用 React 管理页：双栏设备卡片、按需详情弹窗、紧凑供电读数和连接事件，支持深浅主题与原有组件配置，并修复 WKWebView 中详情弹窗的 Tab 循环与关闭后的卡片焦点。

## 页面与只读预览

管理页入口 `ui/index.html`，组件详情入口 `ui/widget-detail.html`；两者使用同一 React 页面。桌面卡片和组件编辑器保持已有配置协议。

```sh
pnpm install --frozen-lockfile
pnpm dev
# http://127.0.0.1:5188/ui/index.html
```

独立浏览器仅显示明确标注的示例数据，不扫描或操作真实设备。支持 `?view=power` / `?view=bluetooth` / `?view=events`，以及 `?scenario=missing` / `stale` / `error` / `unplugged` / `empty` / `long`。嵌入宿主后只通过真实插件 RPC 读取数据，不允许查询参数切换成假数据。

```sh
pnpm test
pnpm build
node scripts/browser-acceptance.mjs /absolute/path/to/evidence
```

浏览器验收使用独立无头 Chrome，在不透明 sandbox iframe 中加载实际构建产物与宿主等价的 CSP，验证筛选、弹窗、焦点恢复、供电缺失/失败、深浅主题、窄屏与组件入口。设备数据使用夹具，系统图标通过构建包内 helper 获取。它不移动鼠标，不修改剪贴板、实际设备或安装版。

实机验收与分项提交记录见 [改造验收清单](docs/redesign-acceptance.md) 和 [正式安装版验收](docs/installed-acceptance-2026-11-07.md)。浏览器验证不代替 WKWebView、真实输入法、热插拔与安装版验收。

## 图标来源与更新

- 图中的手机屏幕只是设备家族的视觉示意，不读取设备壁纸，也不代表机身颜色。
- 苹果设备通过包内 Swift helper 调用公开 `UTType` / `NSWorkspace.icon(for:)` API，读取当前 macOS 已安装的家族图标。图像在后端进程内缓存，不随每次功率采样重新提取。
- 当前匹配 iPhone、AirPods、AirPods Pro、Magic Mouse、Apple 键盘和 MacBook 家族；未声明的系统类型自动回退，不用通用文档图标假装设备图片。该能力依赖已安装的系统资源，不保证覆盖刚发布的型号。
- 其余设备使用 `@mdi/js 7.4.47` 的类别图标，许可说明打包在 `ui/licenses/material-design-icons.txt`。不是全品牌商品照片数据库，也不会把一张粉色 iPhone 图片套给所有手机。
- 参考 [device-icons](https://github.com/bkahlert/device-icons) 的系统图标解析思路；没有复制其系统图集。类别图标来自 [Material Design Icons](https://github.com/Templarian/MaterialDesign)。均不进行运行时网络图片查询。
- 九张旧演示产品 PNG 已移除。系统图标仅接受固定家族的有界 PNG data URL，其他内容回退到包内类别图标，不放宽宿主 CSP。

## 设备数据与安全边界

- Rust 每 45 秒只读运行系统 `system_profiler -json`，解析蓝牙连接列表、USB 拓扑、显示器和电源状态。
- 蓝牙设备缺少电量时，额外只读运行 `pmset -g accps`（3 秒超时、64 KiB 上限），按唯一且完全匹配的设备名补充 macOS 配件电量。它不添加设备，不覆盖系统报告已有电量；查询不可用或同名设备无法区分时仍显示未知，不需要管理员权限。
- 桌面组件展示当前连接设备，按配置显示最多 3/5/8 个或全部；点击统计按钮切换蓝牙、USB、显示器分类，全部模式在列表内滚动。超过上限时标出当前分类的显示数量；刷新保留分类及列表滚动位置。扫描失败或过期时明确标为上次采集结果，不把缓存冒充实时连接状态。
- 供电来源独立通过只读 `pmset -g batt` 读取，不依赖电池或瓦数遥测。无内置电池的桌面设备不显示充放电状态；系统未提供实时功率时仍显示已确认的供电来源，不用估算或适配器规格填充缺失瓦数。
- 不回传蓝牙地址、序列号或手机调试唯一标识；连接事件只保存在进程内存。
- 显示器卡片和桌面组件将已知像素尺寸显示为 720P、1080P、2K（2560 × 1440）、4K、5K、6K、8K，并保留刷新率；竖屏按相同像素对识别，非标准尺寸保留准确数值，不按界面逻辑尺寸猜测档位。完整像素尺寸仍可在详情或悬停提示查看。显示器卡片优先使用系统报告的像素分辨率及刷新率，界面逻辑尺寸单独放在详情中；缺少像素数据时只标为显示模式。内置／外接类型优先读系统报告，缺失时通过在线显示器 ID 查询 CoreGraphics，仍无法确认则显示类型未知。
- 功率采样间隔在组件编辑器配置，支持 5/10/30/60 秒，默认 5 秒；控制可见页面的刷新与后端缓存，编辑器不轮询，多个页面共享较新的采样。主插件页面默认 5 秒，设备目录扫描仍为 45 秒。小窗不显示采样间隔。
- 电池接口采样只读调用 `ioreg -a -r -c AppleSmartBattery`（3 秒超时、2 MiB 上限）。输入功率读取 `PowerTelemetryData.SystemPowerIn`（mW），整机功耗读取 `SystemLoad`（mW）；缺失时仅接受 `BatteryData.AdapterPower/SystemPower` 的真实浮点 W 值，不猜测旧整数编码的单位。
- 电池接口缺少整机功耗或外接输入读数时，只读连接 `AppleSMC`，读取 `PSTR`（整机功耗）和 `PDTR`（直流输入），仅补充缺失值；不覆盖已有电池遥测，不在电池供电时填入外接输入，不用 CPU/GPU 功率相加冒充整机功耗。无需管理员权限或特权服务。缺少传感器、权限受限或数值无效时保留未知，并释放每次采样的连接。已在 M4 Mac mini / macOS 15.5 实机验证；其他机型按传感器可用性回退。
- 电池侧功率由电池电压（mV）×有符号电流（mA）/1,000,000 估算，正值为充电、负值为放电、0 为电池待机。拔掉电源后不沿用缓存中的外接输入值。系统传感器本身可能延迟，不能视为外置功率计测量。
- 适配器规格、输入功率、整机功耗与电池功率分别显示；不同字段可能不是同一时刻采样。未知数值显示未提供，查询失败会清除功率值并显示错误。无电池或缺少遥测的机型不保证可读。
- ADB 授权状态、iPhone 信任状态、USB PD 线缆能力以及各外设独立耗电功率尚未实现；整机功耗不代表独立供电的外接显示器耗电量。

## 构建与安装

macOS + Xcode Command Line Tools（Swift）+ Node.js 22+ + pnpm 10.15.1 + Rust stable：

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

FlowHub 的「插件市场 → 安装开发目录」选择 `plugins/device-center/build/`，不要选择源码目录。运行前先检查本地安装来源是否更新到了目标版本，并完成真实 FlowHub 页面视觉与数据验收。
