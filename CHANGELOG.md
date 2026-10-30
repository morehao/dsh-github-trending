# Changelog

## 未发布

### 变更

- **设置页只出现在左侧菜单栏**：不再同时注册 `settings.section`，改为左侧栏一个入口、内含「设置 / 运行」两个 tab，避免同一插件在左侧栏与设置里各出现一份。
- **跟随宿主明暗主题**：样式表从宿主并不存在的 `--dsh-fg / --dsh-bg / ...` 换成设计系统 token `--dsw-alias-*`，暗色桌面端不再强行渲染亮色。
- **设置页改为左侧纵向 tab + 右侧滚动**：六个分区（内容来源 / 模型 / 仓库 / 认证 / 榜单 / 调度）纵向排列，右栏独立滚动；面板根补上 `height/overflow`，修复宿主 `main` 面板裁掉内容且不出纵向滚动条的问题（运行页同样受益）。
- **沿用 DSH 配置更省心**：改为读取宿主 `ctx.agentDefaultModel.currentSelection()` 的当前默认模型一键带入（默认置顶），并只列**实际生效路由**（`listProviders`）及其模型目录（`listModels`）供按需展开选择；不再把 `listConfigurableProviders` 的能力目录当成「已配置」，也不会再把「支持 OAuth」误判为可用。`凭据引用` 默认隐藏、随选择自动带入。
- **首屏只留普通用户字段**：`TRENDING_DIGEST_CORE` 与手动 `凭据引用` 收进「高级设置」；仓库路径改为目录选择；目标分支只读展示仓库默认分支（`git symbolic-ref` 读 `origin/HEAD`，只读不写仓库）；`远端`、`PR 标题模板` 不再露出，用默认规则。
- **GitHub 认证收敛**：只保留真正可用的「本机 gh」与「PAT」两种，各自给出可操作步骤，并新增「测试认证」按钮（`POST /github/test` 调 `api.github.com/user` 验证并回显账号）。删除从未实现的 Device Flow（旧配置里的 `device` 自动迁移为 `gh`）。
- **侧栏入口不再是一整张卡片**：`sidebar.panellist` 只渲染 16–18px 图标（`SidebarPanelIcon`），状态摘要与「立即运行 / 试跑」留在面板页。
- **设置按 tab 分段保存**：每个 tab 独立提交与校验（`POST /config` 新增 `section`），保存某个分区不会顺带提交或覆盖其它 tab 里尚未保存的改动；左栏 tab 用黄点标记未保存改动。

### 修复

- **运行日志写到真实 `~/.dsh`**：`Store.logsPath` 之前忽略 `dir` 选项，测试/自定义数据目录也会把 `runs/*.log` 写进默认数据目录；改为跟随 `this.dir`。
- **代理模式下保存被 baseURL 校验误拦**：`mode=proxy` 的端点由运行时回环代理注入、quickfill 也会清空 `baseURL`，但 `/config` 仍强制其非空，导致「模型预检通过、保存却报 `model.baseURL：该 provider 需要显式 baseURL`」。现在代理模式豁免该必填校验（仍校验非空时的 http(s) 格式）。

## 0.1.4 - 2026-10-30

> 0.1.3 从未发布到 npm（tag 推上去后 `release.yml` 在「发布前校验」失败）。0.1.4 是这批改动的第一次真实发布，内容 = 0.1.3 小节 + 本节的修复。

### 修复

- `check-pack` 不再假设 `npm pack --dry-run --json` 是单段干净 JSON：改为扫描顶层平衡 JSON 值、取第一个含 `files` 的数组，兼容 CI 上「两段 JSON 以逗号相连」的输出形态（release run 41083620340 实测）；新增 `test/pack-json.test.mjs` 6 条回归。

## 0.1.3 - 2026-10-30

### 工程（CI / 工具链）

- **门禁补齐为单一入口**：`npm run check` 现在串起语法 → host/client 类型 → lockfile → 契约 → 构建 → 命名/接线 → 打包白名单 → Release 正文冒烟 → 单测 → AC-P；`check.yml` 只调用它，本地与 CI 跑同一串脚本。
- 新增四道检查：`check-syntax.mjs`（`scripts/`、`test/` 语法 + `locale/`、`contract/` JSON 可解析）、`check-naming.mjs`（包名 / patch `name` / `export const name` 三处一致，`dsh.core` 与 `UPSTREAM.json` 同源，`exports`/`files` 接线）、`check-pack.mjs`（tarball 白名单 + 必备文件）、`smoke-release-notes.mjs`（投影与 git-kit 读回管道逐字一致）。
- release 链路不再重复校验：`prepublishOnly: npm run check` 改为 `prepack: npm run build`，发布时只构建、不再跑第二遍测试。
- **actions 升 v7**：此前的两条 CI warning（`Node.js 20 is deprecated`、`package-manager-cache` 非法输入——v4 不认识该输入，等于「关依赖缓存」一直空转）来自 actions v4，升 v7 后消失；Node 保持 22（CI 与发布），`engines` 为 `^22.20.0 || >=24.0.0`，新增 `.nvmrc`，构建依赖精确锁版本。

## 0.1.2

> 0.1.1 从未发布到 npm（tag 推上去后 CI 在 `npm ci` 就失败），0.1.2 是它的第一次真实发布。

### 修复

- lockfile 里 57 个 `resolved` 指向 `registry.npmmirror.com`，npm 11 在 CI 拒绝拉取（`EALLOWREMOTE`）；统一为 `registry.npmjs.org`，并加 `scripts/check-lockfile.mjs`（`npm run check` 会跑），把这类只在发版暴露的错误前移到 PR。

### 发布链路

