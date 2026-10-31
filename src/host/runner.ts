/**
 * 一次运行的编排：校验 → 定位 → 握手 → 取密钥/起代理 → spawn 核心 → 记状态。
 *
 * 这里是「谁在跑」的唯一入口：HTTP 路由、工具、定时器都走 `Runner.run()`，
 * 因此同一时刻最多一个运行（`Runner` 自己拒绝并发第二个）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import type { Settings } from '../config.js';
import { validateSettings } from '../config.js';
import { areaOf, hintOf, redact } from '../errors.js';
import { IpcError, type RunOutcome } from '../ipc.js';
import { handshake, type HandshakeResult } from '../core/handshake.js';
import { locateCore } from '../core/locate.js';
import { runCore } from '../core/run.js';
import {
  CONTENT_HASH_ALGO_V2,
  newRunId,
  PREVIEW_MAX_BYTES,
  type PreviewMeta,
  type RunRecord,
  type Store,
} from '../state.js';
import { inspectCore, type CoreStatus } from './core.js';
import { credentialServices, resolveGithubToken } from './credentials.js';
import { resolveModelKey } from './quickfill.js';
import { startProxy, type ProxyHandle } from './proxy.js';
import { zonedDateString } from './schedule.js';

export interface RunSummary {
  id: string;
  ok: boolean;
  skipped: boolean;
  dryRun: boolean;
  date?: string;
  durationMs: number;
  coreVersion: string;
  files: number;
  contentHash?: string;
  branch?: string;
  commit?: string;
  prUrl?: string;
  preview?: PreviewMeta;
  error?: { code: string; message: string; hint: string; area: string; retriable: boolean; inferred?: boolean };
  warnings: string[];
  logFile?: string;
  channel?: 'fifo' | 'tmpfile';
  proxy?: boolean;
  /** 核心从哪来：env/settings 覆盖、缓存、还是本次下载。 */
  coreSource?: 'settings' | 'env' | 'cache' | 'download';
  coreTag?: string;
}

export interface RunRequestOptions {
  dryRun?: boolean;
  date?: string;
  trigger: 'manual' | 'schedule' | 'tool';
}

export interface RunnerDeps {
  store: Store;
  get: (name: string) => unknown;
  env?: NodeJS.ProcessEnv;
  /** 运行结束（成功或失败）后回调，用于刷新调度/界面缓存。 */
  onFinished?: (summary: RunSummary) => void;
  /** 预览副本这类「可失败但不阻断运行」的事件走这里，不写进 warnings。 */
  logger?: (event: string, data?: Record<string, unknown>) => void;
}

function repoProblem(repoPath: string): { code: string; message: string } | undefined {
  if (repoPath.trim() === '') return { code: 'CONFIG_INVALID', message: '还没有选择归档仓库' };
  if (!existsSync(repoPath)) return { code: 'REPO_NOT_GIT', message: `目录不存在：${repoPath}` };
  try {
    if (!statSync(repoPath).isDirectory()) return { code: 'REPO_NOT_GIT', message: `不是目录：${repoPath}` };
  } catch {
    return { code: 'REPO_NOT_GIT', message: `无法访问：${repoPath}` };
  }
  if (!existsSync(path.join(repoPath, '.git'))) {
    return { code: 'REPO_NOT_GIT', message: `不是 git 仓库：${repoPath}（插件不会替你 git init）` };
  }
  return undefined;
}

/**
 * 运行用哪一天：默认按调度时区算「今天」，而不是宿主机本地日期。
 * 核心 `run` 的 `--date` 默认取机器本地日期；宿主机时区与调度时区不一致时
 * 会生成错误日期/分支名，所以这里显式算好再透传。
 */
