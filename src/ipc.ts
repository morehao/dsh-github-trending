/**
 * 契约类型与运行时守卫。
 *
 * 类型与运行时校验全部来自独立契约包 `@morehao/trendradar-contract`（wire:
 * `ipcSchema=3` / `digestSchema=2`）。本文件只放插件理解契约所必需的两件事：
 * 核心 `version --json` 的握手形状，以及把核心 `run --json` 的 `RunResult`
 * 归一化成插件内部的 `RunOutcome`。
 *
 * 只接受一种结果形状：契约包定义的 `RunResult`（`ipcSchema=3` / `command=run`），
 * 用它自带的 ajv 校验器把关。旧核心那份只有 `files`/`digest` 的 `runOutput`
 * 不再兼容——协议版本不匹配会在握手阶段被拦下，这里绝不「猜字段」。
 */
import { createHash } from 'node:crypto';

import { validators } from '@morehao/trendradar-contract';
import type {
  DigestArtifact,
  ErrorInfo,
  FileArtifact,
  RunResult,
  Usage,
  ReleasesReport,
  SubscriptionDoc,
  SubscriptionItem,
  SubscriptionList,
  SubscriptionStatus,
} from '@morehao/trendradar-contract';
import type { AnyCode } from './errors.js';

export type {
  ErrorCode,
  ErrorInfo,
  DigestArtifact,
  FileArtifact,
  RunRequest,
  RunResult,
  State,
  StateRun,
  Usage,
  ReleasesReport,
  SubscriptionDoc,
  SubscriptionItem,
  SubscriptionList,
  SubscriptionStatus,
  SubscriptionVolume,
} from '@morehao/trendradar-contract';

/** 插件实现所对应的 IPC 契约版本（契约包 `ipc.v3.json` 的 wire 整数）。 */
export const IPC_SCHEMA_VERSION = 3 as const;

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
  /** 本次渲染的 digest 原文（ipc v3）；没有渲染（dry-run / 纯发版 / 渲染前失败）时缺省。 */
  digest?: DigestArtifact;
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

// 订阅相关类型（`SubscriptionStatus` / `SubscriptionItem` / `SubscriptionVolume` /
// `SubscriptionDoc`，契约 0.4.0 起）直接来自 npm 契约包，本地不再保留第二份形状。

const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = ['baseline', 'ok', 'no_change', 'rate_limited', 'failed'];

