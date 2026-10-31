/**
 * 客户端唯一的数据入口：统一前缀、CSRF 头、错误码透出。
 *
 * 所有请求都打到 Host half 的 `/api/morehao/github-trending/*`；客户端不直接碰核心、
 * 不读本地文件、不持有任何密钥。
 */
export const API = '/api/morehao/github-trending';
export const HEADER = 'x-dsh-github-trending';

/** 榜单周期（与 core 0.4.0 的 `--period` 一致）。 */
export type Period = 'daily' | 'weekly' | 'monthly';

/** 日报视图的定位：某个周期的某一期（期数桶由 `digest-core.periodBucket` 计算）。 */
export interface DigestTarget {
  period: Period;
  bucket: string;
}

export interface ApiFailure extends Error {
  code?: string;
}

export async function apiCall<T = Record<string, any>>(
  method: string,
  path: string,
  body?: unknown,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', [HEADER]: '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  let json: Record<string, any> = {};
  try {
    json = (await response.json()) as Record<string, any>;
  } catch {
    json = {};
  }
  if (!response.ok || json.ok === false) {
    const error = new Error(typeof json.message === 'string' ? json.message : `HTTP ${response.status}`) as ApiFailure;
    error.code = typeof json.code === 'string' ? json.code : undefined;
    throw error;
  }
  return json as T;
}

export interface PreviewMeta {
  file: string;
  bytes: number;
  sha256: string;
  truncated?: boolean;
}

/** 发版订阅阶段摘要（历史/运行记录展示用）。 */
export interface ReleasesSummary {
  enabled: boolean;
  repos: number;
  newReleases: number;
  summarized?: number;
  degraded?: number;
  failed?: number;
  skipped?: number;
}

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
  skipReason?: string;
  /** 本次任务 token 总量（榜单 + 订阅阶段，含订阅）；缺省表示无数据。 */
  tokens?: number;
  /** 发版订阅阶段摘要；未启用/旧核心则缺省。 */
  releases?: ReleasesSummary;
  error?: {
    code: string;
    message: string;
    hint: string;
    area: string;
    retriable: boolean;
    inferred?: boolean;
    reason?: string;
  };
  warnings: string[];
  channel?: 'fifo' | 'tmpfile';
  proxy?: boolean;
  logFile?: string;
}

export interface RunRecord {
  id: string;
  at: string;
  kind: 'run' | 'dry-run';
  ok: boolean;
  skipped: boolean;
  errorCode?: string;
  errorMessage?: string;
  errorReason?: string;
  skipReason?: string;
  durationMs: number;
  files: number;
  date?: string;
  period?: Period;
  contentHash?: string;
  branch?: string;
  commit?: string;
  prUrl?: string;
  preview?: PreviewMeta;
  coreVersion: string;
  model: { provider: string; model: string };
  languages: string[];
  warnings: string[];
  /** 本次任务 token 总量（榜单 + 订阅阶段，含订阅）；缺省表示无数据。 */
  tokens?: number;
  /** 发版订阅阶段摘要；未启用/旧核心则缺省。 */
  releases?: ReleasesSummary;
  legacy?: boolean;
}

export interface CoreReleaseStatus {
  repo: string;
  tag: string;
  asset: string;
  url: string;
  checksumsUrl: string;
  cacheDir: string;
  binaryPath: string;
  cached: boolean;
}

export interface CoreStatus {
  state: 'ready' | 'unavailable' | 'incompatible';
  path?: string;
  source?: 'settings' | 'env' | 'cache' | 'download';
  release?: CoreReleaseStatus;
  override?: { path: string; source: 'settings' | 'env' };
  download: { state: 'cached' | 'missing' | 'override'; reason?: string };
  version?: string;
  commit?: string;
  ipcSchema?: number;
  digestSchema?: number;
  supportedProviders: string[];
  /** 核心开源仓库（`https://github.com/<owner>/<repo>`）；缺失时界面隐藏外链。 */
  repository?: string;
  code?: string;
  message?: string;
  checkedAt: string;
  durationMs?: number;
}

export interface CoexistenceStatus {
  found: boolean;
  path?: string;
  version?: string;
  ipcSchema?: number;
  compatible?: boolean;
  message?: string;
}

export interface SettingsShape {
  model: {
    provider: string;
    mode: 'direct' | 'proxy';
    hostProvider: string;
    baseURL: string;
    model: string;
    apiKeyRef: string;
    temperature: number;
    maxTokens: number;
    allowDegraded: boolean;
  };
  repo: { path: string; baseBranch: string; remote: string; commitMode: 'branch' | 'direct'; authorName: string; authorEmail: string };
  pr: { enabled: boolean; titleTemplate: string; autoMerge: boolean; labels: string[] };
  github: { authMode: 'pat' | 'gh'; tokenRef: string };
  trending: { since: Period; languages: string[]; topN: number };
  summarize: {
    batchSize: number;
    maxRetries: number;
    enrich: 'none' | 'repo' | 'readme';
    readmeChars: number;
    enrichCacheTTLHours: number;
    enrichConcurrency: number;
    enrichTimeoutSeconds: number;
    enrichBudgetSeconds: number;
  };
  releases: {
    enabled: boolean;
    includePrerelease: boolean;
    includeDrafts: boolean;
    fallbackToTags: boolean;
    baselineOnFirstRun: boolean;
    perRepoLimit: number;
    maxNotesChars: number;
    period: Period;
  };
  output: { dir: string };
  schedule: { enabled: boolean; time: string; timezone: string; periods: Period[] };
  corePath: string;
}

