# AGENTS.md

> 给在本仓工作的 AI agent。人类向说明见 [README](README.md) 与 [docs/](docs/)；本文件只放**每次都必须遵守**的硬约束与任务路由。命中具体任务时再读对应文档，不要一次全读。

## 1. 项目速览

- 包：`@morehao/dsh-github-trending`，DeepSeek Harness（dsh）插件；**仓库根即包根**，无 workspace、无子包目录。
- 两个 half：Host（源码 `src/**`，tsup/esbuild 编译到 `lib/`）与 Web Client（源码 `client/**`，esbuild 打包到根 `client.js`，`window.__ModuleLoader__` bundle）。
- 纯 ESM；宿主能力（`@deepseek-ai/dsh-tools`）走 **`peerDependencies`**，不进 `dependencies`、不打包。
- **产物 `lib/`、`client.js` 不入库**，由 `npm run build` 生成（`prepack` 自动触发）；`contract/` 是上游契约快照（`sync-contract` 生成），也不手改。
- 内容生产全部在外部 `trendradar` 核心：插件只做配置 / 调度 / spawn / 展示，不改写核心产出（canonical）。
- 发布：注记 tag `vX.Y.Z` → GitHub Actions OIDC → npm → 用注记正文建 GitHub Release。

## 2. 硬约束

- **不在 `main` 上直接提交**：先 `git switch -c <type>/<topic>`，走 PR。
- **提交前必须 `npm run check` 通过**（CI 的唯一门禁入口，含 AC-P）。Node 用 `.nvmrc` 的 22 对齐 CI（`fnm use`）；本机若设了 `NODE_USE_ENV_PROXY=1`，22 会刷 `UNDICI-EHPA` 警告，用 `env -u NODE_USE_ENV_PROXY npm run check` 跑干净。
- **不要绕开 `check` 链**：新增检查加进 `package.json` 的 `check`，不要在 workflow 里单独加一步（本地会复现不了）。
- **不要手改生成物**：`src/ipc.gen.ts`、`contract/**`、`lib/**`、`client.js` 都由脚本产出。
- **发布链路不要改语义**：`release.yml` 的 `name:` 必须等于 `release.yml`；`gh release create` 必须留在这个文件里（git-kit `/git-release` 靠 grep 判定）；构建走 `prepack`，不要改回 `prepublishOnly: npm run check`。
- **过程性文档**放 `.dsh/docs/{specs,plans,notes}/`，整个 `.dsh/` 已在 `.gitignore`。

## 3. 任务路由

| 任务 | 先读 | 验证 |
|---|---|---|
| 改 Host 逻辑 / 路由 / 调度 | [docs/dsh-plugin-summary.md](docs/dsh-plugin-summary.md) | `npm run check` |
| 改前端 / 设置页 / 运行页 | `client/**` + `docs/` 对应节 | `npm run check`（含 client 类型与 bundle 冒烟） |
| 改契约 / 升级核心版本 | `scripts/sync-contract.mjs` 头注释 | `npm run check:contract` + `check:naming`（`dsh.core` 与 `UPSTREAM.json` 同源） |
| 改 CI / 发版 / 打包 | [docs/publishing.md](docs/publishing.md) · [docs/agents/verification-release.md](docs/agents/verification-release.md) | `npm run check` + `bash -n scripts/ci-publish.sh` |
| 排查运行问题 | `docs/publishing.md` 排障表 · `.dsh/docs/notes/` | 复现步骤写到 notes |

## 4. 常用命令

```bash
npm run check            # 唯一门禁：语法/类型/契约/构建/命名/打包/冒烟/单测/AC-P
npm run typecheck        # 只跑 host 类型
npm run check:types      # 只跑 client 类型
node scripts/ac/run.mjs  # 只跑 AC-P（需先 build）
npm run build            # tsup + client bundle
```
