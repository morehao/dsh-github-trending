# dsh-github-trending

[![check](https://github.com/morehao/dsh-github-trending/actions/workflows/check.yml/badge.svg)](https://github.com/morehao/dsh-github-trending/actions/workflows/check.yml)
[![npm version](https://img.shields.io/npm/v/@morehao/dsh-github-trending.svg)](https://www.npmjs.com/package/@morehao/dsh-github-trending)

> GitHub 趋势日报的 **DSH 入口**：每天定时 spawn 本地 [`trendradar`](https://github.com/morehao/trendradar) 核心，抓取 Trending、生成中文简介与当日总结，提交到你自己的仓库并自动合并 PR。

**状态：0.3.0。** 插件侧（配置、调度、核心调用、状态与工作台、两个工具）已完成。核心二进制走 **GitHub Release**：首次运行按 `os/arch` 下载、用 `checksums.txt` 校验 sha256、缓存到插件数据目录，之后离线复用。核心仓库打 tag 出资产之前，运行会明确报 `CORE_NOT_DOWNLOADED` / `CORE_UNAVAILABLE` 并给出下载地址——不会写空文件，也不会退回旧内容。

## 它做什么

- 按你设定的时间（IANA 时区）每天跑一次；从侧栏入口进入工作台，点「立即运行」
- 一次运行 = **spawn 一次本地核心**：抓取 → 模型总结 → 渲染 → commit → push → PR → 合并，全部由核心完成
- 插件只负责：收集配置、调度、传配置与密钥、展示结果与错误、记录最近 30 次运行
- 内容按核心产出的成品**原样**落地（canonical），插件不改写、不重排、不二次调用模型
- 工作台分「概览 / 日报 / 运行记录 / 设置」：概览回答下次运行、就绪检查与上次交付；日报按日期回看最近 30 天；运行记录可展开交付物并看只读日志

**它不做什么**：不抓 GitHub、不解析 HTML、不调模型（回环代理模式除外）、不渲染内容、不执行 git。这些只有核心一处实现，避免两份实现漂移。

## 安装

```bash
dsh plugin --profile <profile> add @morehao/dsh-github-trending
```

装完重启宿主，在「设置 → GitHub 趋势」或侧栏入口进入。

## 三步上手

1. **选仓库**：填本地 git 仓库的绝对路径（插件不替你 `git init`，不是仓库就报 `REPO_NOT_GIT`）。
2. **填模型**：点「沿用 DSH 配置」从宿主 provider 目录里挑 provider 与模型；可导出密钥的直接传给核心，OAuth 类凭据走本机回环代理。
3. **试跑一次**：「试跑（不提交）」只抓取与渲染，不写文件、不提交。

> 设置页分「内容来源 / 模型 / 仓库 / 认证 / 榜单 / 调度」六个 tab；**除「内容来源」（只有状态与核心操作，没有可保存字段）外，每个 tab 独立保存与校验**；某个 tab 有未保存改动时，左侧对应 tab 会显示黄点。

## 日报预览与最近 30 天

- 运行成功后，Host 从核心本次返回的 `outcome.files` 里挑当天的 `.md`（优先 `YYYY-MM-DD.md`，否则只有一个 `.md` 时用它），**只读**复制到 `$DSH_HOME/github-trending/previews/<runId>.md`：路径必须在 `repo.path` 内（词法 + realpath 各判一次）、不超过 512 KB、sha256 与契约声明一致；失败不阻断运行，只是这次没有预览。
- 预览副本 0600、临时文件 + rename、最多保留 30 份；`state.json` / `history.json` 只存 `file` / `bytes` / `sha256` 元数据，不存正文。
- `GET /preview?id=<runId>` 只接受历史里出现过的 id、不接路径参数；返回 `{ text, truncated }`。客户端渲染 Markdown 子集（标题 / 段落 / 列表 / 引用 / 粗体 / 行内代码 / 链接 / 分隔线），**只生成 React 文本节点**，链接仅放行 http(s)，不渲染图片或原始 HTML；也可以切「原文」。
- 日报只列最近 30 天**有记录**的日期，每天一条；默认打开最近一期有预览的日报。失败 / 无变更 / 试跑 / 旧记录 / 副本被清理都有各自的空状态，不用示例内容兜底。
- 预览是运行结束时的派生副本：你在仓库里事后编辑 canonical 文件，不会改变这次记录。
- 关于入口在左轨底部：包名 / 版本 / GitHub 来自 `/state.plugin`（`repository` 由 `package.json` 规范化），仓库缺失时隐藏外链。

## 它需要什么 / 它访问哪里 / 它不上传什么

**需要什么**

- DSH `0.2.1-rc.3` 以上（`engines.dsh`），Node.js `^22.20.0 || >=24.0.0`（`.nvmrc` 钉 22 线；CI 与发布跑 22）
- 一个本地 **git 仓库**（提交目标）与可写的远端
- 模型：provider + 模型 ID + 密钥（或用宿主已配置的 provider；OAuth 类凭据不需要密钥）
- Git 与 GitHub 凭据（本机 `gh` 登录态 / PAT），仅 push 与开 PR 需要
- 核心二进制：首次运行从 `github.com/morehao/trendradar/releases` 下载（按 `os/arch`，sha256 校验后缓存）；之后离线复用。开发/排障时可用 `TRENDING_DIGEST_CORE`（或设置里的「核心路径」）指向一个可执行的 `trendradar`，此时完全不下载

**访问哪里**

- 本地核心进程（一次性的 `run` 子进程）
- `github.com/morehao/trendradar/releases`：仅首次运行（或点「下载核心」）时下载二进制与其 `checksums.txt`；之后不再联网
- 你配置的模型端点（由**核心**发起，插件不代发）
- `api.github.com`（由**核心**发起 push/PR；插件本身不发 GitHub 请求）
- 本机 `127.0.0.1` 上的临时回环代理（仅当宿主 provider 的凭据不可导出时，端口随机、一次性 token、运行结束即关闭）

**不上传什么**

- 不向作者控制的任何服务器发送数据；插件没有遥测、没有云端账号
- 不读取、不上传与你配置无关的仓库内容；核心只在目标仓库里写 `output.dir` 下的文件；插件唯一的仓库读取是运行成功后按清单复制当天 `.md` 预览副本（见上节），只读、不 commit、不改工作树
- 密钥与 token 只经 `ctx.credentials` 解析、只经运行时通道交给核心：**不写配置文件、不进日志、不进 argv**

## 配置

设置写在 `$DSH_HOME/github-trending/settings.json`（0600），**不含任何密钥**。

| 键 | 默认 | 说明 |
|---|---|---|
| `model.provider` | `deepseek` | `deepseek` / `openai-compatible`（以核心 `version --json` 的 `supportedProviders` 为准） |
| `model.mode` | `direct` | `direct` = 密钥直传核心；`proxy` = 本机回环代理转发宿主模型 |
| `model.baseURL` | 空 | 空则用 provider 默认端点；代理模式由插件注入 |
| `model.model` | 空 | 必填，不设隐式默认 |
| `model.apiKeyRef` | `TRENDING_MODEL_KEY` | 指向 `ctx.credentials` 的引用名 |
| `model.temperature` / `maxTokens` | `0.2` / `2048` | 单次调用参数 |
| `model.allowDegraded` | `true` | 模型失败时核心是否退回原文（会标记 degraded） |
| `repo.path` | 空 | 本地仓库绝对路径，必填 |
| `repo.baseBranch` | 读取仓库默认分支 | 只读展示，不允许手改（以 `origin/HEAD` 为准） |
| `repo.remote` | `origin` | 固定 `origin`，界面不展示 |
| `repo.commitMode` | `branch` | `branch`（分支 + PR）/ `direct` |
| `pr.enabled` / `autoMerge` | `true` / `true` | |
| `pr.titleTemplate` | `chore(trending): add {date} digest` | 默认规则，界面不展示 |
| `github.authMode` | `gh` | `gh`（本机 gh 登录态）/ `pat` |
| `github.tokenRef` | `GITHUB_TOKEN` | `ctx.credentials` 引用名（`pat` 用） |
| `trending.since` / `languages` / `topN` | `daily` / `all,typescript,python,go,rust` / `25` | 实际支持范围由核心决定 |
| `output.dir` | `trending` | 仓库内相对目录 |
| `schedule.enabled` / `time` / `timezone` | `true` / `08:30:00` / `Asia/Shanghai` | 插件自己的 60 s tick 驱动 |
| `corePath` | 空 | 等价于 `TRENDING_DIGEST_CORE`（仅开发/排障，界面不提供入口，用环境变量或直接改 `settings.json`；设了就完全不下载） |
| `coreAutoDownload` | `true` | 缓存缺失时是否自动下载核心；关掉后只报 `CORE_NOT_DOWNLOADED`，由你在设置页点「下载核心」 |

## 两个工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `trending_run` | `{ dryRun?: boolean, date?: string }` | 结构化摘要：文件数、commit/分支、PR、内容哈希、错误码与下一步 |
| `trending_history` | `{ limit?: number }` | 上次/下次运行、最近 N 条记录、核心版本、模型、未合并 PR |

工具名是稳定对外接口：**只新增不改名**。

## 错误码

| 码 | 含义 | 下一步 |
|---|---|---|
| `CORE_NOT_DOWNLOADED` | 核心还没下载（缓存为空，且自动下载被关或尚未触发） | 设置页点「下载核心」，或指向可执行的 `trendradar` |
| `CORE_CHECKSUM_MISMATCH` | 下载内容的 sha256 与 `checksums.txt` 不符（已被丢弃） | 重试；仍失败则手动下载放到缓存目录（代理可能改写内容） |
| `CORE_UNAVAILABLE` | 下载失败 / 版本还没发布（404）/ 平台不在矩阵 / 覆盖路径无效 | 按提示里的 URL 与发布顺序处理 |
| `CORE_INCOMPATIBLE` | 核心 `ipcSchema`/`digestSchema` 与插件不一致 | 升级插件（含平台包）到同一版本 |
| `CORE_TIMEOUT` / `CORE_CANCELLED` | 超时 / 用户取消 | 不提交任何状态，也留不下半成品 |
| `IPC_INVALID` | 核心 stdout 不是约定的结果信封 | 升级插件与核心 |
| `MODEL_KEY_MISSING` / `MODEL_UNAUTHORIZED` / `MODEL_NOT_FOUND` / `MODEL_RATE_LIMITED` | 模型侧 | 设置页「模型」区红字 + 重新选择 |
| `GIT_NOT_INSTALLED` / `REPO_NOT_GIT` / `REPO_DIRTY` | 本机 git / 仓库状态 | 装 git ≥ 2.30、换仓库、先提交改动 |
| `GIT_OPERATION_FAILED` | 核心执行 git 失败（含 push 被拒） | 核心对 `trending/` 日期分支只追加提交、普通 fast-forward 推送；被拒时自动 fetch + rebase 重试一次。若报 `stale info`：在仓库执行 `git fetch --prune origin` 后重试（升级核心后不再出现） |
| `GITHUB_AUTH` / `PUSH_FAILED` / `PR_FAILED` / `NOT_MERGEABLE` | 推送与 PR | 本地 commit 已保留，修好后重试即可复用 |
| `FETCH_FAILED` / `FETCH_RATE_LIMITED` | 抓取 | 检查网络/代理或稍后重试 |

核心只在 stderr 给出 `error: <CODE>: ...` 文本；插件优先取核心自己的码，取不到时按稳定文本特征归类，并在结果里标 `inferred: true`（界面会注明「错误码由插件推断」）。

运行结果还会带 `skipReason`（`merged` / `pr-closed` / `unchanged`）与 push 失败的 `reason`（`stale-lease` / `non-fast-forward` / `auth` / `protected` / `hook` / `pathspec`）。定时运行（`TRENDRADAR_TRIGGER=schedule`）尊重人工关闭的 PR，不重建分支；手动运行才会重开。

## 与本地 CLI 共存

- 插件**永远使用自带的平台包**，不从 `PATH` 解析核心
- 运行前探测 `PATH` 上的 `trendradar`，版本/协议不一致只**提示**，不切换、不接管它的 cron/launchd
- 首次可在设置页「从本机 CLI 导入」一次性导入非敏感字段；**密钥不导入**
- 别让两套定时同时开着：内容侧靠 `contentHash` 与 PR 复用兜底，模型消耗无法兜底

## 实现说明（0.3.0）

1. **结果信封**：核心 `run --config <path> --json` 输出契约 v2 `RunResult`（`ipcSchema=2`，可选 `branch/commit/prUrl/contentHash`）；插件只解析这一种形状，旧核心的 `runOutput` 不再兼容。
2. **密钥传输**：POSIX 上配置经 **FIFO** 交给核心（文件系统里不出现明文）；Windows 无 FIFO，退化为 0600 临时文件并在读完后立即删除。
3. **GitHub token** 经子进程环境变量传给核心（核心只认 `GITHUB_TOKEN`/`GH_TOKEN`）；不进 argv、不进配置、不进日志。
4. **调度**用插件自己的 60 s tick（宿主 `schedule` 是会话本地提醒，覆盖不到无人值守场景）。
5. **二进制改为下载**（2026-10-30 决策 B）：不再随包发 npm 平台分包。首次运行需要能访问 GitHub Release；断网环境请用 `TRENDING_DIGEST_CORE` 指向本地核心。核心版本由 `package.json` 的 `dsh.core.version` 固定（用 `node scripts/set-core-version.mjs <x.y.z>` 写入）。
6. **核心版本固定**：`package.json` 的 `dsh.core.version` 是首次运行下载哪个核心 Release 的唯一来源（用 `node scripts/set-core-version.mjs <x.y.z>` 写入）；下载失败会给出下载地址与错误码，不会退回旧内容。
7. **预览副本是派生数据**：不是第二份真相；仓库里的 canonical 文件才是。旧记录没有 `preview` 元数据，日报里只能看到对应的空状态，不承诺回填。

## 开发与发版

```bash
npm install
npm run check          # typecheck + 契约校验 + 构建 + 全部测试
node scripts/ac/run.mjs # AC-P-01…13 的机械部分
```

发版走 **tag 触发的 CI**（Trusted Publishing / OIDC，不需要 npm token）：合并 PR → 在 `main` 打注记 tag `vX.Y.Z` → CI 发 npm 并用注记正文建 Release。细节见 [docs/publishing.md](docs/publishing.md)。

- 契约来源：类型与校验器来自 npm 包 `@morehao/trendradar-contract`（`dependencies` 精确锁定；wire `ipcSchema=2` / `digestSchema=2`）；本地不再保留 `contract/` 快照与生成器；`npm run check:contract` 校验包版本与 wire 版本
- 核心下载与缓存：`src/core/release.ts`（`ensureCore`），缓存位置 `$DSH_HOME/github-trending/core/v<version>/`
- 宿主半 `src/`（tsup → `lib/`），客户端半 `client/`（esbuild → `client.js`，`window.__ModuleLoader__.load`）

## 许可

MIT