- 新增 tag 触发的发布：`.github/workflows/release.yml`（OIDC Trusted Publishing，无 NPM_TOKEN）+ `scripts/ci-publish.sh`（版本守卫 / 幂等 / 失败回读后重试）+ `scripts/release-notes.mjs`（只投影注记 tag 正文）+ `docs/publishing.md`。
- `check.yml` 在 PR/main 上跑 `npm run check` 与 AC 机械检查。

## 0.1.1

分发方式变更：核心二进制不再走 npm 平台分包，改为 **GitHub Release 下载 + sha256 校验 + 本地缓存**（2026-10-30 决策 B）。

### 变更

- **获取核心**：`TRENDING_DIGEST_CORE` / 设置里的 `corePath`（覆盖，仅排障）→ 缓存 `$DSH_HOME/github-trending/core/v<version>/` → 按 `os/arch` 下载 `trendradar_<goos>_<goarch>`，用同目录 `checksums.txt` 校验（流式写入 + 原子 rename + 0755），失败不留半个文件；缓存命中后完全离线。
- **版本来源**：`package.json` 的 `dsh.core.{repo,version}`；`scripts/sync-contract.mjs --ref vX.Y.Z` 会同步写入，保证「契约来源 tag」与「下载的核心版本」是同一个值。
- **新增配置**：`coreAutoDownload`（默认 `true`）；关掉后只报 `CORE_NOT_DOWNLOADED`，由设置页显式下载。
- **设置页**：显示 Release 版本 / 资产名 / 缓存状态 / 下载 URL，并提供「下载核心 / 重新下载」按钮（`POST /core/download`）。
- **新增错误码**：`CORE_NOT_DOWNLOADED`（未下载，附下载地址）、`CORE_CHECKSUM_MISMATCH`（校验失败且已丢弃）；`CORE_UNAVAILABLE` 现在覆盖 404（版本未发布）、网络失败与平台不在矩阵。
- **移除**：`optionalDependencies` 里的 6 个 `@morehao/trendradar-core-*`（从未发布，安装时只是 6 次无效探测）。

### 修复（实测 v0.1.0 Release 后发现）

- Windows 资产名带 `.exe`（goreleaser `formats: [binary]` 保留后缀）：`assetName()` 按平台补后缀，避免 Windows 上下载 404。

### 测试

- 新增 `test/release.test.mjs`（命名映射 / 下载校验 / 缓存复用 / 篡改重下 / 校验失败无残留 / 404 提示 / force）与 `test/core-status.test.mjs`（未下载 / 已缓存 / 覆盖路径三种状态）。
- AC 脚本 AC-P-11 判据改为「环境变量优先 / 未设走 Release」，全套 71 条测试、11 条 AC 机械检查通过。

## 0.1.0

首个可用版本：插件侧完整落地，内容仍全部由 `trendradar` 核心产出。

### 新增

- **核心客户端**：`TRENDING_DIGEST_CORE` → 平台包（`@morehao/trendradar-core-<os>-<cpu>`）定位；`version --json` 握手比对 `ipcSchema`/`digestSchema`；一次 `run` 一次性进程，120 s 超时、`SIGTERM`→`SIGKILL` 取消；stdout 单信封解析，同时兼容契约 `RunResult` 与核心当前 `run --json` 形状。
- **密钥不落盘**：核心配置经 POSIX FIFO 传入（文件系统里不出现明文），Windows 退化为 0600 临时文件并立即删除；GitHub token 只走子进程环境；日志统一脱敏。
- **契约快照**：`contract/` 随包分发（schema + fixtures + `CONTRACT.sha256` + `UPSTREAM.json`），`scripts/sync-contract.mjs --ref <sha>` 从核心仓库同步并校验 aggregate；`src/ipc.gen.ts` 由 schema 生成，`npm run check:contract` 校验两者。
- **设置页**：内容来源与核心状态、模型（快速填充 + 连通性预检）、归档仓库、GitHub 认证、榜单范围、调度；从本机 CLI 一次性导入非敏感字段（密钥不导入）。
- **快速填充**：读宿主 `listProviders`/`listConfigurableProviders`/`listModels` 与 `ctx.credentials.describe/resolve`，按三种凭据形态落到 `direct` / `proxy` / 手填。
- **回环代理**：OAuth 类 provider 由插件在 `127.0.0.1` 起一次性 OpenAI 兼容端点，转发 `ctx.llm.stream`；随机端口 + 一次性 token，运行结束即关闭。
- **运行页与侧栏卡片**：本次（运行/试跑/取消、9 步、最近结果、错误卡）与历史（最近 30 条）；侧栏卡片显示状态、下次运行、上次结果与一键运行。
- **两个工具**：`trending_run`、`trending_history`（稳定对外名）。
- **调度**：插件自己的 60 s tick，按 IANA 时区判当日、6 小时补跑、同日不重复。
- **共存检测**：`PATH` 上的 `trendradar` 只提示不切换。
- **错误码映射**：17 个核心码 + 插件码（`CORE_*`、`IPC_INVALID`、`MODEL_KEY_MISSING`、`GITHUB_AUTH`、`PUSH_FAILED` 等），带落点与「下一步」。
- **locale**：`locale/zh.json` / `locale/en.json`（市场卡片标题与描述）。

### 已知偏差

- 核心暂未实现 stdin 信封，插件按其现有 `run --config <path> --json` 传参；`RunResult` 已兼容。
- 宿主 `schedule` 是会话本地提醒，插件改用自有 tick 覆盖无人值守场景。
- 平台包（`@morehao/trendradar-core-*`）尚未发布：缺失时明确报 `CORE_UNAVAILABLE`，不降级。
- 版式只支持 `canonical`；`template` 字段映射留待二期。

## 0.0.1

- 初始化包结构：TypeScript + tsup 构建、Cordis 插件入口、市场元数据。
