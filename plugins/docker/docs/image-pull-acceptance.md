# 镜像拉取验收

2026-11-06，目标 docker 0.4.0。按 [Docker image pull 官方文档](https://docs.docker.com/reference/cli/docker/image/pull/) 接入现有本机 CLI，通过当前 Unix socket context 执行，不新增远程环境、仓库凭据保存或自动运行容器。

## 已验

- [x] 新建后台任务、读取快照、停止指定请求；开始前校验明确镜像标签／sha256 摘要、平台、确认和当前 context。不经过 shell，不接受附加命令参数，每个插件进程同时只运行一个拉取任务。
- [x] 拉取固定提交时 context；任务不占用 stdin RPC，下载中 health 与其他浏览请求仍可返回。内存保留最近任务和最多 32 层进度，只展示白名单阶段，不回显原始错误、登录输出或凭据。
- [x] 完成后 inspect 回读镜像 ID，无法核实则不显示成功；失败保留输入。停止／30 分钟超时结束本次 CLI 等待，明确提示引擎可能保留下载层，不宣称回滚或释放空间。
- [x] Rust 25 项、前端／契约 36 项、类型及独立包构建通过；新增行为覆盖 IME／重复提交、失败草稿、后台继续／重新打开、成功刷新、环境变化丢弃迟到响应、任务 ID 取消和只读禁用。
- [x] 真实 Docker CLI＋临时 Unix socket 模拟引擎通过确认／参数／环境防护、重复任务、实时层进度、非阻塞 health、成功身份回读、凭据安全失败及指定取消；不连接用户引擎或下载实际镜像。入口：node tests/image-pull-smoke.mjs。

- [x] 后台浏览器＋真实插件＋隔离模拟引擎完成表单提交、层进度、完成、镜像列表刷新、重开恢复任务与仓库拒绝失败保留草稿；未展示测试错误中的私密标记。1280 × 720 浅色、380 × 600／640 × 360 深色检查通过，矮窗正文独立滚动、底部操作固定可达。截图为仓库外 plugin-comparison/docker-pull-*.png。
- [x] 插件仓库全量构建、完整测试及机器布局检查通过；卷／网络和镜像清理的真实 CLI＋隔离引擎回归通过。宿主应用检查通过；根目录既有 198.18.0.1 断言失败保留记录，不改历史测试。

## 待验

- [x] 2026-11-06 经 FlowHub 真实插件市场更新并重新打开 docker 0.4.0，安装清单保持启用并指向独立构建目录。真实 Colima 中只读载入 3 个已停止容器、11 个镜像；打开镜像拉取表单、键盘输入公开测试名称、不提交，Escape 关闭后焦点返回拉取按钮。证据在仓库外 `plugin-comparison/docker-installed-pull-form.png`。
- [ ] Docker Desktop、网络中断恢复和其他平台继续待验；当前真实 Colima ARM64 的公开测试镜像下载、原生提交和刷新已通过，见下方记录。日常业务镜像标签不用于更新测试。
- [ ] 真实 WebKit 中文输入、系统主题、键盘、最小窗口、多屏及插件重新加载后的任务结束提示。重新加载／退出插件会结束客户端任务，已下载镜像层可能仍存在；任务记录仅存在当前插件进程内。

## 真实 Colima 下载（2026-11-06）

- [x] 通过安装清单核对 docker 0.4.0 和启用状态，启动安装目录的同一后端二进制，以独立 stdio RPC 进程连接当前真实 Colima（Docker 客户端 28.2.2／引擎 29.2.1，ARM64）。没有切换用户 context；此项是实际引擎功能验证，不是原生页面提交或模拟引擎。
- [x] 测试前 hello-world:latest 不存在；显式 reference／linux/arm64／colima／confirmed 提交后返回 running，随后 health 返回 protocol 2，任务变为 succeeded，回读两条镜像层完成状态和完整镜像 ID。后端 images 列表能找到同一名称／标签／ID。
- [x] 再通过真实 Docker inspect 独立核对 Linux／arm64、大小 15830 字节、镜像 ID `sha256:c567b231f65614688711a75f31518a064258a51d442117a3e771a3a8fdba78ef`。这是 Docker 官方公开 hello-world 测试镜像，仅拉取，没有运行容器，保留测试镜像用于原生列表回读。
- [x] 下载前后 3 个原有容器的 ID／状态／运行标记／启停时间全部一致，镜像数 11→12；未启动、停止、创建或删除容器。独立测试进程在任务结束后退出，不影响宿主的插件进程。
- 原始记录在仓库外 `plugin-comparison/docker-real-engine-pull.json`、`docker-native-pull-before.json`、`docker-native-pull-after.json`。采样读到了层完成状态，没有把快速下载记为完整中间进度动画验收。
- [x] 解锁后在安装版原生 WebKit 中，选择 hello-world:latest／Linux ARM64／colima 并确认拉取，页面显示「正在拉取」→「拉取完成」及同一完整镜像 ID；关闭后手动刷新并搜索 hello-world，列表只有 1 个匹配项，镜像总数仍为 12。重新打开拉取窗口，任务完成状态、目标平台和镜像 ID 保留。实际首次下载在上方独立进程完成，本项为宿主插件进程内对已有镜像的再次拉取，未冒充原生冷下载。
- [x] 原生页面测试后再次独立 inspect，ID／Linux ARM64 仍一致，3 个原有容器的状态和启停时间与下载前完全相同；没有运行、创建或删除容器。公开测试镜像保留供核对。
- 原生证据为仓库外 `plugin-comparison/docker-native-pull-target.png`、`docker-native-pull-completed.png`、`docker-native-pull-list.png`、`docker-native-pull-page.json`、`docker-native-page-after.json`。完成状态通过手动滚动展示，不计作自动滚动验收；本轮没有把 AX 点击关闭后的插件 HTML 焦点记为键盘返回焦点通过。
- [ ] Docker Desktop、实际网络中断／恢复、实际停止请求和其他平台仍待验；不将当前 Colima ARM64 单次成功扩大为这些场景通过。

镜像构建／推送、仓库登录管理、远程 context、卷备份恢复与网络连接／断开继续独立拆项，本批不计为完成。
