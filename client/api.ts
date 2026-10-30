/**
 * 客户端唯一的数据入口：统一前缀、CSRF 头、错误码透出。
 *
 * 所有请求都打到 Host half 的 `/api/morehao/github-trending/*`；客户端不直接碰核心、
 * 不读本地文件、不持有任何密钥。
 */
export const API = '/api/morehao/github-trending';
export const HEADER = 'x-dsh-github-trending';

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
  durationMs: number;
  files: number;
  contentHash?: string;
  branch?: string;
  prUrl?: string;
  coreVersion: string;
  model: { provider: string; model: string };
  languages: string[];
  warnings: string[];
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
  trending: { since: 'daily' | 'weekly'; languages: string[]; topN: number };
  output: { dir: string };
  schedule: { enabled: boolean; time: string; timezone: string };
  corePath: string;
}

export interface StatePayload {
  plugin: { name: string; version: string };
  settings: SettingsShape;
  core: CoreStatus;
  coexistence: CoexistenceStatus;
  schedule: { enabled: boolean; time: string; timezone: string; nextRunAt?: string; lastRunDate?: string; source: 'timer' };
  status: {
    running: { id: string; startedAt: string } | null;
    lastRunAt: string | null;
    lastDigest: { date: string; contentHash: string; coreVersion: string } | null;
    lastResult: RunRecord | null;
    pendingPr: { url: string; createdAt: string; date?: string } | null;
    pendingPrState?: 'open' | 'closed' | 'merged' | 'unknown';
    history: RunRecord[];
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
