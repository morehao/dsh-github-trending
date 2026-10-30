# AGENTS.md

> 给在本仓工作的 AI agent。人类向说明见 [README](README.md) 与 [docs/](docs/)；本文件只放**每次都必须遵守**的硬约束与任务路由。命中具体任务时再读对应文档，不要一次全读。

## 1. 项目速览

- 包：`@morehao/dsh-github-trending`，DeepSeek Harness（dsh）插件；**仓库根即包根**，无 workspace、无子包目录。
- 两个 half：Host（源码 `src/**`，tsup 编译到 `lib/`）与 Web Client（源码 `client/**`，esbuild 打包到根 `client.js`，`window.__ModuleLoader__` bundle）。
- **内容生产全在外部 `trendradar` 核心**：插件只做配置 / 调度 / spawn / 展示，不做抓取、解析、渲染、git 与 PR。核心产出按 canonical 原样落地，插件不改写、不二次调用模型。
- 纯 ESM；宿主能力（`@deepseek-ai/dsh-tools`）走 **`peerDependencies`**，不进 `dependencies`、不打包。
- Node `^22.20.0 || >=24.0.0`（`.nvmrc` 钉 22；CI 与发布跑 22）。发布：注记 tag `vX.Y.Z` → GitHub Actions OIDC → npm。
- 产物 `lib/`、`client.js` **不入库**，由 `npm run build` 生成（`prepack` 自动触发）；`contract/` 是上游契约快照（`sync-contract` 生成），也不手改。

| 路径 | 作用 |
|---|---|
| [src/index.ts](src/index.ts) | `export const name`、`inject = ['webServer']`、`apply()` 装配（状态 → 设置/运行器/调度 → 路由 → 工具） |
| [src/config.ts](src/config.ts) | `settings.json` ⇄ 核心 YAML 的**唯一映射**；`normalizeSettings` / `validateSettings` |
| [src/state.ts](src/state.ts) | `state.json` / `history.json` / `runs/*.log` 的**唯一写者**；原子写、0600、历史上限 30 |
| [src/paths.ts](src/paths.ts) | 落盘位置：`$DSH_HOME/github-trending/`（`TRENDING_DIGEST_HOME` 可覆盖） |
| [src/tools.ts](src/tools.ts) | 两个稳定对外工具 `trending_run` / `trending_history` |
| [src/errors.ts](src/errors.ts) | 错误码表、分类、用户提示、stderr 文本 → 码的归一化、`redact()` |
| [src/ipc.ts](src/ipc.ts) · [src/ipc.gen.ts](src/ipc.gen.ts) | 契约类型 + 运行时守卫；`ipc.gen.ts` 由 `gen-ipc-types` 生成 |
| [src/host/routes.ts](src/host/routes.ts) | HTTP 面 `/api/morehao/github-trending/*`，自定义头鉴权、`no-store` |
| [src/host/runner.ts](src/host/runner.ts) | 一次运行的**唯一入口**：校验 → 定位 → 握手 → 取密钥/起代理 → spawn → 记状态；拒绝并发 |
| [src/host/schedule.ts](src/host/schedule.ts) | 60 s tick、IANA 时区判当日、6 h 补跑、同日不重复 |
| [src/host/core.ts](src/host/core.ts) · [src/core/locate.ts](src/core/locate.ts) · [src/core/release.ts](src/core/release.ts) | 核心定位 / 版本检查 / Release 下载 + sha256 + 缓存 |
| [src/host/credentials.ts](src/host/credentials.ts) · [src/host/quickfill.ts](src/host/quickfill.ts) · [src/host/proxy.ts](src/host/proxy.ts) | 凭据解析、宿主 provider 快速填充、OAuth 类凭据的回环代理 |
| [src/core/exec.ts](src/core/exec.ts) · [src/core/channel.ts](src/core/channel.ts) · [src/core/handshake.ts](src/core/handshake.ts) · [src/core/run.ts](src/core/run.ts) | 子进程封装、配置通道（FIFO）、握手、运行 |
| [client/](client/) | Web Client：`index` / `settings` / `runs` / `panel-icon` / `store` / `api` / `i18n` / `ui` / `styles` |
| [contract/](contract/) | 上游契约快照（schema + fixtures + `UPSTREAM.json` + `CONTRACT.sha256`），**生成物** |
| [scripts/sync-contract.mjs](scripts/sync-contract.mjs) · [scripts/gen-ipc-types.mjs](scripts/gen-ipc-types.mjs) | 契约同步 / 校验、IPC 类型生成 |
| [scripts/ac/run.mjs](scripts/ac/run.mjs) | AC-P-01…13 的机械部分（人工步骤打印在末尾） |
| [test/](test/) | `node --test` 离线用例；`test/fixtures/fake-core.mjs` 是假核心 |
| [docs/](docs/) | 人类向文档（发版手册、插件摘要）+ `docs/agents/` 任务手册 |
| `.dsh/` | 本地过程文档（specs / plans / notes），已 gitignore；**不是权威来源** |

