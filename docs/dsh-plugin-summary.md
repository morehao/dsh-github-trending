# dsh-github-trending 插件事项汇总

> 面向仓库读者的自包含摘要。详细设计文档（架构 ADR、插件规格、Go 侧设计）按约定放在 `.dsh/` 下、不入库；本文件可独立阅读。
>
> 仓库：`github.com/morehao/dsh-github-trending` ｜ 包名：`@morehao/dsh-github-trending` ｜ 上游产品：`github.com/morehao/trendradar`
>
> **实现状态（0.1.1）**：插件侧已落地（核心客户端、设置页、运行页、两个工具、调度、快速填充与回环代理、错误码、locale）。核心二进制改为 **GitHub Release 下载 + sha256 校验 + 本地缓存**（2026-10-30 决策 B，取消 npm 平台分包）；核心尚未打 tag 时明确报 `CORE_NOT_DOWNLOADED`/`CORE_UNAVAILABLE`。偏差集中列在 §14。

## 1. 它是什么

`trendradar` 的 **DSH 入口**。插件本身不生产内容：它收集配置、按时间触发、spawn 本地核心完成一次运行，然后把结果和错误展示出来。

**它不做**：抓取 GitHub Trending、解析 HTML、调用模型生成摘要、渲染内容、执行 git 提交与 PR——这些全部在 `trendradar` 二进制里。

一句话边界：**内容归核心，落库配置与展示归插件。**

## 2. 职责边界

| 能力 | `trendradar`（核心） | 本插件 |
|---|---|---|
| 抓取 / 解析 / 归一 / 排序去重 | ✅ 唯一实现 | ❌ |
| 提示词 / 模型校验 / 摘要缓存 | ✅ | ❌ |
| Markdown / JSON / 索引渲染 | ✅ | 只做字段映射（可选模板） |
| git 提交 / 分支 / push / PR / 合并 | ✅ | ❌（只传配置与 token） |
| 模型 provider 客户端 | ✅ | ❌（回环代理模式除外） |
| 配置页、调度、状态与历史展示 | ❌ | ✅ |
| GitHub Device Flow 认证 | ❌ | ✅ + `ctx.credentials` |
| 运行状态 | 无状态 | ✅ 单一写者 |

## 3. 页面结构

侧栏入口是导航行里的小图标 + 「GitHub 趋势」标签；点它进入工作台。工作台四个视图：

| 视图 | 内容 |
|---|---|
| 概览 | 下次运行 / 就绪检查（核心、模型、仓库、GitHub）/ 上次交付（状态、commit、PR、预览、阅读本期）/ 最近 7 天；运行中只显示开始时间、已用时、取消 |
| 日报 | 最近 30 天有记录的日期切换；渲染 / 原文；文件路径、大小、复制路径、PR；失败 / 无变更 / 试跑 / 旧记录 / 副本缺失各有空状态 |
| 运行记录 | 最近 30 条；筛选全部 / 失败 / 试跑；展开 commit / hash / branch / PR / warnings；只读日志抽屉；legacy 标记 |
| 设置 | 沿用 #13 的六个 tab（内容来源 / 模型 / 仓库 / 认证 / 榜单 / 调度）；「内容来源」只有状态与核心操作（重新检查 / 下载），其余 tab 逐 tab 保存 |

顶部第一行是插件身份条：名称 / 版本 / 完整包名（点击复制）/ GitHub 外链 / 检查更新（就地状态，有新版时显示「有新版本 vX」+「更新到 vX」）；第二行是横向主导航（概览 / 日报 / 运行记录 / 设置）＋右侧下次运行摘要与就绪 N/4；点版本号打开「关于」弹层（完整包名可复制、仓库外链、MIT、核心版本、运行环境）。主题跟随宿主 token；不实现原型的主题切换、URL hash 与示例徽标。

预览的数据边界：运行成功后 Host 只读核心本次 `outcome.files` 里的当天 `.md`，路径必须在 `repo.path` 内、≤512 KB、sha256 一致，才复制到 `$DSH_HOME/github-trending/previews/<runId>.md`（0600、上限 30）；`state.json` / `history.json` 只存元数据。`GET /preview?id=` 只接受历史里出现过的 id；客户端只渲染 Markdown 子集，链接仅 http(s)，不渲染 HTML / 图片。

插件自更新：顶部身份条的「检查更新」与「关于」弹层共用同一份状态，首次挂载静默检查 npm 最新版（Host 缓存 5 分钟）；确认后经宿主 `pluginManager` 重装插件（`link:` / `file:` / `workspace:` 安装只给手动命令），引擎来自共享包 `@morehao/dsh-plugin-kit`。


