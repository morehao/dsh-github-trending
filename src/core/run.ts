/**
 * 一次核心运行（FR-P-08 / AC-P-05 / AC-P-09）。
 *
 * 时序：建配置通道 → spawn `run --config <通道> --json` → 写入配置 → 收集 stdout/stderr
 * → 等退出 → 归一化结果。任何一步失败都不产生「半个成功」：
 * 只有拿到可解析的结果信封才返回 `ok: true`，否则返回带错误码的结果或抛 `IpcError`。
 */
import { spawn } from 'node:child_process';

import { toCoreConfig, toYaml, type Period, type Settings } from '../config.js';
import { classifyStderr, redact } from '../errors.js';
import {
  IpcError,
  parseRunResult,
  type RunError,
  type RunOutcome,
  type VersionInfo,
} from '../ipc.js';
import type { CoreLocation } from './locate.js';
import { openConfigChannel, removeChannelDir, type ChannelKind } from './channel.js';
import { sanitizedEnv } from './exec.js';

export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const MAX_STDOUT = 16 * 1024 * 1024;
const MAX_STDERR = 2 * 1024 * 1024;
/** 取消/超时后给核心多少时间体面退出，再 SIGKILL。 */
const KILL_GRACE_MS = 3000;

export interface RunCoreOptions {
  core: CoreLocation;
  version: VersionInfo;
  settings: Settings;
  /** 模型密钥；只进配置通道，不进 argv/env/日志。 */
  apiKey: string;
  /** GitHub token；核心只从 env 读（GITHUB_TOKEN/GH_TOKEN）。 */
  token?: string;
  date?: string;
  /** 本次运行的标的周期（daily|weekly|monthly）；核心 `--period` 覆盖抓取 since。 */
  period: Period;
  dryRun: boolean;
  /** 谁触发的运行：核心用它在定时运行时尊重「人工关闭的 PR」。 */
  trigger?: 'manual' | 'schedule';
  /** 回环代理地址：覆盖配置里的 model.baseURL（代理模式专用）。 */
  baseURLOverride?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStderr?: (line: string) => void;
  /** 已知明文，用于日志脱敏。 */
  secrets?: Array<string | undefined>;
}

export interface RunCoreResult {
  outcome: RunOutcome;
  channelKind: ChannelKind;
  stderr: string;
  exitCode: number | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** stderr → 结构化错误；`inferred` 表示码是插件按文本推出来的。 */
function errorFrom(stderr: string, exitCode: number | null): RunError {
  const classified = classifyStderr(stderr);
  return {
    code: classified.code,
    message: classified.message,
    retriable: classified.retriable,
    details: { inferred: classified.inferred, exitCode },
  };
}

export function buildCoreArgs(channelPath: string, options: { dryRun: boolean; date?: string; period?: Period }): string[] {
  const args = ['run', '--config', channelPath, '--json'];
  if (options.dryRun) args.push('--dry-run');
  if (options.date !== undefined && options.date !== '') args.push('--date', options.date);
  if (options.period !== undefined) args.push('--period', options.period);
  return args;
}

export async function runCore(options: RunCoreOptions): Promise<RunCoreResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const startedAt = nowIso();
  const started = Date.now();
  const channel = await openConfigChannel();
  const yaml = `${toYaml(toCoreConfig(options.settings, options.apiKey, options.baseURLOverride, options.period))}\n`;
  const secrets = [options.apiKey, options.token, ...(options.secrets ?? [])];

