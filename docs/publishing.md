# 发版手册（`@morehao/dsh-github-trending`）

> **一句话**：升版本走 PR → 合并后在 `main` 打**注记** tag → CI 用 OIDC（Trusted Publishing）发 npm → 用 tag 注记正文建 GitHub Release。全链路不需要长效 npm token，也不在本地发正式版。

## 链路

```
改 package.json.version → 分支 → PR → 合并 main
                                  │
                                  └─ git tag -a vX.Y.Z（正文＝变更说明）→ push
                                         ├─ .github/workflows/release.yml（name 必须等于文件名）
                                         │   ├─ npm run check（typecheck + 契约 + 构建 + 测试）
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

## 排障（2026-10-30 实测）

| 现象 | 真实原因 | 处理 |
|---|---|---|
| publish 步骤 `ENEEDAUTH`，npm 只让你 `npm login` | **OIDC 交换被拒**：该包没有 Trusted Publisher，registry 的交换端点回 `404 ... package not found`；npm 对所有 OIDC 失败都静默跳过，最后只报「没登录」 | 先建 TP（见上）；把 `NPM_CONFIG_LOGLEVEL=verbose` 打开才能看到 `oidc ... package not found` 这一行 |
| `npm trust` 看起来跑完了，但 TP 没生效 | 交互确认 `Do you want to proceed? (y/N)` **默认是 N**，回车即放弃（`EXIT=1`） | 加 `-y` 跳过确认，或明确输入 `y` |
| publish 成功（`PUT 202` + `+ pkg@ver`），但 `npm view` 看不到该版本 | registry 异步处理 + packument CDN 缓存，可能几分钟才可见；`dist-tags` 端点通常先更新 | 不要据此重发：用版本端点确认 — `curl -s -o /dev/null -w '%{http_code}' https://registry.npmjs.org/@scope%2fname/<version>`（200 = 已发布，且 `dist.attestations` 存在说明带 provenance） |
| publish 前 `npm ci` 报 `EALLOWREMOTE` | lockfile 的 `resolved` 指向了国内镜像 | `check:lockfile` 会拦；把 `registry.npmmirror.com` 换成 `registry.npmjs.org`（tarball 与 integrity 不变） |

重发不用新打 tag：本仓 `release.yml` 支持 `workflow_dispatch`（输入要发的 tag），`gh workflow run release.yml -f tag=vX.Y.Z` 即可；脚本对「已发布」是幂等跳过。

## 约束

- **不本地 `npm publish` 正式版**：本地没有 OIDC，只会落到 2FA 手工链路，且没有 provenance。
- 本地 `~/.npmrc` 若指向 npmmirror，所有查询命令都要显式 `--registry https://registry.npmjs.org`。
- 发布失败只能补发（tag 已推不可改）：先看 https://status.npmjs.org，再核对 Trusted Publisher，最后 `gh run rerun <run-id>`。
- **核心版本要一起看**：本包的 `dsh.core.version` 决定首次运行下载哪个 `trendradar` Release；它与 `contract/UPSTREAM.json` 的 `ref` 由 `scripts/sync-contract.mjs --ref vX.Y.Z` 同源写入，不要手改一处。