export interface StatePayload {
  plugin: { name: string; version: string; repository?: string };
  settings: SettingsShape;
  core: CoreStatus;
  coexistence: CoexistenceStatus;
  schedule: { enabled: boolean; time: string; timezone: string; periods: Period[]; nextRunAt?: string; lastRunDate?: string; source: 'timer' };
  status: {
    running: { id: string; startedAt: string } | null;
    lastRunAt: string | null;
    lastDigest: { date: string; contentHash: string; contentHashAlgo?: string; coreVersion: string } | null;
    lastResult: RunRecord | null;
    pendingPr: { url: string; createdAt: string; date?: string } | null;
    pendingPrState?: 'open' | 'closed' | 'merged' | 'unknown';
    history: RunRecord[];
    /** 历史全部运行的 token 累计（读时求和）；全无数据则缺省。 */
    totalTokens?: number;
  };
  model: {
    mode: 'direct' | 'proxy';
    credential: { ref: string; configured: boolean; source: string | null; writable: boolean };
    effectiveBaseURL: string;
  };
  github: { authMode: string; configured: boolean; source: string };
}

export interface ProviderCandidate {
  id: string;
  name: string;
  baseURL: string;
  models: Array<{ id: string; name: string }>;
  credential: { ref?: string; env: string[]; configured: boolean; oauth: boolean; mode: 'direct' | 'proxy' | 'missing'; source?: string };
  coreProvider: string;
}

/** 宿主默认模型（`ctx.agentDefaultModel.currentSelection()`）。 */
export interface DefaultSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface QuickfillResponse {
  providers: ProviderCandidate[];
  defaultSelection: DefaultSelection | null;
}

export interface PreflightResult {
  ok: boolean;
  code?: string;
  message?: string;
  hint?: string;
  durationMs: number;
  endpoint?: string;
  mode: 'direct' | 'proxy';
}

export interface Problem {
  field: string;
  code: string;
  message: string;
}

export interface RepoBranchResult {
  branch?: string;
  source: 'origin-head' | 'head' | 'none';
  message?: string;
}

export interface GithubProbeResult {
  ok: boolean;
  login?: string;
  source?: string;
  code?: string;
  message?: string;
}

export interface PreviewPayload {
  id: string;
  preview: { text: string; truncated: boolean };
}

export interface LogPayload {
  id: string;
  exists: boolean;
  text: string;
}

/** 读一次运行的预览副本；只接受 runId，路径永远由 Host 决定。 */
export function getPreview(runId: string, signal?: AbortSignal): Promise<PreviewPayload> {
  return apiCall<PreviewPayload>('GET', `/preview?id=${encodeURIComponent(runId)}`, undefined, signal === undefined ? {} : { signal });
}

/** 读一次运行的事后日志（Host 只回最后 64 KB，不是实时流）。 */
export function getLog(runId: string, signal?: AbortSignal): Promise<LogPayload> {
  return apiCall<LogPayload>('GET', `/log?id=${encodeURIComponent(runId)}`, undefined, signal === undefined ? {} : { signal });
}

export type PluginInstallKind = 'registry' | 'link' | 'file' | 'workspace' | 'unknown';
export type PluginUpdateApplication = 'applied' | 'restart-required' | 'overridden';

export interface PluginUpdateView {
  packageName: string;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkFailed: boolean;
  canApply: boolean;
  installKind: PluginInstallKind;
  installSpec?: string;
  manualCommand: string;
  applying: boolean;
  checkedAt?: string;
}

export interface PluginUpdateResult {
  application: PluginUpdateApplication;
  restartRequired?: boolean;
  updatedVersion: string;
  steps?: string[];
}

/** 检查插件自身的 npm 最新版；`fresh` 绕过 Host 侧 5 分钟缓存。 */
export async function getPluginUpdate(options: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<PluginUpdateView> {
  const query = options.fresh === true ? '?fresh=1' : '';
  const payload = await apiCall<{ update: PluginUpdateView }>('GET', `/update${query}`, undefined, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return payload.update;
}

/** 经宿主 pluginManager 重装本插件；失败时 Host 返回 409 + UPDATE_FAILED。 */
export async function applyPluginUpdate(): Promise<PluginUpdateResult> {
  const payload = await apiCall<{ result: PluginUpdateResult }>('POST', '/update', {});
  return payload.result;
}

/** 读订阅列表（数据仓版本化的 subscriptions.yaml，经核心 subscribe list）。 */
export async function getSubscriptions(signal?: AbortSignal): Promise<string[]> {
  const payload = await apiCall<{ repos: string[] }>('GET', '/subscriptions', undefined, signal === undefined ? {} : { signal });
  return Array.isArray(payload.repos) ? payload.repos : [];
}

/** 增删订阅（经核心 subscribe add/remove，只写 .git/pending）。返回最新列表。 */
export async function postSubscriptions(action: 'add' | 'remove', repos: string[]): Promise<string[]> {
  const payload = await apiCall<{ repos: string[] }>('POST', '/subscriptions', { action, repos });
  return Array.isArray(payload.repos) ? payload.repos : [];
}
