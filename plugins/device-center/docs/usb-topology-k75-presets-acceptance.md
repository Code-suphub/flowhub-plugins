# USB 连接树与 K75 预设验收

目标版本为外设中心 0.3.17。

## USB 枚举与连接树

- 设备树保留 macOS 报告的上下游关系和原有设备 ID。设备有真实厂商名称时优先采用，缺失时使用系统按 USB 厂商 ID 查到的名称，忽略设备填入的占位字符串。
- Hub 表示 USB 枚举节点。Mac mini 上的 Genesys Logic `05e3:0608` 下挂 Terminus `1a40:0801` 和 USB-C Billboard 节点。K75 `258a:0112` 接在 Terminus 下游。Billboard 节点报告 USB-C 替代模式，详情将该节点的 USB 速率与视频链路区分。USB 枚举无法给出 HDMI 线和数据线的实物数量。
- 管理页按树展示 USB 设备，详情可打开上下游。小窗保留原设备排序，在摘要中补充上游名称。K75 详情可访问同型号的另一类连接，设备出现多个候选时保留各自条目。

## K75 RGB 能力拆分

| 能力 | 证据和边界 |
| --- | --- |
| USB 与 BLE 输入 | 有线 HID `258a:0112` 提供 520 字节 Feature Report 的厂商集合。BLE HID `3554:fa07` 的键盘集合最大 Feature Report 为 1 字节。已在 Mac mini 授权并枚举应用可见的 GATT 特征，详见下文 |
| 配置块与键位 | USB 命令 `0x84` 返回 128 字节和尾部标记 `5a a5`。对有线设备版本 `0x4023`，首字节 `0=Windows`、`1=Mac`。实体 Fn 切换与工程版设置命令均有实机读回 |
| 灯效 | 对布局标记 `0x09=0`，偏移 `0x0a` 的 `2=呼吸`、`4=关灯` 已验证。其他灯效只显示为未识别。预设支持记录已识别灯效，写入前比较预期状态并核对整块配置读回 |
| 电源与电量 | 命令 `0x87` 返回两个原始字节。蓝牙系统百分比与有线原始字节需要独立对照，充放电和 30%／100% 映射待验 |
| 按键映射、组合键、宏和灯光参数 | 官方驱动为该 USB ID 提供键位布局，包含灯效选项和消抖参数表，软件界面也提供映射和宏。对本设备的存储布局、写入命令及 Fn 层行为待对照验证 |
| 固件与芯片 | 标准版和性能版的 Windows PE 程序段完全相同，固件附加块从文件偏移 `0x1fb800` 开始。已解出两份各 60 KiB 的 8051 应用镜像，并定位标准版设置蓝牙名称的串口链路。主控丝印、无线模块固件与引导协议待核对 |