侧栏入口图标是趋势折线；不要把卡片塞进导航行（v0.1.4 曾因此占满侧栏）。

## 4. 两个工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `trending_run` | `{ dryRun?: boolean, date?: string }` | 结构化摘要：文件数、commit、PR、用量、错误码 |
| `trending_history` | — | 上次/下次运行、最近 N 条记录（时间、结果、耗时、commit/PR、错误码）、核心版本、模型、用量、未合并 PR |

工具名是稳定对外接口：**只新增不改名**。

## 5. 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `model.provider` | `deepseek` | `openai-compatible` / `deepseek` / `anthropic` |
| `model.baseURL` | 空 | 空则用 provider 默认端点或回环代理地址 |
| `model.model` | 空 | 必填，不设隐式默认 |
| `model.apiKeyRef` | `TRENDING_MODEL_KEY` | 指向 `ctx.credentials` 的引用名 |
| `model.temperature` / `model.maxTokens` | `0.2` / `2048` | 单次调用参数 |
| `repo.path` | 空 | 本地仓库绝对路径，必填 |
| `repo.baseBranch` | 读取仓库默认分支 | 只读展示，`origin/HEAD` 为准 |
| `repo.remote` | `origin` | 固定 origin，界面不展示 |
| `repo.commitMode` | `branch` | `branch`（分支 + PR）/ `direct` |
| `pr.enabled` | `true` | `commitMode=direct` 时忽略 |
| `pr.titleTemplate` | `chore(trending): add {date} digest` | 默认规则，界面不展示 |
| `pr.autoMerge` | `true` | |
| `pr.mergeMethod` | `squash` | `squash` / `merge` / `rebase` |
| `pr.deleteBranchAfterMerge` | `true` | |
| `github.authMode` | `gh` | `gh`（本机 gh 登录态）/ `pat` |
| `github.tokenRef` | `GITHUB_TOKEN` | `ctx.credentials` 引用名 |
| `trending.since` | `daily` | `daily` / `weekly` / `monthly`（单次运行周期，抓取窗口=标的周期） |
| `trending.languages` | `[all, typescript, python, go, rust]` | 支持范围由核心决定，插件只选择 |
| `trending.topN` | `25` | 上限；实际条数以核心解析结果为准 |
| `summary.enabled` | `true` | 关掉则只落原始字段 |
| `output.dir` | `trending` | 仓库内相对目录 |
| `output.json` | `true` | 是否同时写 JSON |
| `layout.mode` | `canonical` | 默认逐字节采用核心产出；`template` 只做字段映射 |
| `schedule.enabled` / `time` / `timezone` | `true` / `08:30:00` / `Asia/Shanghai` | 复用宿主 `schedule` 服务 |
| `schedule.periods` | `daily` | 定时自动产出的周期（日/周/月多选）：日=每天、周=周日、月=月末 |

> 已删除的配置项：`source.type`、`source.instanceUrl`（内容来源只剩本地二进制）、`core.path`（只保留 `TRENDING_DIGEST_CORE` 环境变量作为开发/排障逃逸口）。

## 6. 与核心的交互

- **一次性进程**：`spawn <core> run --json -`，stdin 写一个请求信封，stdout 读一个结果信封，跑完即退。无守护进程、无端口。
- **握手**：运行前执行 `version --json`，比对 `ipcSchema` / `digestSchema`（均为 2）与 `contractVersion` 主版本（0）；不匹配报 `CORE_INCOMPATIBLE`，不做尽力兼容。
- **定位顺序**：`TRENDING_DIGEST_CORE`（或设置里的核心路径，仅开发/排障）→ 本地缓存 → 从 GitHub Release 下载（`checksums.txt` 校验 sha256 后缓存）；都不行报 `CORE_NOT_DOWNLOADED`/`CORE_UNAVAILABLE`。
- **凭据**：模型密钥与 GitHub token 只经 stdin 传入；不落盘、不进 argv、不进日志。
- **取消**：用户取消或超时 → 终止进程；未收到结果信封视为失败，不提交任何状态。
- **stdout 纪律**：只允许一个结果信封；核心日志走 stderr。
- **契约来源**：类型与 ajv 校验器来自独立 npm 包 `@morehao/trendradar-contract`（`dependencies` 精确锁定；wire `ipcSchema=2` / `digestSchema=2`）。插件只解析契约 v2 `RunResult`；旧核心的 `runOutput` 不再兼容。CI 的 `check:contract` 校验包版本、wire 版本与 fixtures。

