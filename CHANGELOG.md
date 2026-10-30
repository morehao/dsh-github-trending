# Changelog

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