## 2. 硬约束

### 数据边界

- **状态唯一写者**：`state.json` / `history.json` / `runs/<id>.log` 只由 [src/state.ts](src/state.ts) 写；一律「临时文件 + rename」、权限 0600，不允许其他模块直接 `writeFileSync`。设置只有两个写入口：`/config`（用户确认后落盘）与启动时用 bundle 的 `config.corePath` 填空（仅当为空），其余不静默补写。
- **插件不碰用户仓库**：commit / push / PR / merge 全在核心进程里完成；插件只传配置与凭据，不自己写仓库。唯一例外是设置页读取仓库默认分支时执行的**只读** `git symbolic-ref` / `rev-parse`（[src/host/repo.ts](src/host/repo.ts)），不 commit、不改工作树。测试里用临时 repo，不碰真实仓库。
- **不翻译语义**：`src/config.ts` 是设置⇄核心 YAML 的唯一映射；核心没有的字段插件里也不加（宁可少一个开关，也不造「点了没反应」的配置）。新增字段必须同时有核心侧依据。
- **核心版本同源**：`package.json` 的 `dsh.core.{repo,version}` 与 `contract/UPSTREAM.json` 的 `repo`/`ref` 由 `sync-contract` 同源写入，**禁止手改一处**；`check:naming` 会拦。
- **单运行并发**：所有触发（HTTP 路由、工具、定时器）都必须走 `Runner.run()`；它自己拒绝第二个并发运行，绕过它就等于绕过取消与状态记录。

### 外部进程与安全

- **子进程只走 [src/core/exec.ts](src/core/exec.ts)**：环境变量按白名单清洗，不继承全部 `process.env`；不拼 shell、不把用户输入拼进命令行。
- **密钥不落盘、不进 argv、不进日志**：`settings.json` 只存 `apiKeyRef`（引用名）；配置经 FIFO（POSIX）或 0600 临时文件（Windows，读完即删）交给核心；GitHub token 只经子进程环境变量传；所有对外文本先过 `redact()`。
- **回环代理**只绑 `127.0.0.1`、随机端口、一次性 token，生命周期与单次运行绑定（`finally` 里关闭并断言端口释放）。
- **HTTP 面**：一律要求自定义头 `x-dsh-github-trending: 1`（顺带挡跨源）、响应 `no-store`；任何路由都不返回密钥明文，只返回「已配置 / 来源」。
- 客户端只允许 `require('react')`；**不碰文件、不碰核心**，所有数据来自 Host 的 `/api/morehao/github-trending/*`。

### 测试与环境

- 测试必须**离线**：临时 `HOME` / `DSH_HOME` / `TRENDING_DIGEST_HOME`，核心一律用 `test/fixtures/fake-core.mjs`；**禁止**读写真实 `~/.dsh`、真实仓库或真实网络。
- 新逻辑先想「怎么在不联网、不碰真目录的前提下断言」，再落代码；网络分支（Release 下载、模型调用）用 stub/fixture 覆盖。
- 破坏性操作（真实运行、下载核心、提交/推送、`npm publish`、打 tag）先征得用户确认。
- AC-P 机械部分（`node scripts/ac/run.mjs`）必须全绿；覆盖不到的人工步骤（真实安装、界面走查）如实验证并在 PR 里说明，不要声称已自动化。

### 源码与产物

- `lib/`、`client.js` 是生成物：**不入库、不手改**；改 `src/**` 或 `client/**` 后跑 `npm run build`。
- `src/ipc.gen.ts`、`contract/**` 也是生成物：改契约走 `sync-contract` / `gen-ipc-types`，不要手改，`check:contract` 会拦。
- 文案：`client/i18n.ts` 的 zh / en 键集合与占位符必须一一对应（`checkI18n()` + `test/client-i18n.test.mjs` 兜底）；新增文案两份一起加。
- 错误码是**对外契约**：新增码要同时进 `PLUGIN_CODES` 与分类/提示（`errors.ts`）；码与 `message` 会直接展示在运行页与历史表，改名等于改用户可见文案，已有码不要改名。
- 工具名 `trending_run` / `trending_history` 是稳定接口：一旦发布不再改名，需要新能力就新增工具。

### 包与发布

