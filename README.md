# dsh-github-trending

> GitHub 趋势日报的 **DSH 入口**：每天定时 spawn 本地 [`trendradar`](https://github.com/morehao/trendradar) 核心，抓取 Trending、生成中文简介与当日总结，提交到你自己的仓库并自动合并 PR。

**状态：0.1.0。** 插件侧（配置、调度、核心调用、状态与界面、两个工具）已完成；核心的平台二进制包（`@morehao/trendradar-core-*`）尚未发布，安装后运行会明确报 `CORE_UNAVAILABLE` 并给出修复指引——不会写空文件，也不会退回旧内容。

## 它做什么

- 按你设定的时间（IANA 时区）每天跑一次；也可以在设置页或侧栏卡片点「立即运行」
- 一次运行 = **spawn 一次本地核心**：抓取 → 模型总结 → 渲染 → commit → push → PR → 合并，全部由核心完成
- 插件只负责：收集配置、调度、传配置与密钥、展示结果与错误、记录最近 30 次运行
- 内容按核心产出的成品**原样**落地（canonical），插件不改写、不重排、不二次调用模型

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

## 它需要什么 / 它访问哪里 / 它不上传什么

**需要什么**

- DSH `0.2.1-rc.3` 以上（`engines.dsh`），Node.js ≥ 22.20
- 一个本地 **git 仓库**（提交目标）与可写的远端
- 模型：provider + 模型 ID + 密钥（或用宿主已配置的 provider；OAuth 类凭据不需要密钥）
- Git 与 GitHub 凭据（PAT / Device Flow / 本机 `gh`），仅 push 与开 PR 需要
- 核心二进制：随插件通过 `optionalDependencies` 获取的平台包（`@morehao/trendradar-core-<os>-<cpu>`）；开发/排障时可用环境变量 `TRENDING_DIGEST_CORE` 指向一个可执行的 `trendradar`

**访问哪里**

- 本地核心进程（一次性的 `run` 子进程）
- 你配置的模型端点（由**核心**发起，插件不代发）
- `api.github.com`（由**核心**发起 push/PR；插件本身不发 GitHub 请求）
- 本机 `127.0.0.1` 上的临时回环代理（仅当宿主 provider 的凭据不可导出时，端口随机、一次性 token、运行结束即关闭）

**不上传什么**

- 不向作者控制的任何服务器发送数据；插件没有遥测、没有云端账号
- 不读取、不上传与你配置无关的仓库内容；核心只在目标仓库里写 `output.dir` 下的文件
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
| `repo.baseBranch` / `remote` | `main` / `origin` | |
| `repo.commitMode` | `branch` | `branch`（分支 + PR）/ `direct` |
| `pr.enabled` / `autoMerge` / `titleTemplate` | `true` / `true` / `chore(trending): add {date} digest` | |
| `github.authMode` | `device` | `device` / `pat` / `gh` |
| `github.tokenRef` | `GITHUB_TOKEN` | `ctx.credentials` 引用名 |
| `trending.since` / `languages` / `topN` | `daily` / `all,typescript,python,go,rust` / `25` | 实际支持范围由核心决定 |
| `output.dir` | `trending` | 仓库内相对目录 |
| `schedule.enabled` / `time` / `timezone` | `true` / `08:30:00` / `Asia/Shanghai` | 插件自己的 60 s tick 驱动 |
| `corePath` | 空 | 等价于 `TRENDING_DIGEST_CORE`（仅开发/排障） |

## 两个工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `trending_run` | `{ dryRun?: boolean, date?: string }` | 结构化摘要：文件数、commit/分支、PR、内容哈希、错误码与下一步 |
| `trending_history` | `{ limit?: number }` | 上次/下次运行、最近 N 条记录、核心版本、模型、未合并 PR |

工具名是稳定对外接口：**只新增不改名**。

## 错误码

| 码 | 含义 | 下一步 |
|---|---|---|
| `CORE_UNAVAILABLE` | 找不到核心（平台包缺失 / `TRENDING_DIGEST_CORE` 无效） | 重装插件，或指向可执行的 `trendradar` |
| `CORE_INCOMPATIBLE` | 核心 `ipcSchema`/`digestSchema` 与插件不一致 | 升级插件（含平台包）到同一版本 |
| `CORE_TIMEOUT` / `CORE_CANCELLED` | 超时 / 用户取消 | 不提交任何状态，也留不下半成品 |
| `IPC_INVALID` | 核心 stdout 不是约定的结果信封 | 升级插件与核心 |
| `MODEL_KEY_MISSING` / `MODEL_UNAUTHORIZED` / `MODEL_NOT_FOUND` / `MODEL_RATE_LIMITED` | 模型侧 | 设置页「模型」区红字 + 重新选择 |
| `GIT_NOT_INSTALLED` / `REPO_NOT_GIT` / `REPO_DIRTY` | 本机 git / 仓库状态 | 装 git ≥ 2.30、换仓库、先提交改动 |
| `GITHUB_AUTH` / `PUSH_FAILED` / `PR_FAILED` / `NOT_MERGEABLE` | 推送与 PR | 本地 commit 已保留，修好后重试即可复用 |
| `FETCH_FAILED` / `FETCH_RATE_LIMITED` | 抓取 | 检查网络/代理或稍后重试 |

核心只在 stderr 给出 `error: <CODE>: ...` 文本；插件优先取核心自己的码，取不到时按稳定文本特征归类，并在结果里标 `inferred: true`（界面会注明「错误码由插件推断」）。

## 与本地 CLI 共存

- 插件**永远使用自带的平台包**，不从 `PATH` 解析核心
- 运行前探测 `PATH` 上的 `trendradar`，版本/协议不一致只**提示**，不切换、不接管它的 cron/launchd
- 首次可在设置页「从本机 CLI 导入」一次性导入非敏感字段；**密钥不导入**
- 别让两套定时同时开着：内容侧靠 `contentHash` 与 PR 复用兜底，模型消耗无法兜底

## 已知偏差（0.1.0）

1. **核心尚无 stdin 信封**：核心当前的 `run` 只接受 `--config <path> --json`，插件据此传配置；`ok/startedAt/error.code` 形状的 `RunResult` 已兼容，核心补上后插件无需改。
2. **密钥传输**：POSIX 上配置经 **FIFO** 交给核心（文件系统里不出现明文）；Windows 无 FIFO，退化为 0600 临时文件并在读完后立即删除。
3. **GitHub token** 经子进程环境变量传给核心（核心只认 `GITHUB_TOKEN`/`GH_TOKEN`）；不进 argv、不进配置、不进日志。
4. **调度**用插件自己的 60 s tick（宿主 `schedule` 是会话本地提醒，覆盖不到无人值守场景）。
5. **平台包未发布**：`@morehao/trendradar-core-<os>-<cpu>` 404 期间，运行会明确报 `CORE_UNAVAILABLE`；发布顺序是先核心包、后插件。

## 开发

```bash
npm install
npm run check          # typecheck + 契约校验 + 构建 + 全部测试
node scripts/ac/run.mjs # AC-P-01…13 的机械部分
```

- 契约快照：`contract/`（schema + fixtures + `UPSTREAM.json`），由 `node scripts/sync-contract.mjs --ref <sha>` 从核心仓库同步；`npm run check:contract` 校验哈希与生成类型
- 宿主半 `src/`（tsup → `lib/`），客户端半 `client/`（esbuild → `client.js`，`window.__ModuleLoader__.load`）

## 许可

MIT
