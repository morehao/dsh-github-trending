# 发版手册（`@morehao/dsh-github-trending`）

> **一句话**：升版本走 PR → 合并后在 `main` 打**注记** tag → CI 用 OIDC（Trusted Publishing）发 npm → 用 tag 注记正文建 GitHub Release。全链路不需要长效 npm token，也不在本地发正式版。

## 环境前提（本地与 CI 的差异点）

| 项 | 值 | 说明 |
|---|---|---|
| Node | `^22.20.0 \|\| >=24.0.0`（`engines`） | `check.yml` 与 `release.yml` 都是 22；`.nvmrc` 钉 `22.23.3`。`>=24` 只做兼容放行（宿主 / 本机），不在 CI 覆盖 |
| npm（check job） | 10（Node 22 自带，CI 实测 10.9.9） | 脚本不能假设某个 npm 版本的输出格式：`npm pack --json` 在 npm 10 里会混进构建日志（`check-pack.mjs` 已按首尾括号截取） |
| npm（release job） | `npm@latest`（实测 12） | OIDC 发布要求 ≥ 11.5.1，所以 release 有一步 `npm install -g npm@latest` |
| runner | `ubuntu-24.04`（显式钉版本） | 不用 `ubuntu-latest`：发布失败只能补发，不该跟着镜像漂移 |
| actions | `checkout@v7` / `setup-node@v7` | v5 起跑在 node24；v7 不再注入 dummy `NODE_AUTH_TOKEN`，与 OIDC 更契合 |

> **Node 22 与日志噪音**：曾经的两条 CI warning（`Node.js 20 is deprecated`、`package-manager-cache`
> 非法输入）来自 `actions/checkout@v4` / `setup-node@v4`——v4 不认识该输入，等于「关依赖缓存」一直空转；
> 升到 v7 后消失，同一时期 v7 + Node 22 的兄弟仓日志是干净的。只有本机设了 `NODE_USE_ENV_PROXY=1` 时，
> 22 才会为每个子进程打 `UNDICI-EHPA` 实验性警告（24 不会），与 CI 无关。

## 链路

```
改 package.json.version → 分支 → PR → 合并 main
                                  │
                                  └─ git tag -a vX.Y.Z（正文＝变更说明）→ push
                                         ├─ .github/workflows/release.yml（name 必须等于文件名）
                                         │   ├─ npm run check（语法/类型/契约/构建/命名/打包/冒烟/单测/AC-P）
                                         │   ├─ tag 版本 == package.json.version（不等即拒发）
                                         │   ├─ 同版本已存在则跳过（幂等）
                                         │   ├─ OIDC → npm publish --provenance --access public
                                         │   └─ 发布成功后用注记正文建 Release（已存在则跳过）
                                         └─ 产物：npm 包（带 provenance）+ GitHub Release + Actions run
```

## 一次性基建：Trusted Publisher

包已存在（0.1.0 手工发布过），只需建立 OIDC 信任关系。两种做法，任选一种：

```bash
# A. 命令行（要 2FA 口令）
npm trust github @morehao/dsh-github-trending \
  --repo morehao/dsh-github-trending --file release.yml --allow-publish \
  --registry https://registry.npmjs.org

# B. 网页：https://www.npmjs.com/package/@morehao/dsh-github-trending/access
#    Provider=GitHub Actions；Owner=morehao；Repository=dsh-github-trending；
#    Workflow=release.yml；Allowed actions 勾上 `npm publish`（直接发布）
```

两个坑：

1. **Workflow 名必须等于 `release.yml`**（本仓 `.github/workflows/release.yml` 的 `name:` 已经是 `release.yml`），OIDC 的 workflow claim 与 npm 侧要精确匹配。
2. **Allowed actions 必须允许 `npm publish`**：2026-09-03 之后新建的 Trusted Publisher 默认只允许 `npm stage publish`，直接发布会以 permission denied 失败。

## 日常发版

1. 改 `package.json` 的 `version`（本仓根即包根），走分支 + PR + 合并。
2. 在 `main` 上打注记 tag（正文写变更说明，Release 会原样投影）：

   ```bash
   git switch main && git pull --ff-only
   git tag -a v0.1.2 -F notes.txt   # notes.txt 首行 `release: v0.1.2`，空行，然后正文
   git push origin v0.1.2
   ```

3. 看 CI：`gh run list --workflow release.yml --limit 1`；成功后确认包与 Release：

   ```bash
   npm view @morehao/dsh-github-trending@0.1.2 dist-tags version --registry https://registry.npmjs.org
   gh release view v0.1.2
   ```

## 发布后验证

```bash
# 1) 单版本端点最准（完整 packument 与 npm view 有 processing + CDN 缓存窗口）
curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/@morehao%2fdsh-github-trending/0.1.2   # 期望 200

# 2) 发布者与 provenance：_npmUser 应为 GitHub Actions，dist.attestations 非空
curl -s https://registry.npmjs.org/@morehao%2fdsh-github-trending/0.1.2 \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);
      console.log(j.dist.fileCount,'files',j.dist.unpackedSize,'bytes');
      console.log('npmUser',JSON.stringify(j._npmUser));
      console.log('attestations',Object.keys(j.dist.attestations||{}));})"

# 3) Release 正文与注记一致
gh release view v0.1.2 --json tagName,body --jq '{tag:.tagName,len:(.body|length)}'
```

> **processing 窗口（2–5 分钟）**：`+ pkg@ver` 已打印、CI 绿，但 `npm view` 仍 404 或 `dist-tags` 还是旧版本——这是 registry 异步处理，**不是失败**。不要重发、不要动 tag；用单版本端点轮询。

