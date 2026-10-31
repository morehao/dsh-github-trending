/**
 * 契约类型与运行时守卫。
 *
 * 类型与运行时校验全部来自独立契约包 `@morehao/trendradar-contract`（wire:
 * `ipcSchema=2` / `digestSchema=2`）。本文件只放插件理解契约所必需的两件事：
 * 核心 `version --json` 的握手形状，以及把核心 `run --json` 的 `RunResult`
 * 归一化成插件内部的 `RunOutcome`。
 *
 * 只接受一种结果形状：契约包定义的 `RunResult`（`ipcSchema=2` / `command=run`），
 * 用它自带的 ajv 校验器把关。旧核心那份只有 `files`/`digest` 的 `runOutput`
 * 不再兼容——协议版本不匹配会在握手阶段被拦下，这里绝不「猜字段」。
 */
import { validators } from '@morehao/trendradar-contract';
import type { ErrorInfo, FileArtifact, RunResult, Usage, ReleasesReport, SubscriptionList } from '@morehao/trendradar-contract';
import type { AnyCode } from './errors.js';

export type {
  ErrorCode,
  ErrorInfo,
  FileArtifact,
  RunRequest,
  RunResult,
  State,
  StateRun,
  Usage,
  ReleasesReport,
  SubscriptionList,
} from '@morehao/trendradar-contract';

/** 插件实现所对应的 IPC 契约版本（契约包 `ipc.v2.json` 的 wire 整数）。 */
export const IPC_SCHEMA_VERSION = 2 as const;

/** 插件能接受的 digest 契约版本（与核心 `version --json` 的 digestSchema 比对）。 */
export const SUPPORTED_DIGEST_SCHEMA = 2 as const;

/** 契约包 `contractVersion` 的主版本；0.x 期间同主版本即视为同一契约线。 */
export const SUPPORTED_CONTRACT_MAJOR = 0;

/** 核心 `version --json` 的输出。 */
export interface VersionInfo {
  version: string;
  commit?: string;
  ipcSchema: number;
  digestSchema: number;
  contractVersion?: string;
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
  /** 核心给出的跳过原因：merged | pr-closed | unchanged（可选，旧核心没有）。 */
  skipReason?: string;
  /** 榜单阶段 token 用量（契约 Usage，可选；旧核心没有）。不拆维度，只取 totalTokens。 */
  usage?: Usage;
  /** 发版订阅阶段报告（契约 ReleasesReport，可选；旧核心/releases.enabled=false 时没有）。 */
  releases?: ReleasesReport;
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

/** 契约包 `RunResult` → 插件内部 `RunOutcome` 的唯一映射。 */
export interface ParseRunOptions {
  coreVersion: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  dryRun: boolean;
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

/**
 * 把核心 `run --json` 的 stdout 归一化成 `RunOutcome`。
 *
 * 唯一接受的形状是契约 `RunResult`（`ipcSchema=2` / `command=run`），并用契约包
 * 自带的 ajv 校验器校验。任何其它形状直接 `IPC_INVALID`——结果信封读错会把失败
 * 当成功写进状态。
 */
export function parseRunResult(text: string, options: ParseRunOptions): RunOutcome {
  const value = parseJsonObject(text);
  if (value.command !== 'run' || value.ipcSchema !== IPC_SCHEMA_VERSION || !validators.runResult(value)) {
    throw new IpcError('IPC_INVALID', '核心 run --json 不是契约 RunResult（ipcSchema=2 / command=run）');
  }
  const result = value as unknown as RunResult;
  const error = normalizeError(result.error);
  const skipReason = (value as { skipReason?: unknown }).skipReason;
  return {
    ok: result.ok,
    skipped: result.skipped === true,
    dryRun: options.dryRun,
    files: Array.isArray(result.files) ? result.files : [],
    contentHash: typeof result.contentHash === 'string' ? result.contentHash : undefined,
    branch: typeof result.branch === 'string' ? result.branch : undefined,
    commit: typeof result.commit === 'string' ? result.commit : undefined,
    prUrl: typeof result.prUrl === 'string' ? result.prUrl : undefined,
    skipReason: typeof skipReason === 'string' && skipReason !== '' ? skipReason : undefined,
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    ...(result.releases === undefined ? {} : { releases: result.releases }),
    error,
    warnings: Array.isArray(result.warnings) ? result.warnings.filter((item): item is string => typeof item === 'string') : [],
    ...timing(options),
    coreVersion: options.coreVersion,
  };
}

function timing(options: ParseRunOptions) {
  return { startedAt: options.startedAt, finishedAt: options.finishedAt, durationMs: options.durationMs };
}

/** 订阅命令的结果：list 带回 repos，add/remove 只看 ok/error。 */
export interface SubscribeOutcome {
  ok: boolean;
  repos: string[];
  error?: RunError;
}

/** 订阅命令的一个动作（契约 `RunRequest.action`）。 */
export type SubscribeAction = 'list' | 'add' | 'remove';

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * 解析核心 `subscribe --json` 的 stdout。
 *
 * 核心先由 `runSubscribe` 把 `list` 的结果**逐行**打到 stdout（每行一个 owner/repo），
 * 再由 `emitSubscribeResult` 把契约 RunResult 信封打到 stdout（`command:"subscribe"`，
 * 只带 `ok/error`，**不含 repos**）。因此：
 *   - 信封是**最后一段 JSON**；它前面的非空行才是 list 的仓库列表；
 *   - 信封 `command` 是 `"subscribe"`（不在契约 RunResult 枚举里，故不能直接用
 *     `validators.runResult` 校验），这里只按 envelope 必需字段做轻量校验。
 * 任何形状不对都抛 `IPC_INVALID`：订阅结果读错会把失败当成功。
 */
export function parseSubscribeResult(text: string): SubscribeOutcome {
  const trimmed = text.trim();
  if (trimmed === '') throw new IpcError('IPC_INVALID', '核心 subscribe 输出为空');
  const lines = trimmed.split('\n');
  const lastLine = (lines[lines.length - 1] ?? '').trim();
  let envelope: unknown;
  try {
    envelope = JSON.parse(lastLine);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new IpcError('IPC_INVALID', `核心 subscribe 未以结果信封结尾：${detail}`);
  }
  if (!isRecord(envelope) || envelope.ipcSchema !== IPC_SCHEMA_VERSION || typeof envelope.ok !== 'boolean') {
    throw new IpcError('IPC_INVALID', '核心 subscribe --json 不是契约信封（ipcSchema=2 / ok）');
  }
  const error = normalizeError(envelope.error);
  // 信封之前的行为 list 结果；过滤空行与任何非 owner/repo 形态的噪声行。
  const repos: string[] = [];
  for (const line of lines.slice(0, -1)) {
    const value = line.trim();
    if (value === '') continue;
    if (REPO_PATTERN.test(value)) repos.push(value);
  }
  return {
    ok: envelope.ok === true,
    repos,
    ...(error === undefined ? {} : { error }),
  };
}
