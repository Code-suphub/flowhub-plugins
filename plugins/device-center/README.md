# 外设中心 · Device Center

FlowHub 的独立 macOS schema 2 设备监控插件。

## 功能
- 每 45 秒从系统报告扫描一次已连接的蓝牙设备、USB 设备、显示器与供电状态，支持手动刷新。
- 分类浏览、搜索设备、最近 60 条连接/断开事件（仅进程内存）。
- 通过系统报告显示有据可查的电量、速度和显示参数，缺少的字段标为未知。
- 电源只显示系统报告的适配器功率及充电状态，不把额定功率当成实时功率，不伪造线缆功率。
- 状态缓存、桌面组件、组件配置页和详情入口。
- USB 序列号、蓝牙 MAC、手机调试标识不输出；不联网爬取产品图，不在磁盘记录连接事件。
- 系统命令仅使用 /usr/sbin/system_profiler，限制输出 2 MiB 和执行时间 30 秒；无写操作。

## 本地构建
macOS + Node.js 22+ + Rust stable。

在 plugins/device-center 目录执行：

    npm ci
    npm test
    npm run build

完成后，在 FlowHub「插件市场 → 安装开发目录」中选择 plugins/device-center/build。

运行 npm run dev，在 http://127.0.0.1:5188 预览演示数据，浏览器模式不扫描真实设备。

## 已知限制
- 蓝牙经典设备、显示器刷新率、电池百分比等部分信息未必由系统返回。
- 不包括 Android ADB 授权状态、iPhone 信任状态、USB PD 协商、线缆 E-marker、实时功率测量。
- 显示器数据可能包括内建显示器；不保证全部都是外接屏。
- 连接事件是两次采样的差异，45 秒内短暂插拔可能遗漏；身份为本地哈希，重复型号可能合并。
- 应在 Intel/Apple Silicon 真机、MacBook/Mac mini 及不同外设上继续验收。