## 排障（2026-10-30 实测）

| 现象 | 真实原因 | 处理 |
|---|---|---|
| publish 步骤 `ENEEDAUTH`，npm 只让你 `npm login` | **OIDC 交换被拒**：该包没有 Trusted Publisher，registry 的交换端点回 `404 ... package not found`；npm 对所有 OIDC 失败都静默跳过，最后只报「没登录」 | 先建 TP（见上）；把 `NPM_CONFIG_LOGLEVEL=verbose` 打开才能看到 `oidc ... package not found` 这一行 |
| `npm trust` 看起来跑完了，但 TP 没生效 | 交互确认 `Do you want to proceed? (y/N)` **默认是 N**，回车即放弃（`EXIT=1`） | 加 `-y` 跳过确认，或明确输入 `y` |
| publish 成功（`PUT 202` + `+ pkg@ver`），但 `npm view` 看不到该版本 | registry 异步处理 + packument CDN 缓存，可能几分钟才可见；`dist-tags` 端点通常先更新 | 不要据此重发：用版本端点确认 — `curl -s -o /dev/null -w '%{http_code}' https://registry.npmjs.org/@scope%2fname/<version>`（200 = 已发布，且 `dist.attestations` 存在说明带 provenance） |
| publish 前 `npm ci` 报 `EALLOWREMOTE` | lockfile 的 `resolved` 指向了国内镜像 | `check:lockfile` 会拦；把 `registry.npmmirror.com` 换成 `registry.npmjs.org`（tarball 与 integrity 不变） |

重发不用新打 tag：本仓 `release.yml` 支持 `workflow_dispatch`（输入要发的 tag），`gh workflow run release.yml -f tag=vX.Y.Z` 即可；脚本对「已发布」是幂等跳过。

## CI 约定（改 workflow / package.json 前先看）

- **门禁只有一个入口**：`npm run check`，CI 与本地跑的是同一串脚本（`check.yml` 只有 `npm ci --ignore-scripts`、`bash -n`、`npm run check` 三步）。新增检查请加进 `check` 链，不要只在 YAML 里加一步——那样本地复现不了。
- **产物不入库**（`lib/`、`client.js`），由 `check` 里的 `npm run build` 现场构建；`npm ci --ignore-scripts` 与 `npm test --ignore-scripts` 是为了跳过 `prepare` / `pretest` 的重复构建。
- **publish 时的构建走 `prepack`**：不要改回 `prepublishOnly: npm run check`，那会让 release 里的 `npm run check` 再跑一遍（4 次构建 + 2 轮测试）。
- **`gh release create` 必须留在 `release.yml`**：git-kit 的 `/git-release` 预检靠 grep `.github/workflows` 判定 `EFFECT_RELEASE=workflow`，挪进 `scripts/` 会让它误判成「流程自己建 Release」。
- **`name:` 必须等于文件名**：`release.yml` 的 `name: release.yml`，与 Trusted Publisher 的 Workflow 字段精确匹配。

门禁清单（全部在 `npm run check` 里）：

| 步骤 | 脚本 | 拦什么 |
|---|---|---|
| 语法 | `check-syntax.mjs` | `scripts/`、`test/` 的 JS 语法；`locale/`、`contract/` 的 JSON 可解析性 |
| 类型（host） | `tsc --noEmit` | `src/**` 类型错误 |
| 类型（client） | `tsc -p tsconfig.client.json` | `client/**` 类型错误（bundle 冒烟兜不住的字段拼错） |
| lockfile | `check-lockfile.mjs` | `resolved` 指向 npmmirror → CI `EALLOWREMOTE`（只在发版暴露） |
| 契约 | `sync-contract.mjs --check` + `gen-ipc-types.mjs --check` | 快照哈希漂移、IPC 类型与 schema 不同步 |
| 构建 | `npm run build` | tsup / esbuild 失败 |
| 命名/接线 | `check-naming.mjs` | 包名 / patch `name` / `export const name` 三处漂移；`dsh.core` 与契约不同源；`exports`/`files` 漏项 |
| 打包白名单 | `check-pack.mjs` | tarball 混入 `.dsh/`、`src/`、`docs/`；缺 `lib/index.js`、`client.js`、契约或 locale |
| Release 正文 | `smoke-release-notes.mjs` | 投影与 git-kit 读回管道不一致；轻量 tag / 空正文被当成功 |
| 单测 | `npm test` | 72 个离线用例 |
| AC-P | `scripts/ac/run.mjs` | 11 条验收的机械部分（安装、密钥、幂等、取消、canonical…） |

## 约束

- **不本地 `npm publish` 正式版**：本地没有 OIDC，只会落到 2FA 手工链路，且没有 provenance。
- 本地 `~/.npmrc` 若指向 npmmirror，所有查询命令都要显式 `--registry https://registry.npmjs.org`。
- 发布失败只能补发（tag 已推不可改）：先看 https://status.npmjs.org，再核对 Trusted Publisher，最后 `gh run rerun <run-id>`。
- **核心版本要一起看**：本包的 `dsh.core.version` 决定首次运行下载哪个 `trendradar` Release；它与 `contract/UPSTREAM.json` 的 `ref` 由 `scripts/sync-contract.mjs --ref vX.Y.Z` 同源写入，不要手改一处。
- **本机与 CI 同一条 Node 线**：`.nvmrc` 钉 `22.23.3`，提交前 `fnm use && npm run check`。本机设了 `NODE_USE_ENV_PROXY=1` 时会看到 `UNDICI-EHPA` 噪音（22 的 undici 实验性特性），用 `env -u NODE_USE_ENV_PROXY npm run check` 可跑干净；CI 不设该变量。