- 三处命名一致：`package.json.name` = `cordis.patch.yml` 的 `insert[0].name`；`src/index.ts` 的 `export const name` = `insert[0].id`；`publishConfig.access = "public"`（`check:naming` 兜底）。
- 打包只含白名单（`lib/`、`client.js`、`contract/`、`locale/`、`cordis.patch.yml`、`icon.svg`、`README.md`、`CHANGELOG.md`、`LICENSE`）；新增顶层目录前先想清楚是否该入包（`check:pack` 会拦）。
- 发布链路语义不要改：`release.yml` 的 `name:` 必须等于文件名；`gh release create` 必须留在该文件（git-kit `/git-release` 靠它判定后效）；构建走 `prepack`，不要改回 `prepublishOnly: npm run check`。
- workflow 用 `actions/checkout@v7` + `actions/setup-node@v7`、`runs-on: ubuntu-24.04`、`node-version: '22'`、显式 `package-manager-cache: false`；发布 job 要 `id-token: write`，且**不要**设 `NODE_AUTH_TOKEN`（会盖掉 OIDC）。
- `main` 不直推；升版本也走分支 + PR，tag 打在合并后的 `main`，去掉 `v` 必须等于 `package.json.version`。

### 文档

- `.dsh/docs/` 是本地过程文档：可读可写，但**不要把结论只留在那里**——确定的契约与约定要落回 `README.md` / `docs/`。
- 子文档与代码/脚本冲突时以代码与脚本为准，并顺手修正文档。

## 3. 常用命令

| 目的 | 命令 |
|---|---|
| 安装依赖 | `npm install` |
| 全量门禁（唯一入口；含构建、单测、AC-P） | `npm run check` |
| 只跑 host / client 类型 | `npm run typecheck` / `npm run check:types` |
| 只跑契约校验 | `npm run check:contract` |
| 只跑单测（会先 `pretest` 构建） | `npm test` |
| 只跑 AC-P 机械检查（需先 build） | `node scripts/ac/run.mjs` |
| 构建两个 half | `npm run build` |
| 三处命名 / 打包白名单 | `npm run check:naming` / `npm run check:pack` |
| Release 正文投影冒烟 | `npm run check:release-notes` |
| 发布脚本语法 | `bash -n scripts/ci-publish.sh` |
| 用本地核心排障 | `TRENDING_DIGEST_CORE=/path/to/trendradar` |

## 4. 任务路由

| 你要改 | 先读 | 必跑 |
|---|---|---|
| 运行编排 / 调度 / 路由 | 对应模块头注释 + 相关 `test/*.test.mjs` | `npm run check` |
| 设置字段 / 核心 YAML 映射 | `src/config.ts` + 核心 `config.ModelConfig` | `npm run check` + `check:naming`（版本同源） |
| 前端设置页 / 运行页 | `client/index.ts` + `test/client-i18n.test.mjs` / `client-bundle.test.mjs` | `npm run check`（含 client 类型与 bundle 冒烟） |
| 契约 / 升级核心版本 | `scripts/sync-contract.mjs` 头注释 | `npm run check:contract` + `check:naming` |
| 错误码 / 文案 | `src/errors.ts` + `client/i18n.ts` | `npm run check` |
| CI / 发版 / 打包 | [docs/publishing.md](docs/publishing.md) · [docs/agents/verification-release.md](docs/agents/verification-release.md) | `npm run check` + `bash -n scripts/ci-publish.sh` |
| 纯文档 | 对应人类文档 | 链接与事实核对，不跑代码检查 |

## 5. 完成定义

- [ ] `npm run check` 通过（含 72 个单测与 AC-P 11 条）。
- [ ] 改了 `src/**` / `client/**`：`git status` 里不出现 `lib/`、`client.js`（已 gitignore）。
- [ ] 改了契约或核心版本：`check:contract` 与 `check:naming` 通过，`dsh.core` 未手改。
- [ ] 改了 `package.json` / `exports` / `files` / 命名 / CI：`check:naming`、`check:pack` 通过。
- [ ] 行为或契约变更同步 `README.md` / `docs/`（按影响面，不机械全改）。
- [ ] `git status` / `git diff --stat` 无 `.dsh/`、`node_modules`、`*.tgz` 等意外文件。
- [ ] 需要确认的操作（真实运行、下载核心、push、tag、publish）已确认；提交不在 `main` 上。

## 6. 本地验证界面改动

`npm run build` 后把工作树装进 profile（`dsh plugin --profile <profile> add "link:$PWD"`），**完全退出宿主再重开**（⌘Q）验证设置页 / 运行页，结束后立刻装回 npm 版并删除 link——`link:` 不允许留在 profile 里。完整步骤与回退校验见 `dsh-skills-console` 的 `docs/development.md` §5。

## 7. 文档地图

| 层 | 位置 | 用途 |
|---|---|---|
| Agent 常驻约束 | `AGENTS.md` | 每次会话 |
| Agent 任务手册 | [docs/agents/verification-release.md](docs/agents/verification-release.md) | 提交 / 改 CI / 发版时 |
| 人类文档 | [README.md](README.md) · [docs/](docs/) | 安装使用、架构摘要、发版手册 |
| 上游契约来源 | [contract/UPSTREAM.json](contract/UPSTREAM.json) · `github.com/morehao/trendradar` | schema / fixtures 的权威来源；升级只能走 `sync-contract` |
| 本地过程 | `.dsh/docs/{specs,plans,notes}/` | 设计、计划、排查记录，gitignored |
