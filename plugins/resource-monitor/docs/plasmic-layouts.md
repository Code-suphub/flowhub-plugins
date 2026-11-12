# Plasmic 布局自动预览

运行 `pnpm plasmic:dev`，私有认证文件通过 `PLASMIC_AUTH_FILE` 提供。预览端口 5201。`design/plasmic/layouts.json` 列出“联动 · …”组件、页面和 HTML ID `flowhub-layout-root` 对应的布局区域。修改该区域样式并保存后自动同步，原静态设计视图保留。

本轮接入 3 个页面入口，覆盖该入口内的各选项卡和状态。当前同步范围为页面外层布局样式，内部控件、业务文案、结构和原生能力仍由源码维护；新增内部布局区域应显式增加映射及验收。生成目录手改、结构变化、未绑定内容、外部资源会阻止覆盖。生产构建和安装版不连接 Plasmic，更新安装版另行执行。

## 2026-11-12 验收

- 公共同步工具测试、此插件完整测试、构建与资源检查通过。
- 真实 Plasmic 保存 API → 本机 Vite → 独立 Chromium：临时间距改为 17px 后自动生效，恢复后 CSS 仅剩注释。深浅主题 × 380 / 1150px，Tab / Esc 和页面异常检查已记录。该结果不代替系统输入、IME、多屏或实际设备操作。
- 未安装或重载本机插件。原始证据在 Git 外 `~/.local/state/flowhub-plasmic-modules/resource-monitor-roundtrip.json` 及同前缀日志；提交见本文件的 Git 历史。
