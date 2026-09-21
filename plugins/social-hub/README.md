# 社交聚合

独立的 FlowHub 社交会话聚合插件。使用 React + TypeScript + Vite + Tailwind 提供紧凑会话工作台；把各平台会话集中到一个列表里查看，并提供回复入口。

## 当前能力

- `connectors`：列出小红书（待授权）、闲鱼（通知/跳转）、抖音（待配置 Client Key）及其可用状态。
- `conversations` / `messages`：读取会话列表与消息内容，支持按联系人或内容过滤；当前后端固定返回内置演示数据。
- `authorize_url`：为抖音生成 `open.douyin.com` 官方 HTTPS OAuth 授权链接，需要填写 Client Key 和回调地址；界面只展示链接，不自动打开或完成授权。
- `send`：回复接口已保留；当前连接器未授权时固定返回失败原因，界面不会清空失败发送的草稿。

## 构建与安装

在插件目录运行 `npm run build`（后端 `cargo build --release` 后生成自包含的 `build/`，并检查 UI 的本地资源与 CSP），然后在 FlowHub「插件市场 → 安装开发目录」选择 `build/`。`npm run dev` 提供只读浏览器预览；`npm test` 执行后端契约、RPC/preview 行为和 TypeScript 检查。

## 边界

这是连接器骨架：不含各平台的凭据存储、令牌刷新、真实会话拉取与撤销流程，也不做消息持久化。界面会标注“演示数据 · 未授权”；账号、Client Key、Token 和密钥不进浏览器持久化或日志，接入真实平台前不要把这里的会话当作线上数据。