  const child = spawn(options.core.path, buildCoreArgs(channel.path, { dryRun: options.dryRun, date: options.date, period: options.period }), {
    env: sanitizedEnv(process.env, {
      GITHUB_TOKEN: options.token,
      GH_TOKEN: options.token,
      // 环境变量通道：旧核心会忽略它，不会因为多一个未知参数而失败。
      TRENDRADAR_TRIGGER: options.trigger ?? 'manual',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stdoutBytes = 0;
  let stderr = '';
  let timedOut = false;
  let aborted = false;
  let channelError: Error | undefined;

  // 配置写入在 spawn 之后：FIFO 的写端必须等读端打开。
  const publish = channel.publish(yaml).catch((error: unknown) => {
    channelError = error instanceof Error ? error : new Error(String(error));
  });

  const escalate = (): NodeJS.Timeout =>
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出
      }
    }, KILL_GRACE_MS);
  let escalations: NodeJS.Timeout[] = [];

  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGTERM');
    } catch {
      // 已退出
    }
    escalations.push(escalate());
  }, timeoutMs);

  const onAbort = (): void => {
    aborted = true;
    try {
      child.kill('SIGTERM');
    } catch {
      // 已退出
    }
    escalations.push(escalate());
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes <= MAX_STDOUT) stdout += chunk;
  });

  let stderrBuffer = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length < MAX_STDERR) stderr += chunk;
    stderrBuffer += chunk;
    let index = stderrBuffer.indexOf('\n');
    while (index >= 0) {
      const line = redact(stderrBuffer.slice(0, index), secrets);
      stderrBuffer = stderrBuffer.slice(index + 1);
      if (line.trim() !== '') options.onStderr?.(line);
      index = stderrBuffer.indexOf('\n');
    }
  });

  const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  }).catch((error: unknown) => {
    throw new IpcError('CORE_SPAWN_FAILED', `无法启动核心 ${options.core.path}：${error instanceof Error ? error.message : String(error)}`);
  });

  clearTimeout(timer);
  for (const handle of escalations) clearTimeout(handle);
  escalations = [];
  options.signal?.removeEventListener('abort', onAbort);
  if (stderrBuffer.trim() !== '') options.onStderr?.(redact(stderrBuffer, secrets));
  await publish;
  await channel.dispose();
  await removeChannelDir(channel);

  const finishedAt = nowIso();
  const durationMs = Date.now() - started;
  const tail = stderr.trim().split('\n').slice(-20).join('\n');

  if (aborted) {
    throw new IpcError('CORE_CANCELLED', '运行已取消：核心进程已终止，未提交任何状态');
  }
  if (timedOut) {
    throw new IpcError(
      'CORE_TIMEOUT',
      `核心运行超时（${Math.round(timeoutMs / 1000)} s）已终止${tail === '' ? '' : `；最后输出：${tail}`}`,
    );
  }
  if (channelError !== undefined) {
    throw new IpcError('CORE_CONFIG_CHANNEL_FAILED', `配置通道写入失败：${channelError.message}`);
  }
  if (stdoutBytes > MAX_STDOUT) {
    throw new IpcError('PAYLOAD_TOO_LARGE', `核心输出超过 ${MAX_STDOUT} 字节上限`);
  }

  const timing = { coreVersion: options.version.version, startedAt, finishedAt, durationMs, dryRun: options.dryRun };

  if (stdout.trim() === '') {
    if (closed.code === 0) {
      throw new IpcError('IPC_INVALID', '核心正常退出但没有输出结果信封');
    }
    return {
      outcome: { ok: false, skipped: false, files: [], warnings: [], error: errorFrom(stderr, closed.code), ...timing },
      channelKind: channel.kind,
      stderr,
      exitCode: closed.code,
    };
  }

  let outcome: RunOutcome;
  try {
    outcome = parseRunResult(stdout, timing);
  } catch (error) {
    if (closed.code !== 0) {
      return {
        outcome: { ok: false, skipped: false, files: [], warnings: [], error: errorFrom(stderr, closed.code), ...timing },
        channelKind: channel.kind,
        stderr,
        exitCode: closed.code,
      };
    }
    throw error;
  }

  if (closed.code !== 0) {
    return {
      outcome: { ...outcome, ok: false, error: errorFrom(stderr, closed.code) },
      channelKind: channel.kind,
      stderr,
      exitCode: closed.code,
    };
  }

  return { outcome, channelKind: channel.kind, stderr, exitCode: closed.code };
}
