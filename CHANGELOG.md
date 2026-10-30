# Changelog

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