## 7. 错误码映射

| 核心错误码 | 插件展示位置 |
|---|---|
| `MODEL_UNAUTHORIZED` / `MODEL_NOT_FOUND` / `MODEL_TIMEOUT` | 设置页「模型」区红字 + 重新选择模型 |
| `REPO_NOT_GIT` / `REPO_DIRTY` / `GIT_NOT_INSTALLED` | 设置页「归档仓库」区 |
| `GITHUB_AUTH` | 设置页「GitHub 认证」区 |
| `PUSH_FAILED` / `PR_FAILED` / `NOT_MERGEABLE` | 运行页错误卡 + 保留本地 commit |
| `CORE_UNAVAILABLE` / `CORE_INCOMPATIBLE` | 全局提示 + 安装/升级指引 |
| `FETCH_FAILED` / `PARSE_EMPTY` / `RATE_LIMITED` | 运行页错误卡（可重试） |

## 8. 与本地已装 CLI 共存

用户可能先装了 `trendradar` CLI。插件对此的立场是**只看不用**：

- 插件**永远使用自带的平台包**，不从 PATH 解析核心；PATH 上的 CLI 不参与运行。
- 运行前探测 PATH 上的 `trendradar` 并读 `version --json`；版本或协议不一致只**提示**，不切换、不阻塞。
- **不接管**用户已有的 cron / launchd / systemd 任务；只提示「两套定时同时开会重复抓取与重复消耗模型」。
- **不共享配置与状态**：首次上手可一次性导入 CLI 的非敏感字段（provider / 端点 / 模型 / 仓库 / PR / 版式），**密钥不导入**，导入后两侧独立演进。
- 产出 frontmatter 与历史记录带 `coreVersion`；跨版本产出时标注差异。

## 9. 首次上手

三步：**选仓库**（不是 git 仓库直接报 `REPO_NOT_GIT`，不替你 init）→ **填模型**（可一键沿用 DSH 已配置的 provider 与凭据；OAuth 类 provider 走回环代理，不需要密钥）→ **试跑一次**（dryRun 只抓取与渲染、不提交）。

## 10. 状态与幂等

- 插件是唯一状态写者：`~/.dsh/...` 下保存 `{ lastRunAt, lastDigest{date,contentHash,coreVersion}, lastResult, pendingPr }` 与最近 30 条记录。
- 幂等以核心返回的 `contentHash` 为准：同日同内容 → `skipped=true`，零新增 commit、不重复开 PR。核心 `v0.2.0` 起幂等键还包含 `output.dir`（只改目录会重渲染，而不是被误判为“同内容”）。
- **运行日期按 `schedule.timezone` 计算**并显式以 `--date` 传给核心，避免宿主机时区与调度时区不一致时跑错日期/分支。
- **同日重跑由核心处理**：`trending/` 日期分支只追加提交、普通 fast-forward 推送；open PR 会被更新，closed PR 在手动运行下重建并新开、定时运行则跳过，merged 直接 skip。插件不再拦截同日重跑。
- **pendingPr 对账**：`/state` 只读核对 `pendingPr`（`open/merged/closed`），已合并/已关闭的陈旧记录自动清理，避免界面/工具长期显示已关闭的 PR。
- **推送失败信息保真**：核心多行 stderr（含 `! [rejected] ... (non-fast-forward)`）会完整带回，不再只截首行；对应错误码给可执行提示（如被他人抢先推送时先 fetch/rebase）。
- 核心自身无状态：上次状态随请求传入，新状态随结果返回。

## 11. 安全与隐私

- 密钥与 token 只存 `ctx.credentials`，运行时解析、经 FIFO（POSIX）或 0600 临时文件（Windows，读完即删）交给核心；不写配置文件、不进日志、不进 argv。
- 只与三类目标通信：本地核心进程、用户配置的模型端点、`api.github.com`。**不向作者控制的任何服务器发送数据**。
- 回环代理（OAuth 类 provider）只监听 `127.0.0.1`，随机端口、一次性 token，随运行结束关闭。
- 预览副本：只读核心本次 `outcome.files` 里的当天 `.md`，路径必须在 `repo.path` 内（词法 + realpath）、≤512 KB、sha256 与契约一致；复制到插件数据目录，不写用户仓库、不 commit、不改工作树。读取失败不阻断运行。

## 12. 市场合规