export function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return typeof value === 'string' && (SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

/**
 * `SubscriptionDoc` 的运行时守卫：缺 fullName/volume/markdown 的负载宁可抛
 * `IPC_INVALID`，也不要让界面拿到半份文档（正文缺失时渲染会崩，比报错更难查）。
 */
export function isSubscriptionDoc(value: unknown): value is SubscriptionDoc {
  if (!isRecord(value)) return false;
  return (
    typeof value.fullName === 'string' &&
    value.fullName !== '' &&
    typeof value.volume === 'number' &&
    Number.isInteger(value.volume) &&
    value.volume >= 1 &&
    typeof value.markdown === 'string'
  );
}

function isSubscriptionItem(value: unknown): value is SubscriptionItem {
  return isRecord(value) && typeof value.fullName === 'string' && value.fullName !== '' && isSubscriptionStatus(value.status);
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
 * `RunResult.digest`（ipc v3）的跨字段校验。
 *
 * 契约只能约束形状，约束不了「text 是不是这份 bytes/sha256 的原文」以及
 * 「path 是否真的在 files 里」。核心自相矛盾的结果宁可 `IPC_INVALID`，
 * 也不要让面板显示一份与仓库不一致的文档（成败会被写进历史）。
 */
function parseDigest(value: unknown, files: FileArtifact[]): DigestArtifact | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new IpcError('IPC_INVALID', '核心 run --json 的 digest 不是对象');
  const file = value.path;
  const bytes = value.bytes;
  const sha256 = value.sha256;
  const text = value.text;
  if (typeof file !== 'string' || file === '' || typeof text !== 'string' || typeof bytes !== 'number' || typeof sha256 !== 'string') {
    throw new IpcError('IPC_INVALID', '核心 run --json 的 digest 缺 path/bytes/sha256/text');
  }
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length !== bytes) {
    throw new IpcError('IPC_INVALID', `digest.bytes=${bytes} 与 text 实际 ${buffer.length} 字节不一致`);
  }
  const actual = `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
  if (actual !== sha256) {
    throw new IpcError('IPC_INVALID', `digest.sha256 与 text 不一致：声明 ${sha256}，实际 ${actual}`);
  }
  const listed = files.find((item) => item.path === file);
  if (listed === undefined) {
    throw new IpcError('IPC_INVALID', `digest.path=${file} 不在 files 里`);
  }
  if (listed.sha256 !== sha256 || listed.bytes !== bytes) {
    throw new IpcError('IPC_INVALID', `digest 与 files 里 ${file} 的 bytes/sha256 不一致`);
  }
  return { path: file, bytes, sha256, text };
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
  // 契约 RunResult.files 必填且为数组，但核心在「跳过 / 空阶段」时（如 --stages releases 但订阅为空）
  // 会吐 `files:null`。这是良性的「无事可做」，不该判成 IPC_INVALID 让整次运行报错。
  // 在契约校验前把 null 归一成 []，不触碰任何产物内容。
  if (value.files === null || value.files === undefined) value.files = [];
  if (value.command !== 'run' || value.ipcSchema !== IPC_SCHEMA_VERSION || !validators.runResult(value)) {
    throw new IpcError('IPC_INVALID', '核心 run --json 不是契约 RunResult（ipcSchema=3 / command=run）');
  }
  const result = value as unknown as RunResult;
  const error = normalizeError(result.error);
  const skipReason = (value as { skipReason?: unknown }).skipReason;
  const files = Array.isArray(result.files) ? result.files : [];
  const digest = parseDigest((value as { digest?: unknown }).digest, files);
  return {
    ok: result.ok,
    skipped: result.skipped === true,
    dryRun: options.dryRun,
    files,
    ...(digest === undefined ? {} : { digest }),
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

/** 订阅命令的结果：list 带回 repos/items，releases 带回 doc，add/remove 只看 ok/error。 */
export interface SubscribeOutcome {
  ok: boolean;
  repos: string[];
  /** list 的逐仓库明细（契约 0.4.0）；旧核心不返回时为 undefined。 */
  items?: SubscriptionItem[];
  /** `action=releases` 读到的发版文档；其它 action 没有。 */
  doc?: SubscriptionDoc;
  error?: RunError;
}

/** 订阅命令的一个动作（契约 `RunRequest.action`）。 */
export type SubscribeAction = 'list' | 'add' | 'remove' | 'releases';

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * 解析 `envelope.subscriptions`（契约 `SubscriptionList`）。
 * 只对 `repos` 做严格校验：它是旧核心/旧客户端唯一读的字段，形状不对说明信封读错了。
 * `items` 是新增的展示明细，单行畸形就丢掉那一行，不因为一行坏数据让整张表打不开。
 */
function parseSubscriptionList(value: unknown): { repos: string[]; items?: SubscriptionItem[] } {
  if (!isRecord(value)) throw new IpcError('IPC_INVALID', '核心 subscribe 返回的 subscriptions 不是对象');
  const rawRepos = value.repos;
  if (!Array.isArray(rawRepos) || rawRepos.some((item) => typeof item !== 'string')) {
    throw new IpcError('IPC_INVALID', '核心 subscribe 返回的 subscriptions.repos 不是字符串数组');
  }
  const repos = rawRepos.filter((item): item is string => typeof item === 'string');
  const items = Array.isArray(value.items) ? value.items.filter(isSubscriptionItem) : undefined;
  return { repos, ...(items === undefined ? {} : { items }) };
}

/**
 * 解析核心 `subscribe --json` 的 stdout。
 *
 * 契约 0.4.0 起 payload 进了结果信封：`{command:"subscribe", subscriptions?, subscriptionDoc?}`。
 * 这里**优先**读信封；旧核心（0.6.x 及以前）把 `list` 的结果逐行打到信封之前、信封里只有
 * `ok/error`，因此保留逐行兜底——两种都能读，但绝不「猜字段」：
 *   - 信封不是 `ipcSchema=2` 的对象 → `IPC_INVALID`；
 *   - `subscriptions` 存在但形状不对 → `IPC_INVALID`（不是空列表）；
 *   - `subscriptionDoc` 存在但不满足契约 → `IPC_INVALID`（界面不能拿到半份文档）。
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
  const list = envelope.subscriptions === undefined ? undefined : parseSubscriptionList(envelope.subscriptions);
  const doc = envelope.subscriptionDoc;
  if (doc !== undefined && !isSubscriptionDoc(doc)) {
    throw new IpcError('IPC_INVALID', '核心 subscribe 返回的 subscriptionDoc 不是契约 SubscriptionDoc（fullName/volume/markdown）');
  }
  const repos: string[] = list?.repos ?? [];
  if (list === undefined) {
    // 旧核心兜底：信封之前的行为 list 结果；过滤空行与任何非 owner/repo 形态的噪声行。
    for (const line of lines.slice(0, -1)) {
      const value = line.trim();
      if (value === '') continue;
      if (REPO_PATTERN.test(value)) repos.push(value);
    }
  }
  return {
    ok: envelope.ok === true,
    repos,
    ...(list?.items === undefined ? {} : { items: list.items }),
    ...(doc === undefined ? {} : { doc }),
    ...(error === undefined ? {} : { error }),
  };
}
