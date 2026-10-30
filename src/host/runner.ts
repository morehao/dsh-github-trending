/**
 * 一次运行的编排：校验 → 定位 → 握手 → 取密钥/起代理 → spawn 核心 → 记状态。
 *
 * 这里是「谁在跑」的唯一入口：HTTP 路由、工具、定时器都走 `Runner.run()`，
 * 因此同一时刻最多一个运行（`Runner` 自己拒绝并发第二个）。
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import type { Settings } from '../config.js';
import { validateSettings } from '../config.js';
import { areaOf, hintOf, redact } from '../errors.js';
import { IpcError, type RunOutcome } from '../ipc.js';
import { handshake, type HandshakeResult } from '../core/handshake.js';
import { locateCore } from '../core/locate.js';
import { runCore } from '../core/run.js';
import { newRunId, type RunRecord, type Store } from '../state.js';
import { inspectCore, type CoreStatus } from './core.js';
import { credentialServices, resolveGithubToken } from './credentials.js';
import { resolveModelKey } from './quickfill.js';
import { startProxy, type ProxyHandle } from './proxy.js';

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
  prUrl?: string;
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

    const id = newRunId();
    const controller = new AbortController();
    const startedAt = new Date().toISOString();
    this.active = { id, controller, startedAt };
    const logFile = store.newLogPath(id);
    const dryRun = options.dryRun === true;
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
        apiKey: modelKey.apiKey ?? '',
        ...(github.token === undefined ? {} : { token: github.token }),
        ...(options.date === undefined ? {} : { date: options.date }),
        dryRun,
        ...(baseURLOverride === undefined ? {} : { baseURLOverride }),
        signal: controller.signal,
        secrets: [modelKey.apiKey, github.token],
        onStderr: (line) => store.appendLog(logFile, line),
      });
      const outcome: RunOutcome = result.outcome;
      const summary = this.summarize({
        id,
        outcome,
        dryRun,
        ...(options.date === undefined ? {} : { date: options.date }),
        logFile,
        channel: result.channelKind,
        proxy: proxy !== undefined,
        coreSource: core.source,
        ...(core.tag === undefined ? {} : { coreTag: core.tag }),
      });
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
        ...(options.date === undefined ? {} : { date: options.date }),
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
        : {
            code: outcome.error.code,
            message: redact(outcome.error.message),
            hint: hintOf(outcome.error.code),
            area: areaOf(outcome.error.code),
            retriable: outcome.error.retriable,
            inferred: outcome.error.details?.inferred === true,
          };
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
      error: { code, message, hint: hintOf(code), area: areaOf(code), retriable: false },
      warnings: [],
      logFile: input.logFile,
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
      ...(summary.contentHash === undefined ? {} : { contentHash: summary.contentHash }),
      ...(summary.branch === undefined ? {} : { branch: summary.branch }),
      ...(summary.prUrl === undefined ? {} : { prUrl: summary.prUrl }),
      coreVersion: summary.coreVersion,
      model: { provider: settings.model.provider, model: settings.model.model },
      languages: settings.trending.languages,
      warnings: summary.warnings,
      logFile: summary.logFile,
    };
    const state = store.readState();
    const next: Parameters<Store['recordRun']>[1] = {
      lastRunAt: record.at,
      ...(summary.ok && summary.prUrl !== undefined ? { pendingPr: { url: summary.prUrl, createdAt: record.at } } : {}),
      ...(summary.ok && !summary.skipped && summary.contentHash !== undefined
        ? {
            lastDigest: {
              date: summary.date ?? new Date().toISOString().slice(0, 10),
              contentHash: summary.contentHash,
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