- 发布到公共 npm，`publishConfig.access: public`；`files` 包含 host 入口、客户端 bundle、`cordis.patch.yml`、locales、icon。
- `engines.dsh` 与 `peerDependencies` 对齐宿主版本区间；`dsh.bundle.patch` 指向 `cordis.patch.yml`。
- README 必须披露：首次运行从 GitHub Release 下载核心二进制（sha256 校验）；运行时访问用户配置的模型端点与 `api.github.com`；不上传用户仓库信息。

## 13. 验收清单

| 编号 | 验收项 |
|---|---|
| AC-P-01 | 干净 profile 一条命令安装并出现设置页 |
| AC-P-02 | 三步内跑出第一份内容 |
| AC-P-03 | 快速填充在三种认证形态下各可用一次 |
| AC-P-04 | 密钥不泄漏（日志、导出、git diff 三处 grep 全空） |
| AC-P-05 | 同日幂等：第二次运行 0 新增 commit |
| AC-P-06 | 核心不可用：报 `CORE_UNAVAILABLE`，目标目录无新文件 |
| AC-P-07 | 版本不匹配：报 `CORE_INCOMPATIBLE` 且不运行 |
| AC-P-08 | 模型不可用：报 `MODEL_*`，无文件写入 |
| AC-P-09 | 取消：无半成品、无状态提交、无残留进程 |
| AC-P-10 | 默认版式下与核心产出逐字节一致 |
| AC-P-11 | 核心解析顺序：未设环境变量走平台包，设了优先用它 |
| AC-P-12 | 首次导入：非敏感字段正确落位，密钥未被导入 |
| AC-P-13 | 共存检测：PATH 有不兼容 CLI 时提示，本次仍用平台包 |

## 14. 未决与后续

| 项 | 状态 |
|---|---|
| 回环代理（OAuth 类 provider 复用宿主模型） | 0.1.0 已实现（`127.0.0.1` + 随机端口 + 一次性 token + 运行结束关闭） |
| `serve` 与 Web 前端（产品侧） | 二期，插件不消费 |
| 插件 locale 元数据 | 0.1.0 已实现：`locale/zh.json`、`locale/en.json`，`exports`/`files` 含 `./locale/*.json` |
| `GIT_NOT_INSTALLED` 映射 | 0.1.0 已补进插件错误码表（落点：仓库区） |
| 包名调整 | 已决定不改：`@morehao/dsh-github-trending` |
| 契约 npm 包接入 | 0.3.0 引入 `@morehao/trendradar-contract@0.2.0`，删除本地 `contract/` 快照与生成器；`npm run check:contract` 校验包版本/wire |

### 实现层偏差（0.1.0，均已写进 README「已知偏差」）

| 偏差 | 原因 | 影响 |
|---|---|---|
| 用 `run --config <path> --json`，而非 stdin 信封 | 契约 `RunRequest` 的 `configPath` 是核心读取配置的入口 | 核心输出契约 v2 `RunResult`，插件只解析这一种形状 |
| 配置经 FIFO 传入（Windows：0600 临时文件） | 核心只接受 `--config <path>`，而配置必须带 `apiKey` | POSIX 上明文不落盘；Windows 有短暂临时文件并立即删除 |
| GitHub token 走子进程环境变量 | 核心只从 `GITHUB_TOKEN`/`GH_TOKEN` 读 | 不进 argv、不进配置、不进日志 |
| 调度用插件自有 60 s tick | 宿主 `ctx.schedule`（rc.5）是**会话本地**提醒，需要 sessionId，冷会话不投递 | 无人值守可跑；不依赖会话 |
| 只支持 canonical 版式 | 核心自己落盘，插件重渲染会破坏「内容唯一实现」 | `template` 留待二期，设置页不暴露假开关 |
| 二进制改由 Release 下载 | 六个 npm 平台包不划算（决策 B） | 首次运行联网下载 + 校验；缓存后离线；可用 `TRENDING_DIGEST_CORE` 完全绕过 |

## 15. 相关文档

| 文档 | 位置 | 是否入库 |
|---|---|---|
| 架构 ADR（边界、D-01…D-14） | `.dsh/docs/specs/2026-10-30-trendradar-architecture-adr.md` | 否 |
| 插件入口规格（FR/AC/交互） | `.dsh/docs/specs/2026-10-30-dsh-github-trending-plugin-spec.md` | 否 |
| Go 侧设计 | 见 `trendradar` 仓库 `.dsh/docs/specs/` | 否 |
| Go 侧执行计划 | `trendradar` 仓库 `.dsh/docs/plans/` | 否 |
| 本汇总 | `docs/dsh-plugin-summary.md` | 是 |
