# 验证与发布（Agent）

> 读这篇的时机：提交前、改 CI / 脚本、改 `package.json` / `exports` / `files`、打包、发版。
> 人类向完整流程见 [发版手册](../publishing.md)；这里只给 agent 的检查矩阵与门禁。

## 1. 提交前验证矩阵

| 改动 | 必跑 | 说明 |
|---|---|---|
| `src/**` | `npm run check` | 105 个离线用例覆盖 config / runner / schedule / state / routes / ipc / contract / release / quickfill / client bundle |
| `client/**` | `npm run check` | `check:types`（`tsc -p tsconfig.client.json`）抓类型错误，`test/client-bundle.test.mjs` 用 React 存根跑 bundle 加载 |
| 契约依赖 / wire 版本 | `npm run check:contract` | 类型与校验器来自 npm 包 `@morehao/trendradar-contract`；升级只改依赖版本，不要手写/生成契约类型 |
| `package.json` / `exports` / `files` / 命名 | `node scripts/check-naming.mjs` + `node scripts/check-pack.mjs` | CI 也跑；`exports` 缺 `./client`、`files` 漏 `lib` 会导致「能装、页面白屏」 |
| `scripts/*.mjs` | `node --check <file>` + 对应冒烟 | `release-notes` 有自己的冒烟（`check:release-notes`） |
| `scripts/ac/**`、`test/**` | `node scripts/ac/run.mjs` | 机械部分必须全绿，人工步骤按输出提示走 |
| CI / release workflow | 本地跑对应脚本 + `bash -n scripts/ci-publish.sh` | 不要只改 YAML 不验证 |
| 纯文档 | 链接与事实核对 | 不跑代码检查 |

## 2. CI 实际跑什么（`check.yml`）

PR 与 push `main` 触发，**Node 22**，只按 lockfile 装依赖：

1. `npm ci --ignore-scripts`
2. `bash -n scripts/ci-publish.sh`
3. `npm run check` → 语法 → host 类型 → client 类型 → lockfile 注册表 → 契约包版本/wire → 构建 → 命名/接线 → 打包白名单 → Release 正文冒烟 → 单测 → AC-P

注意：

- **门禁只有一个入口**：新增检查加进 `check` 链，不要在 YAML 里多加一步（本地就复现不了）。
- **npm 版本两处不同**：check job 是 npm 10（Node 22 自带，CI 实测 10.9.9）、release 会 `npm install -g npm@latest`（12）。脚本不要依赖某个 npm 版本独有的输出格式（`npm pack --json` 在 npm 10 里会混日志，解析已兼容）。
- **产物（`lib/`、`client.js`）不入库**：由 `check` 里的 `npm run build` 现场构建；`--ignore-scripts` 是刻意跳过 `prepare` / `pretest` 的重复构建。
- 需要真实 GitHub 的动作（真实安装、真实 push）**不在 CI**，本地跑并如实说明。
- `runs-on` 写显式版本 `ubuntu-24.04`；actions 用 `checkout@v7` / `setup-node@v7`，且**不设 `registry-url`**（v7 移除了 dummy `NODE_AUTH_TOKEN` 兜底，registry 由 `ci-publish.sh` 显式指定）。

## 3. 打包与命名

- 白名单（[check-pack.mjs](../../scripts/check-pack.mjs)）允许：`package.json`、`README.md`、`CHANGELOG.md`、`LICENSE`、`cordis.patch.yml`、`icon.svg`、`client.js`、`lib/`、`locale/`；必备文件少一个就红。契约包是 `dependencies`，由 npm 安装，不进 tarball。
- 不允许：`.dsh/`、`docs/`、`scripts/`、`test/`、`src/`、`client/`、`node_modules`、`*.tgz`。
- 命名与接线（[check-naming.mjs](../../scripts/check-naming.mjs)）：
  - `package.json.name` == `cordis.patch.yml` 的 `insert[0].name`
  - `lib/index.ts` 的 `export const name` == `insert[0].id`
  - `dsh.core.{repo,version}` 合法，`version` 由 `scripts/set-core-version.mjs` 写入
  - `exports["."]` 与 `main` / `types` 一致，`./client` → `./client.js`
  - `files` 含 `lib` / `client.js` / `locale`
  - `publishConfig.access === "public"`

## 4. 发版清单

1. `package.json.version` 递增，走分支 + PR（`main` 不直推）。
2. `npm run check` 绿。
3. 合并后打**注记** tag（`git tag -a --cleanup=verbatim`，正文＝Release body），推送，看 `release.yml`。
4. 发布后按 [发版手册](../publishing.md) 的「发布后验证」核对单版本端点、`dist.attestations` 与 Release 正文。
