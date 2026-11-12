# 资源监控卡片 · Plasmic 接入试点

设计项目：[FlowHub](https://studio.plasmic.app/projects/rKroot8WmpiogJg8366SaB)。实际使用的布局组件为 `ResourceMonitorCardLayout`，与早先录入的静态页面副本独立。

## 维护分工

- Studio：卡片外层的间距、颜色、尺寸和四个区域的位置 / 样式；区域名 `header`、`alerts`、`list`、`footer` 是稳定接口，保留这些名称。
- `src/ResourceCardFrame.tsx`：将四个区域接到实际 React 内容。采样、排序、导航、配置自动保存与错误处理仍在 `src/Card.tsx`，公共按钮、勾选框、弹窗和焦点行为仍复用公共组件。
- `src/ResourceCardRegion.tsx`：同步时映射的区域边界。Studio 区域里的演示文字只用于设计预览；安装版不会把它们当作真实数据。
- `src/plasmic/`：官方 Codegen API 的生成结果及导入映射，只通过同步命令更新。业务逻辑写在此目录之外。`generated.json` 保存项目 revision 和文件指纹；发现本地编辑、未知文件、缺失绑定、外部资源或无关组件时，同步会停止。

修改布局后不需要重新连接采样或保存接口。新增交互、修改业务字段或区域接口时，需要同时修改包装层并回归测试。该机制不将任意 TSX 修改反向转换为 Studio 可编辑图层。

## 从 Plasmic 同步到本地

在 `plugins/resource-monitor` 执行：

```sh
# 指向既有的私有认证文件；不把授权信息放入源码或命令参数。
export PLASMIC_AUTH_FILE=/absolute/path/to/private/.plasmic.auth
pnpm plasmic:sync           # 查看当前同步版本，不联网
pnpm plasmic:sync --apply   # 获取最新保存的试点布局，不写业务文件
pnpm plasmic:sync --check   # 离线检查生成文件指纹
pnpm typecheck
node --test tests/plasmic-sync.test.mjs tests/card-entry.test.mjs
pnpm build
```

同步使用 `fontOpts.scheme=none`，沿用系统字体及 `--fh-*` 主题变量。生成代码、样式随插件打包，构建和安装版运行不读取 Plasmic、不下载字体或 CDN 资源。卡片使用 Terser 进行构建时压缩，保持原有体积预算；SDK 的 Studio 注册入口不进入生产包。

## 自动同步与本地开发预览

```sh
# 与单次同步使用同一个私有认证文件；只由本机 Node 开发服务读取。
export PLASMIC_AUTH_FILE=/absolute/path/to/private/.plasmic.auth
pnpm plasmic:host
```

- 开发服务启动后，每 3 秒读取一次 Plasmic main 分支的保存版本；版本有变化才请求 Codegen，校验成功后更新 `src/plasmic/`。不需要发布 Plasmic 项目，也不需要手动运行同步。
- 打开独立预览 `http://127.0.0.1:5189/plasmic-preview.html`。保存后的布局会自动刷新到此页面，下方显示当前 revision 与同步状态；深色预览加 `?theme=dark`。同步只覆盖试点 `ResourceMonitorCardLayout`，静态页面库或其他组件的编辑不会自动成为运行页面。
- 缺少认证时仍可打开上次已同步的预览，页面会提示设置 `PLASMIC_AUTH_FILE` 后重新启动开发服务。断网、授权失效、布局接口校验失败或生成目录有本地改动时，保留上次布局并显示原因；连接失败按 3 / 6 / 12 / 24 / 30 秒间隔重试。生成目录的手改不会被自动覆盖，单次同步与自动同步不能同时写入。
- 自动同步仅刷新独立预览，不整页重载 Studio 的 App Host。停止或重启开发服务会取消未完成的请求并清理监听。可用 `PLASMIC_AUTOSYNC=0 pnpm plasmic:host` 关闭自动拉取；生产构建、普通 `pnpm dev` 与安装版均不启动该功能。
- `src/Card.tsx` 等业务文件、插件 `build/` 和正常安装目录不是自动同步的输出。设计验收后再执行类型检查、回归测试和打包，随后单独用正式 CLI 更新安装版；自动同步不会构建、安装、重载插件或提交 Git。

## 将本地组件提供给 Studio

- App Host：`http://127.0.0.1:5189/plasmic-host.html`。在项目设置中将 App Host 指向此地址后，Studio 可以使用 `FlowHubResourceCard`（真实卡片组件＋合成 API）及 `FlowHubButton`（公共按钮）。第一次连接时按 Studio 提示确认这个本地来源。
- Studio 中的采样、配置和操作只在内存中模拟；关闭后清空。它不访问正常安装版、邮箱、剪贴板、真实机器或设备，也不执行进程结束操作。
- `FlowHubResourceCard` 用于在其他画板中预览真实组件；不要把它放进 `ResourceMonitorCardLayout` 自身，避免递归。同步会拒绝这种嵌套。
- App Host 是开发服务，需要保持启动；代码或组件属性变化通过 Vite 更新到 Studio。停止本地服务后，应将项目 App Host 恢复为原配置，以继续使用不依赖本地服务的静态页面库。

## 验收要求

先验证“Studio 改布局 → 同步 → 本地布局变化”，并核对业务文件指纹保持一致。再检查采样刷新、列头排序、设置选中高亮、保存失败 / 重试、关闭后回焦、重建卡片后的配置恢复、深浅主题与窄屏滚动。

现有卡片测试运行在隔离 Chromium 和合成宿主协议下；不替代正式安装版的系统焦点、中文输入法、双屏和用户实际桌面条件。安装包替换与原生冒烟需单独记录。