function runDate(settings: Settings, now: Date = new Date()): string {
  try {
    return zonedDateString(now, settings.schedule.timezone);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** target 是否严格位于 root 目录内（root 自身不算）。 */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 契约 artifact 的 sha256 可能带 `sha256:` 前缀、大小写不一；统一成小写 hex 再比。 */
function normalizeSha256(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const hex = value.trim().replace(/^sha256:/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
}

export class Runner {
  private active: { id: string; controller: AbortController; startedAt: string } | undefined;
  private readonly deps: RunnerDeps;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  get running(): { id: string; startedAt: string } | undefined {
    return this.active === undefined ? undefined : { id: this.active.id, startedAt: this.active.startedAt };
  }

  cancel(): boolean {
    if (this.active === undefined) return false;
    this.active.controller.abort();
    return true;
  }

  async run(options: RunRequestOptions): Promise<RunSummary> {
    const env = this.deps.env ?? process.env;
    const store = this.deps.store;
    const settings = store.readSettings();
    const credentials = credentialServices(this.deps.get);

    if (this.active !== undefined) {
      throw new IpcError('CONFIG_INVALID', `已有一次运行在进行中（${this.active.id}），请先等待或取消`);
    }

    const problems = validateSettings(settings);
    if (problems.length > 0) {
      const first = problems[0];
      throw new IpcError(first?.code ?? 'CONFIG_INVALID', `配置不完整：${first?.message ?? '未知问题'}`);
    }
    const repoIssue = repoProblem(settings.repo.path);
    if (repoIssue !== undefined) throw new IpcError(repoIssue.code, repoIssue.message);

    const dryRun = options.dryRun === true;
    const date = options.date !== undefined && options.date !== '' ? options.date : runDate(settings);

    const id = newRunId();
    const controller = new AbortController();
    const startedAt = new Date().toISOString();
    this.active = { id, controller, startedAt };
    const logFile = store.newLogPath(id);
    const startedMs = Date.now();
    let proxy: ProxyHandle | undefined;

    try {
      const core = await locateCore({ settings, env, allowDownload: settings.coreAutoDownload });
      if (core.downloaded === true) {
        store.appendLog(logFile, `[core] 已下载核心 ${core.tag ?? ''} → ${core.path}`);
      }
      const handshakeResult: HandshakeResult = await handshake(core, { signal: controller.signal });
      if (!handshakeResult.supportedProviders.includes(settings.model.provider)) {
        throw new IpcError(
          'MODEL_PROVIDER_UNSUPPORTED',
          `核心不支持 provider「${settings.model.provider}」；可用：${handshakeResult.supportedProviders.join(' / ')}`,
        );
      }

      const modelKey = await resolveModelKey(settings, credentials, env);
      if (modelKey.mode === 'direct' && (modelKey.apiKey === undefined || modelKey.apiKey === '')) {
        throw new IpcError('MODEL_KEY_MISSING', `没有解析到模型密钥（引用 ${settings.model.apiKeyRef}）`);
      }
      // The key actually handed to the core. In proxy mode this is replaced by
      // the loopback proxy's one-time token (see below) so the core makes a real
      // request instead of silently degrading to its offline fallback model.
      let apiKey = modelKey.apiKey ?? '';

      let baseURLOverride: string | undefined;
      if (modelKey.mode === 'proxy') {
        const llm = this.deps.get('llm') as { stream?: unknown } | undefined;
        if (llm === undefined || typeof llm.stream !== 'function') {
          throw new IpcError('MODEL_KEY_MISSING', '该模型需要回环代理，但宿主没有可用的 ctx.llm 服务');
        }
        proxy = await startProxy({
          llm: llm as unknown as Parameters<typeof startProxy>[0]['llm'],
          provider: settings.model.hostProvider !== '' ? settings.model.hostProvider : settings.model.provider,
          model: settings.model.model,
          temperature: settings.model.temperature,
          maxTokens: settings.model.maxTokens,
          timeoutMs: 120_000,
        });
        baseURLOverride = proxy.url;
        // A non-empty key is REQUIRED: the core (gllm) treats an empty key as
        // "no credentials" and falls back to a fake model when allowDegraded is
        // on, never hitting the proxy. Use the proxy token — the proxy accepts
        // `Authorization: Bearer <token>` and forwards with the host's real
        // credentials. Without this, summaries silently degrade to English.
        apiKey = proxy.token;
        store.appendLog(
          logFile,
          `[proxy] 回环代理已启动：127.0.0.1:${proxy.port}（一次性 token，运行结束即关闭）`,
        );
      }

      const github = await resolveGithubToken(credentials, settings.github.authMode, settings.github.tokenRef, { env });
      if (github.token === undefined) {
        store.appendLog(logFile, '[github] 未找到 token：push/PR 会失败并返回 GITHUB_AUTH（dryRun 不受影响）');
      }

      const result = await runCore({
        core,
        version: handshakeResult.version,
        settings,
        apiKey,
        ...(github.token === undefined ? {} : { token: github.token }),
        date,
        dryRun,
        ...(baseURLOverride === undefined ? {} : { baseURLOverride }),
        signal: controller.signal,
        secrets: [apiKey, github.token],
        onStderr: (line) => store.appendLog(logFile, line),
      });
      const outcome: RunOutcome = result.outcome;
      const summary = this.summarize({
        id,
        outcome,
        dryRun,
        date,
        logFile,
        channel: result.channelKind,
        proxy: proxy !== undefined,
        coreSource: core.source,
        ...(core.tag === undefined ? {} : { coreTag: core.tag }),
      });
      const preview = this.capturePreview({
        id,
        date,
        settings,
        outcome,
        secrets: [apiKey, github.token],
      });
      if (preview !== undefined) summary.preview = preview;
      this.record(summary, settings);
      return summary;
    } catch (error) {
      const cancelled = controller.signal.aborted || (error instanceof IpcError && error.code === 'CORE_CANCELLED');
      const summary = this.failureSummary({
        id,
        error: cancelled && !(error instanceof IpcError && error.code === 'CORE_CANCELLED')
          ? new IpcError('CORE_CANCELLED', '运行已取消：核心进程已终止，未提交任何状态')
          : error,
        dryRun,
        date,
        logFile,
        durationMs: Date.now() - startedMs,
      });
      this.record(summary, settings);
      return summary;
    } finally {
      if (proxy !== undefined) {
        const port = proxy.port;
        await proxy.close().catch(() => undefined);
        this.deps.store.appendLog(logFile, `[proxy] 已关闭 127.0.0.1:${port}`);
      }
      this.active = undefined;
    }
  }

  private summarize(input: {
    id: string;
    outcome: RunOutcome;
    dryRun: boolean;
    date?: string;
    logFile: string;
    channel?: 'fifo' | 'tmpfile';
    proxy: boolean;
    coreSource?: RunSummary['coreSource'];
    coreTag?: string;
  }): RunSummary {
    const { outcome } = input;
    const error =
      outcome.error === undefined
        ? undefined
        : (() => {
            const message = redact(outcome.error.message);
            return {
              code: outcome.error.code,
              message,
              hint: hintOf(outcome.error.code, message),
              area: areaOf(outcome.error.code),
              retriable: outcome.error.retriable,
              inferred: outcome.error.details?.inferred === true,
            };
          })();
    return {
      id: input.id,
      ok: outcome.ok,
      skipped: outcome.skipped,
      dryRun: input.dryRun,
      ...(input.date === undefined ? {} : { date: input.date }),
      durationMs: outcome.durationMs,
      coreVersion: outcome.coreVersion,
      files: outcome.files.length,
      ...(outcome.contentHash === undefined ? {} : { contentHash: outcome.contentHash }),
      ...(outcome.branch === undefined ? {} : { branch: outcome.branch }),
      ...(outcome.commit === undefined ? {} : { commit: outcome.commit }),
      ...(outcome.prUrl === undefined ? {} : { prUrl: outcome.prUrl }),
      ...(error === undefined ? {} : { error }),
      warnings: outcome.warnings,
      logFile: input.logFile,
      ...(input.channel === undefined ? {} : { channel: input.channel }),
      proxy: input.proxy,
      ...(input.coreSource === undefined ? {} : { coreSource: input.coreSource }),
      ...(input.coreTag === undefined ? {} : { coreTag: input.coreTag }),
    };
  }

  private failureSummary(input: { id: string; error: unknown; dryRun: boolean; date?: string; logFile: string; durationMs?: number }): RunSummary {
    const code = input.error instanceof IpcError ? input.error.code : 'INTERNAL';
    const message = redact(input.error instanceof Error ? input.error.message : String(input.error));
    return {
      id: input.id,
      ok: false,
      skipped: false,
      dryRun: input.dryRun,
      ...(input.date === undefined ? {} : { date: input.date }),
      durationMs: input.durationMs ?? 0,
      coreVersion: '',
      files: 0,
      error: { code, message, hint: hintOf(code, message), area: areaOf(code), retriable: false },
      warnings: [],
      logFile: input.logFile,
    };
  }

  /**
   * 从本次核心返回的 artifact 清单里选当天的 `.md`，只读复制到 previews/。
   *
   * 这是插件**唯一**读取用户仓库的场景，而且只读核心自己刚写出的那一份：
   * - 路径必须在 `repo.path` 内（词法 + realpath 各判一次，挡 `..`/绝对路径/符号链接）；
   * - 上限 512 KB、拒绝 NUL、sha256 必须与契约声明一致；
   * - 任何一步失败都只记日志，返回 undefined；运行结果不受影响。
   */
  private capturePreview(input: {
    id: string;
    date?: string;
    settings: Settings;
    outcome: RunOutcome;
    secrets: Array<string | undefined>;
  }): PreviewMeta | undefined {
    const { outcome, settings, date, id } = input;
    if (!outcome.ok || outcome.dryRun || outcome.skipped || date === undefined) return undefined;
    const skip = (reason: string, extra: Record<string, unknown> = {}): undefined => {
      this.deps.logger?.('preview.skip', { id, reason, ...extra });
      return undefined;
    };

    const markdown = outcome.files.filter((file) => {
      const ext = path.extname(file.path).toLowerCase();
      return ext === '.md' && path.basename(file.path).toLowerCase() !== 'readme.md';
    });
    if (markdown.length === 0) return skip('no-markdown');

    const dated = markdown.filter((file) => path.basename(file.path) === `${date}.md`);
    const chosen = dated.length > 0 ? dated[0] : markdown.length === 1 ? markdown[0] : undefined;
    if (chosen === undefined) return skip('ambiguous', { candidates: markdown.length });

    const repoPath = settings.repo.path;
    const resolved = path.resolve(repoPath, chosen.path);
    if (!isInside(repoPath, resolved)) return skip('outside-repo', { path: chosen.path });

    // realpath：如果用户仓库或目标文件本身是软链接，词法检查不够。
    let fileReal: string;
    try {
      const repoReal = realpathSync(repoPath);
      fileReal = realpathSync(resolved);
      if (!isInside(repoReal, fileReal)) return skip('symlink-outside-repo', { path: chosen.path });
    } catch {
      return skip('missing-file', { path: chosen.path });
    }

    let buffer: Buffer;
    try {
      const stat = statSync(fileReal);
      if (!stat.isFile()) return skip('not-a-file', { path: chosen.path });
      if (stat.size > PREVIEW_MAX_BYTES) return skip('too-large', { bytes: stat.size });
      buffer = readFileSync(fileReal);
    } catch {
      return skip('read-failed', { path: chosen.path });
    }
    if (buffer.includes(0)) return skip('contains-nul', { path: chosen.path });

    const declared = normalizeSha256(chosen.sha256);
    const actual = createHash('sha256').update(buffer).digest('hex');
    if (declared === undefined || declared !== actual) {
      return skip('sha-mismatch', { path: chosen.path, declared: declared ?? null, actual });
    }

    const text = redact(buffer.toString('utf8'), input.secrets);
    const stored = Buffer.from(text, 'utf8');
    try {
      this.deps.store.writePreview(id, text);
    } catch {
      return skip('write-failed', { path: chosen.path });
    }
    return {
      file: path.relative(repoPath, resolved).split(path.sep).join('/'),
      bytes: stored.length,
      sha256: createHash('sha256').update(stored).digest('hex'),
    };
  }

  /** 写历史与状态；同一天的 skipped 运行不覆盖 lastDigest。 */
  private record(summary: RunSummary, settings: Settings): void {
    const store = this.deps.store;
    const record: RunRecord = {
      id: summary.id,
      at: new Date().toISOString(),
      kind: summary.dryRun ? 'dry-run' : 'run',
      ok: summary.ok,
      skipped: summary.skipped,
      ...(summary.error === undefined ? {} : { errorCode: summary.error.code, errorMessage: summary.error.message }),
      durationMs: summary.durationMs,
      files: summary.files,
      ...(summary.date === undefined ? {} : { date: summary.date }),
      ...(summary.contentHash === undefined ? {} : { contentHash: summary.contentHash }),
      ...(summary.branch === undefined ? {} : { branch: summary.branch }),
      ...(summary.commit === undefined ? {} : { commit: summary.commit }),
      ...(summary.prUrl === undefined ? {} : { prUrl: summary.prUrl }),
      ...(summary.preview === undefined ? {} : { preview: summary.preview }),
      coreVersion: summary.coreVersion,
      model: { provider: settings.model.provider, model: settings.model.model },
      languages: settings.trending.languages,
      warnings: summary.warnings,
      logFile: summary.logFile,
    };
    const state = store.readState();
    const next: Parameters<Store['recordRun']>[1] = {
      lastRunAt: record.at,
      ...(summary.ok && summary.prUrl !== undefined
        ? { pendingPr: { url: summary.prUrl, createdAt: record.at, ...(summary.date === undefined ? {} : { date: summary.date }) } }
        : {}),
      ...(summary.ok && !summary.skipped && summary.contentHash !== undefined
        ? {
            lastDigest: {
              date: summary.date ?? new Date().toISOString().slice(0, 10),
              contentHash: summary.contentHash,
              contentHashAlgo: CONTENT_HASH_ALGO_V2,
              coreVersion: summary.coreVersion,
            },
            ...(state.pendingPr !== undefined && summary.prUrl === undefined ? { pendingPr: state.pendingPr } : {}),
          }
        : {}),
    };
    store.recordRun(record, next);
    this.deps.onFinished?.(summary);
  }

  /** 给设置页/工具用的「核心现在什么状态」。 */
  async coreStatus(fresh = false): Promise<CoreStatus> {
    const settings = this.deps.store.readSettings();
    return inspectCore(settings, { env: this.deps.env ?? process.env, fresh });
  }
}
