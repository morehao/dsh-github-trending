/**
 * 契约类型与运行时守卫。
 *
 * 类型来自 `contract/schema/ipc.v1.json` 的生成物（`ipc.gen.ts`）；本文件只放
 * 契约没有、但插件必须理解的东西：核心 `version --json` 的握手形状、核心 `run --json`
 * 的输出形状，以及把两种结果形状归一化成 `RunOutcome` 的解析器。
 *
 * 为什么同时接受两种形状：`contract/schema/ipc.v1.json` 定义的是 `RunResult`
 * （`ok`/`startedAt`/`error.code`），而当前核心的 `run --json` 输出的是一份更小的
 * `runOutput`（`files`/`skipped`/`branch`/`prUrl`/`digest.contentHash`），错误只走
 * stderr 文本。核心补上信封后，`parseRunResult` 无需改动即可接住。
 */
import type { ErrorInfo, FileArtifact, RunResult } from './ipc.gen.js';
import { IPC_SCHEMA_VERSION } from './ipc.gen.js';
import type { AnyCode } from './errors.js';

export type { ErrorCode, ErrorInfo, FileArtifact, RunRequest, RunResult, State, StateRun } from './ipc.gen.js';
export { IPC_SCHEMA_VERSION };

/** 插件能接受的 digest 契约版本（与核心 `version --json` 的 digestSchema 比对）。 */
export const SUPPORTED_DIGEST_SCHEMA = 1;

/** 核心 `version --json` 的输出。 */
export interface VersionInfo {
  version: string;
  commit?: string;
  ipcSchema: number;
  digestSchema: number;
  supportedProviders?: string[];
}

/** 插件侧的错误信息：`code` 可能是核心码，也可能是插件码（`CORE_*` 等）。 */
export interface RunError {
  code: AnyCode;
  message: string;
  retriable: boolean;
  details?: Record<string, unknown>;
}

/** 归一化后的一次运行结果：状态、历史、工具返回值都用它。 */
export interface RunOutcome {
  ok: boolean;
  skipped: boolean;
  dryRun: boolean;
  files: FileArtifact[];
  contentHash?: string;
  branch?: string;
  commit?: string;
  prUrl?: string;
  error?: RunError;
  warnings: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  coreVersion: string;
}

export class IpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'IpcError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 解析「单个 JSON 对象」。核心的 stdout 纪律是只允许一个信封，因此：
 * 空输出、多文档、非对象一律拒绝，不做「取第一段 JSON」这种猜测。
 */
export function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed === '') throw new IpcError('IPC_INVALID', '核心 stdout 为空');
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new IpcError('IPC_INVALID', `核心 stdout 不是合法 JSON：${detail}`);
  }
  if (!isRecord(value)) throw new IpcError('IPC_INVALID', '核心 stdout 不是 JSON 对象');
  return value;
}

export function isVersionInfo(value: unknown): value is VersionInfo {
  if (!isRecord(value)) return false;
  return (
    typeof value.version === 'string' &&
    typeof value.ipcSchema === 'number' &&
    typeof value.digestSchema === 'number'
  );
}

export function parseVersionInfo(text: string): VersionInfo {
  const value = parseJsonObject(text);
  if (!isVersionInfo(value)) {
    throw new IpcError('IPC_INVALID', '核心 version --json 缺少 version/ipcSchema/digestSchema');
  }
  return value;
}

function normalizeFiles(value: unknown): FileArtifact[] {
  if (!Array.isArray(value)) return [];
  const files: FileArtifact[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.path !== 'string') continue;
    files.push({
      path: item.path,
      bytes: typeof item.bytes === 'number' ? item.bytes : 0,
      sha256: typeof item.sha256 === 'string' ? item.sha256 : '',
    });
  }
  return files;
}

function normalizeError(value: unknown): RunError | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.code !== 'string' || typeof value.message !== 'string') return undefined;
  return {
    code: value.code as AnyCode,
    message: value.message,
    retriable: value.retriable === true,
    ...(isRecord(value.details) ? { details: value.details } : {}),
  };
}

export interface ParseRunOptions {
  coreVersion: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  dryRun: boolean;
}

/**
 * 把核心 `run --json` 的 stdout 归一化成 `RunOutcome`。
 *
 * 两种形状的判别：有 `ipcSchema` 且 `command === 'run'` 就是契约 `RunResult`；
 * 否则按当前核心的 `runOutput` 处理。两者都不像就直接 `IPC_INVALID`，
 * 绝不「猜字段」——结果信封读错会把失败当成功写进状态。
 */
export function parseRunResult(text: string, options: ParseRunOptions): RunOutcome {
  const value = parseJsonObject(text);
  const contractShaped = value.ipcSchema === IPC_SCHEMA_VERSION && typeof value.ok === 'boolean' && value.command === 'run';

  if (contractShaped) {
    const result = value as unknown as RunResult;
    return {
      ok: result.ok,
      skipped: result.skipped === true,
      dryRun: options.dryRun,
      files: normalizeFiles(result.files),
      contentHash: typeof value.contentHash === 'string' ? value.contentHash : undefined,
      branch: typeof value.branch === 'string' ? value.branch : undefined,
      commit: typeof value.commit === 'string' ? value.commit : undefined,
      prUrl: typeof value.prUrl === 'string' ? value.prUrl : undefined,
      error: normalizeError(result.error),
      warnings: Array.isArray(result.warnings) ? result.warnings.filter((item): item is string => typeof item === 'string') : [],
      ...timing(options),
      coreVersion: options.coreVersion,
    };
  }

  if (!Array.isArray(value.files)) {
    throw new IpcError('IPC_INVALID', '核心 run --json 既不是契约 RunResult，也不含 files 数组');
  }
  const digest = isRecord(value.digest) ? value.digest : undefined;
  return {
    ok: true,
    skipped: value.skipped === true,
    dryRun: options.dryRun,
    files: normalizeFiles(value.files),
    contentHash: typeof digest?.contentHash === 'string' ? digest.contentHash : undefined,
    branch: typeof value.branch === 'string' ? value.branch : undefined,
    prUrl: typeof value.prUrl === 'string' ? value.prUrl : undefined,
    warnings: [],
    ...timing(options),
    coreVersion: options.coreVersion,
  };
}

function timing(options: ParseRunOptions) {
  return { startedAt: options.startedAt, finishedAt: options.finishedAt, durationMs: options.durationMs };
}