参考 [珂芝 K75 说明书](https://en.kzzi.com/media/files/20230613/20230613120005_4169.pdf)、[珂芝官方驱动](https://en.kzzi.com/download/1/) 和 [Bluetooth HID over GATT](https://www.bluetooth.com/specifications/specs/hid-over-gatt-profile/)。

## 蓝牙配置实机复测

- 旧探针在授权状态为 `.notDetermined` 时退出，尚未创建 `CBCentralManager`。复测在 Mac mini 的图形会话启动带蓝牙用途说明的独立诊断应用。探针读回 `.allowedAlways`，并完成 K75 特征枚举。授权属于诊断应用，当前外设中心 0.3.17 的预设配置仍走 USB。[Apple 蓝牙用途说明](https://developer.apple.com/documentation/bundleresources/information-property-list/nsbluetoothalwaysusagedescription)
- CoreBluetooth 返回设备信息 `180A` 和电池服务 `180F`。设备信息读到软件版本 `3008` 和 PnP ID，电池特征 `2A19` 读到 `0x64`（100%），与同时段 macOS 系统报告一致。枚举到的三个特征均无写属性，硬件版本和固件版本特征也未出现。30%／100% 变化原因仍需按同一设备的时间序列核对。[Bluetooth SIG Assigned Numbers](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Assigned_Numbers/out/en/index-en.html)
- 同一台 Mac mini 的 IOKit 另外枚举到 K75 的 BLE 键盘 HID。对该路线尝试匹配只读配置命令 `0x84` 所需的厂商 Report `0x06`，匹配数为零，测试在发送前停止。写入模式和灯效仍待找到可验证的无线协议。证据见 `ble-followup/result.json` 和 `ble-followup/hid-route-verification.json`。

### 无线模块续查

- 完整 BLE HID 描述符另有厂商 Usage Page `0xff02`、Report `0x13`。该报告有输入和输出方向，各 19 字节载荷，主机 IOKit 缓冲区另计一个 Report ID。Mac mini 上按设备名、VID/PID、BLE 传输和描述符匹配到唯一的 K75，以只读 `GetReport(Input, 0x13)` 取得 19 字节全零载荷。输出报告有描述符声明，命令及配置写入仍待验证。[Bluetooth HID over GATT](https://www.bluetooth.com/specifications/specs/hid-over-gatt-profile-hogp/)
- 标准版主控串口接收器在 `0x9a34` 把 `0x08` 帧长度设为 22 字节，校验位于 `0x11bd`。`0x1221` 按帧内第三字节低七位分派，长度与两字节帧头、19 字节载荷和一字节校验相符。无线模块是否将 Report `0x13` 转换为此帧仍需抓包确认。现有 K75 Windows 驱动的 HID 导入表使用 `GetFeature` 与 `SetFeature`，可继续用于对照有线协议。
- Mac mini 当时未枚举到可辨认的 K75 2.4G 接收器。没有实机发送 BLE 写命令。键盘 HID、GATT 和已验证 USB 诊断均未提供 CPU 或内存占用。证据位于 `wireless-module/` 的 `hid-descriptor.json`、`probe-result.json`、`uart-dispatch.json`。

## 固件离线拆解

- 附加块由 12 字节头、60 KiB 密文和末尾 4 字节解码键组成。头部包含 `5a a5 SINO`、大端 VID/PID 和载荷长度。Windows 更新器 `0x403aa0` 处实现 32 轮改版 TEA，增量为 `0x9e3769b9`。两份载荷均以大端 8 字节块解码成功，重新编码逐字节匹配原密文，复位向量、多个中断向量和 USB 描述符均可核对。标准版的 USB 描述符与实机 `258a:0112`、`bcdDevice=0x4023` 和厂商 Report `0x06` 匹配。性能版对应 `258a:0149`、`bcdDevice=0x1207`。[同类 NuPhy Air75 解包参考](https://github.com/thebabush/nuphy-air75-reversing/blob/main/extract_firmware.py)
- 标准版 `0x9629` 从 `0xb9b5` 或 `0xb9c2` 取蓝牙名称，组帧后经 `0x996f` 发送。发送代码将字节写到串口数据寄存器 `SBUF` (`0xaa`)，并以 `0x55` 减前面字节之和生成帧尾。串口中断入口与中颖 SH68F90 的寄存器和向量表吻合。这个路径定位在键盘主控内部，仍需识别无线端实现及其对外协议。[中颖 SH68F90 规格书](https://www.32mcu.com/pdf/PDF_24/SH68F90%20CV1.0.pdf)
- 解包和结构核对证据见 `firmware-followup/decode-report.json` 与 `firmware-followup/structure-verification.json`。固件镜像和实机日志保存在 Git 外。本轮未执行固件更新。

## 验收步骤

1. 打开 USB 分类，确认同名 Hub 能按厂商和父节点区分。打开 Genesys 详情，点入 Terminus，再点入 Gaming Keyboard。返回转接器时应看到 USB-C 模式报告。
2. 对 `0x4023` 有线 K75 记录现有状态为具名预设，切到另一键位后应用原预设。核对模式、已识别的灯效和诊断指纹。文件应只保存名字和经验证的枚举值。
3. 用过期的预期模式发起写入，确认被拒绝且配置指纹相同。拔线或替换为其他设备版本后确认写入口不可用。
4. 在 Mac mini 正式安装版核对键位变化后的实际按键映射、小窗路径摘要和设备行排序。固件设置试验结束时恢复原配置。

隔离浏览器对打包产物通过 127 项行为检查和 24 组响应式检查，含窄屏连接树、上下游导航、同型号连接入口、记录和应用预设、诊断原始值。

证据目录为 `~/.local/state/flowhub-k75-usb-20261107/deep-diagnostics/`，包含工程版完整配置恢复读回和蓝牙 GATT 授权检查。Mac mini 的 0.3.17 隔离后端已通过 USB 父链、Billboard 分类、预设持久化、过期状态拒绝和恢复后完整配置指纹检查。

Mac mini 正式安装使用 FlowHub 插件市场，更新前备份 0.3.16 安装目录和插件登记。0.3.17 的 29 个文件指纹、登记目录、启用状态和正式宿主子进程均核对通过。通过屏幕共享验证 USB 分类内的 Genesys Logic → Terminus → Gaming Keyboard 层级，打开键盘详情并展开「有线配置与预设」，确认 Mac 模式、关灯状态、切换和记录入口可见。正式界面本轮只做展示验收，预设保存和键位写入以隔离验收为准。证据见 `install-staged.json` 与 `installed-proof.json`。
