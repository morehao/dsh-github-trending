/**
 * 插件设置（`settings.json`）⇄ 核心配置（YAML）之间的唯一映射。
 *
 * 原则：**不翻译语义**。插件里的 `model.*` 与核心 `config.ModelConfig` 一一对应；
 * 核心没有的字段（mergeMethod / deleteBranchAfterMerge / output.json / summary.enabled）
 * 在插件里也不存在——宁可少一个开关，也不造一个「点了没反应」的配置。
 * 版式只支持 canonical（核心自己落盘），template 映射留待二期，见执行计划 §7。
 */
import path from 'node:path';

export type Provider = string;
export type CommitMode = 'branch' | 'direct';
/** 只保留两种真正可用的方式：本机 `gh` 登录态、手动 PAT。历史的 `device` 在归一化时迁移为 `gh`。 */
export type AuthMode = 'pat' | 'gh';

/**
 * 榜单周期（core 0.4.0 的 `--period` 三取值）。
 * `trending.since` 复用同一枚举：单次运行「抓取窗口 = 标注周期」由核心保证
 * （`run --period` 会覆盖 `config.trending.since`）。
 */
export type Period = 'daily' | 'weekly' | 'monthly';
export type Since = Period;

/** 规范顺序（索引分组、去重、UI 展示都以它为准）。 */
export const PERIODS: readonly Period[] = ['daily', 'weekly', 'monthly'];

export function isPeriod(value: unknown): value is Period {
  return value === 'daily' || value === 'weekly' || value === 'monthly';
}

export function isEnrich(value: unknown): value is Enrich {
  return value === 'none' || value === 'repo' || value === 'readme';
}

export interface ModelSettings {
  provider: Provider;
  /** `direct` = 密钥经配置通道直传核心；`proxy` = 宿主 provider 无可导出密钥，走回环代理。 */
  mode: 'direct' | 'proxy';
  /** `mode=proxy` 时转发给哪个宿主 provider 路由（核心不认这个值）。 */
  hostProvider: string;
  baseURL: string;
  model: string;
  /** `ctx.credentials` 的引用名；密钥本身不写进 settings.json。 */
  apiKeyRef: string;
  temperature: number;
  maxTokens: number;
  allowDegraded: boolean;
}

export interface RepoSettings {
  path: string;
  baseBranch: string;
  remote: string;
  commitMode: CommitMode;
  authorName: string;
  authorEmail: string;
}

export interface PRSettings {
  enabled: boolean;
  titleTemplate: string;
  autoMerge: boolean;
  labels: string[];
}

export interface GithubSettings {
  authMode: AuthMode;
  tokenRef: string;
}

export interface TrendingSettings {
  since: Since;
  languages: string[];
  topN: number;
}

export interface OutputSettings {
  dir: string;
}

/** 摘要生成的外部上下文增强选项（核心 `summarize.enrich`）。 */
export type Enrich = 'none' | 'repo' | 'readme';

/**
 * 摘要与用量阶段参数（核心 `summarize.*`）。
 * 只映射核心真实字段；插件不加核心没有的开关（不造「点了没反应」的配置）。
 */
export interface SummarizeSettings {
  batchSize: number;
  maxRetries: number;
  enrich: Enrich;
  readmeChars: number;
  enrichCacheTTLHours: number;
  enrichConcurrency: number;
  enrichTimeoutSeconds: number;
  enrichBudgetSeconds: number;
}

/**
 * 发版订阅阶段的行为参数（核心 `releases.*`）。
 * 阶段**常开**（`releases.enabled` 恒为 true，不出现在设置里）：有没有产出只由订阅列表决定，
 * 列表为空时核心不产出、不改动榜单产物。
 * **订阅列表本身不落 settings.json**：它版本化在数据仓 `<output.dir>/subscriptions.yaml`，
 * 经核心 `subscribe` IPC 读改。这里只放全局行为旋钮。
 */
export interface ReleasesSettings {
  includePrerelease: boolean;
  includeDrafts: boolean;
  fallbackToTags: boolean;
  baselineOnFirstRun: boolean;
  perRepoLimit: number;
  maxNotesChars: number;
  /** 发版摘要周期，独立默认 daily，不与 trending.since 联动。 */
  period: Period;
}

export interface ScheduleSettings {
  enabled: boolean;
  /** `HH:MM:SS`（本地墙钟，按 timezone 解释）。 */
  time: string;
  timezone: string;
  /**
   * 定时自动产出的周期（插件侧调度概念，核心无此字段）。
   * 每个周期按自己的节奏触发：日=每天、周=周日、月=月末。
   * 现在固定为三周期全产出（`['daily','weekly','monthly']`），不再由用户勾选；
   * 保留该字段以兼容旧设置、并驱动调度与去重逻辑。
   */
  periods: Period[];
}

export interface Settings {
  model: ModelSettings;
  repo: RepoSettings;
  pr: PRSettings;
  github: GithubSettings;
  trending: TrendingSettings;
  summarize: SummarizeSettings;
  releases: ReleasesSettings;
  output: OutputSettings;
  schedule: ScheduleSettings;
  /** 核心二进制覆盖；只在开发/排障时用，对应 TRENDING_DIGEST_CORE。 */
  corePath: string;
  /** 缓存缺失时是否自动从 Release 下载核心（首次运行需要联网）。 */
  coreAutoDownload: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  model: {
    provider: 'deepseek',
    mode: 'direct',
    hostProvider: '',
    baseURL: '',
    model: '',
    apiKeyRef: 'TRENDING_MODEL_KEY',
    temperature: 0.2,
    maxTokens: 2048,
    allowDegraded: true,
  },
  repo: {
    path: '',
    baseBranch: 'main',
    remote: 'origin',
    commitMode: 'branch',
    authorName: '',
    authorEmail: '',
  },
  pr: {
    enabled: true,
    titleTemplate: 'chore(trending): add {date} digest',
    autoMerge: true,
    labels: [],
  },
  github: { authMode: 'gh', tokenRef: 'GITHUB_TOKEN' },
  trending: { since: 'daily', languages: ['all', 'typescript', 'python', 'go', 'rust'], topN: 25 },
  summarize: {
    batchSize: 10,
    maxRetries: 1,
    enrich: 'none',
    readmeChars: 800,
    enrichCacheTTLHours: 168,
    enrichConcurrency: 4,
    enrichTimeoutSeconds: 5,
    enrichBudgetSeconds: 8,
  },
  releases: {
    includePrerelease: false,
    includeDrafts: false,
    fallbackToTags: true,
    baselineOnFirstRun: true,
    perRepoLimit: 5,
    maxNotesChars: 4000,
    period: 'daily',
  },
  output: { dir: 'trending' },
  schedule: { enabled: true, time: '08:30:00', timezone: 'Asia/Shanghai', periods: ['daily', 'weekly', 'monthly'] },
  corePath: '',
  coreAutoDownload: true,
};

/** 核心支持的 provider 默认端点（空字符串 = 必须由用户填）。 */
export const PROVIDER_BASE_URLS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com/v1',
  'openai-compatible': '',
  anthropic: '',
};

export const CORE_PROVIDERS = ['deepseek', 'openai-compatible'] as const;

/** 设置页分区；分段保存时只提交并校验对应分区，互不牵连。 */
export const SETTINGS_SECTIONS = ['source', 'model', 'repo', 'auth', 'scope', 'summarize', 'releases', 'schedule'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** 校验问题字段 → 所属分区（用于分段保存时只把本分区的问题回给界面）。 */
export function sectionOfField(field: string): SettingsSection | undefined {
  if (field.startsWith('model.')) return 'model';
  if (field.startsWith('repo.') || field.startsWith('output.') || field.startsWith('pr.')) return 'repo';
  if (field.startsWith('github.')) return 'auth';
  if (field.startsWith('trending.')) return 'scope';
  if (field.startsWith('summarize.')) return 'summarize';
  if (field.startsWith('releases.')) return 'releases';
  if (field.startsWith('schedule.')) return 'schedule';
  if (field === 'corePath' || field === 'coreAutoDownload') return 'source';
  return undefined;
}

/**
 * 分段保存：只把 `incoming` 里 `section` 的字段合并进 `stored`，其余分区保持已保存值。
 * 这样一个 tab 的保存不会顺带提交或覆盖其它 tab 里尚未保存的改动。
 */
export function mergeSettingsSection(stored: Settings, incoming: Settings, section: SettingsSection): Settings {
  const next = JSON.parse(JSON.stringify(stored)) as Settings;
  switch (section) {
    case 'source':
      next.corePath = incoming.corePath;
      next.coreAutoDownload = incoming.coreAutoDownload;
      break;
    case 'model':
      next.model = incoming.model;
      break;
    case 'repo':
      next.repo = incoming.repo;
      next.pr = incoming.pr;
      next.output = incoming.output;
      break;
    case 'auth':
      next.github = incoming.github;
      break;
    case 'scope':
      next.trending = incoming.trending;
      break;
    case 'summarize':
      next.summarize = incoming.summarize;
      break;
    case 'releases':
      next.releases = incoming.releases;
      break;
    case 'schedule':
      next.schedule = incoming.schedule;
      break;
  }
  return next;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function strArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  return items.length > 0 ? items.map((item) => item.trim()) : fallback;
}

/**
 * 周期列表归一：现在固定为「日/周/月」三周期全产出，不再由用户勾选。
 * 无论输入是什么（含旧版只有 `daily`、显式空数组），都统一收敛为 `PERIODS`，
 * 保证旧配置升级后也能自动产出三榜。保留该函数以便集中管理这一收敛。
 */
function periodList(_value: unknown, _fallback: Period[]): Period[] {
  return [...PERIODS];
}

/**
 * 把任意来源的对象（磁盘上的旧版本、HTTP 请求体、CLI 导入）收敛成完整设置。
 * 未知字段一律丢弃：settings.json 只有以下形状，避免旧版本字段悄悄生效。
 */
export function normalizeSettings(input: unknown): Settings {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const model = (raw.model ?? {}) as Record<string, unknown>;
  const repo = (raw.repo ?? {}) as Record<string, unknown>;
  const pr = (raw.pr ?? {}) as Record<string, unknown>;
  const github = (raw.github ?? {}) as Record<string, unknown>;
  const trending = (raw.trending ?? {}) as Record<string, unknown>;
  const summarize = (raw.summarize ?? {}) as Record<string, unknown>;
  const releases = (raw.releases ?? {}) as Record<string, unknown>;
  const output = (raw.output ?? {}) as Record<string, unknown>;
  const schedule = (raw.schedule ?? {}) as Record<string, unknown>;
  const commitMode = str(repo.commitMode, DEFAULT_SETTINGS.repo.commitMode);
  const authMode = str(github.authMode, DEFAULT_SETTINGS.github.authMode);
  const since = str(trending.since, DEFAULT_SETTINGS.trending.since);
  const enrich = str(summarize.enrich, DEFAULT_SETTINGS.summarize.enrich);
  const releasesPeriod = str(releases.period, DEFAULT_SETTINGS.releases.period);
  return {
    model: {
      provider: str(model.provider, DEFAULT_SETTINGS.model.provider),
      mode: str(model.mode, DEFAULT_SETTINGS.model.mode) === 'proxy' ? 'proxy' : 'direct',
      hostProvider: str(model.hostProvider, DEFAULT_SETTINGS.model.hostProvider).trim(),
      baseURL: str(model.baseURL, DEFAULT_SETTINGS.model.baseURL).trim(),
      model: str(model.model, DEFAULT_SETTINGS.model.model).trim(),
      apiKeyRef: str(model.apiKeyRef, DEFAULT_SETTINGS.model.apiKeyRef).trim() || DEFAULT_SETTINGS.model.apiKeyRef,
      temperature: num(model.temperature, DEFAULT_SETTINGS.model.temperature),
      maxTokens: num(model.maxTokens, DEFAULT_SETTINGS.model.maxTokens),
      allowDegraded: bool(model.allowDegraded, DEFAULT_SETTINGS.model.allowDegraded),
    },
    repo: {
      path: str(repo.path, DEFAULT_SETTINGS.repo.path).trim(),
      baseBranch: str(repo.baseBranch, DEFAULT_SETTINGS.repo.baseBranch).trim() || 'main',
      remote: str(repo.remote, DEFAULT_SETTINGS.repo.remote).trim() || 'origin',
      commitMode: commitMode === 'direct' ? 'direct' : 'branch',
      authorName: str(repo.authorName, DEFAULT_SETTINGS.repo.authorName).trim(),
      authorEmail: str(repo.authorEmail, DEFAULT_SETTINGS.repo.authorEmail).trim(),
    },
    pr: {
      enabled: bool(pr.enabled, DEFAULT_SETTINGS.pr.enabled),
      titleTemplate: str(pr.titleTemplate, DEFAULT_SETTINGS.pr.titleTemplate),
      autoMerge: bool(pr.autoMerge, DEFAULT_SETTINGS.pr.autoMerge),
      labels: strArray(pr.labels, DEFAULT_SETTINGS.pr.labels),
    },
    github: {
      // 旧版本可能存 'device'：它没有对应实现，统一迁移到真正可用的「本机 gh」。
      authMode: authMode === 'pat' ? 'pat' : 'gh',
      tokenRef: str(github.tokenRef, DEFAULT_SETTINGS.github.tokenRef).trim() || DEFAULT_SETTINGS.github.tokenRef,
    },
    trending: {
      since: isPeriod(since) ? since : 'daily',
      languages: strArray(trending.languages, DEFAULT_SETTINGS.trending.languages),
      topN: Math.round(num(trending.topN, DEFAULT_SETTINGS.trending.topN)),
    },
    summarize: {
      batchSize: Math.round(num(summarize.batchSize, DEFAULT_SETTINGS.summarize.batchSize)),
      maxRetries: Math.round(num(summarize.maxRetries, DEFAULT_SETTINGS.summarize.maxRetries)),
      enrich: isEnrich(enrich) ? enrich : DEFAULT_SETTINGS.summarize.enrich,
      readmeChars: Math.round(num(summarize.readmeChars, DEFAULT_SETTINGS.summarize.readmeChars)),
      enrichCacheTTLHours: Math.round(num(summarize.enrichCacheTTLHours, DEFAULT_SETTINGS.summarize.enrichCacheTTLHours)),
      enrichConcurrency: Math.round(num(summarize.enrichConcurrency, DEFAULT_SETTINGS.summarize.enrichConcurrency)),
      enrichTimeoutSeconds: Math.round(num(summarize.enrichTimeoutSeconds, DEFAULT_SETTINGS.summarize.enrichTimeoutSeconds)),
      enrichBudgetSeconds: Math.round(num(summarize.enrichBudgetSeconds, DEFAULT_SETTINGS.summarize.enrichBudgetSeconds)),
    },
    releases: {
      includePrerelease: bool(releases.includePrerelease, DEFAULT_SETTINGS.releases.includePrerelease),
      includeDrafts: bool(releases.includeDrafts, DEFAULT_SETTINGS.releases.includeDrafts),
      fallbackToTags: bool(releases.fallbackToTags, DEFAULT_SETTINGS.releases.fallbackToTags),
      baselineOnFirstRun: bool(releases.baselineOnFirstRun, DEFAULT_SETTINGS.releases.baselineOnFirstRun),
      perRepoLimit: Math.round(num(releases.perRepoLimit, DEFAULT_SETTINGS.releases.perRepoLimit)),
      maxNotesChars: Math.round(num(releases.maxNotesChars, DEFAULT_SETTINGS.releases.maxNotesChars)),
      period: isPeriod(releasesPeriod) ? releasesPeriod : DEFAULT_SETTINGS.releases.period,
    },
    output: {
      dir: str(output.dir, DEFAULT_SETTINGS.output.dir).trim() || DEFAULT_SETTINGS.output.dir,
    },
    schedule: {
      enabled: bool(schedule.enabled, DEFAULT_SETTINGS.schedule.enabled),
      time: str(schedule.time, DEFAULT_SETTINGS.schedule.time),
      timezone: str(schedule.timezone, DEFAULT_SETTINGS.schedule.timezone),
      periods: periodList(schedule.periods, DEFAULT_SETTINGS.schedule.periods),
    },
    corePath: str(raw.corePath, DEFAULT_SETTINGS.corePath).trim(),
    coreAutoDownload: bool(raw.coreAutoDownload, DEFAULT_SETTINGS.coreAutoDownload),
  };
}

export interface Problem {
  field: string;
  code: string;
  message: string;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

export function isValidTimezone(timezone: string): boolean {
  if (timezone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * 设置校验。`providers` 来自核心 `version --json` 的 `supportedProviders`
 * （拿不到时按 CORE_PROVIDERS 兜底）——provider 不在核心能力里必须当场拦下，
 * 否则会变成运行时一个莫名其妙的模型错误。
 */
export function validateSettings(settings: Settings, providers: readonly string[] = CORE_PROVIDERS): Problem[] {
  const problems: Problem[] = [];
  const { model, repo, trending, summarize, releases, output, schedule } = settings;

  if (model.provider.trim() === '') {
    problems.push({ field: 'model.provider', code: 'CONFIG_INVALID', message: '缺少 provider' });
  } else if (!providers.includes(model.provider)) {
    problems.push({
      field: 'model.provider',
      code: 'MODEL_PROVIDER_UNSUPPORTED',
      message: `核心不支持 provider「${model.provider}」；可用：${providers.join(' / ')}`,
    });
  }
  if (model.model.trim() === '') {
    problems.push({ field: 'model.model', code: 'CONFIG_INVALID', message: '必须填模型 ID（插件不设隐式默认模型）' });
  }
  // 代理模式（mode=proxy）下端点由插件运行时注入回环代理地址（runner 的 baseURLOverride），
  // baseURL 允许留空——与 quickfill 在 proxy 时清空 baseURL 的做法一致。若不豁免，
  // 就会出现「模型预检通过、保存却被拒」的自相矛盾。
  if (model.mode === 'proxy') {
    if (model.baseURL !== '' && !/^https?:\/\//.test(model.baseURL)) {
      problems.push({ field: 'model.baseURL', code: 'CONFIG_INVALID', message: 'baseURL 必须是 http(s) 地址' });
    }
  } else {
    const baseURL = model.baseURL || PROVIDER_BASE_URLS[model.provider] || '';
    if (baseURL === '') {
      problems.push({ field: 'model.baseURL', code: 'CONFIG_INVALID', message: '该 provider 需要显式 baseURL' });
    } else if (!/^https?:\/\//.test(baseURL)) {
      problems.push({ field: 'model.baseURL', code: 'CONFIG_INVALID', message: 'baseURL 必须是 http(s) 地址' });
    }
  }
  if (model.temperature < 0 || model.temperature > 2) {
    problems.push({ field: 'model.temperature', code: 'CONFIG_INVALID', message: 'temperature 必须在 0–2 之间' });
  }
  if (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0) {
    problems.push({ field: 'model.maxTokens', code: 'CONFIG_INVALID', message: 'maxTokens 必须是正整数' });
  }

  if (repo.path.trim() === '') {
    problems.push({ field: 'repo.path', code: 'CONFIG_INVALID', message: '必须选择归档仓库目录' });
  } else if (!path.isAbsolute(repo.path)) {
    problems.push({ field: 'repo.path', code: 'CONFIG_INVALID', message: '仓库路径必须是绝对路径' });
  }
  if (!Number.isInteger(trending.topN) || trending.topN <= 0) {
    problems.push({ field: 'trending.topN', code: 'CONFIG_INVALID', message: '每语言条数必须是正整数' });
  }
  // summarize.*
  if (!isEnrich(summarize.enrich)) {
    problems.push({ field: 'summarize.enrich', code: 'CONFIG_INVALID', message: 'enrich 必须是 none / repo / readme' });
  }
  if (!Number.isInteger(summarize.batchSize) || summarize.batchSize <= 0) {
    problems.push({ field: 'summarize.batchSize', code: 'CONFIG_INVALID', message: 'batchSize 必须是正整数' });
  }
  if (!Number.isInteger(summarize.maxRetries) || summarize.maxRetries < 0) {
    problems.push({ field: 'summarize.maxRetries', code: 'CONFIG_INVALID', message: 'maxRetries 必须是非负整数' });
  }
  if (!Number.isInteger(summarize.readmeChars) || summarize.readmeChars <= 0) {
    problems.push({ field: 'summarize.readmeChars', code: 'CONFIG_INVALID', message: 'readmeChars 必须是正整数' });
  }
  // releases.*
  if (!isPeriod(releases.period)) {
    problems.push({ field: 'releases.period', code: 'CONFIG_INVALID', message: 'releases.period 必须是 daily / weekly / monthly' });
  }
  if (!Number.isInteger(releases.perRepoLimit) || releases.perRepoLimit < 1 || releases.perRepoLimit > 20) {
    problems.push({ field: 'releases.perRepoLimit', code: 'CONFIG_INVALID', message: 'perRepoLimit 必须是 1–20 的整数' });
  }
  if (!Number.isInteger(releases.maxNotesChars) || releases.maxNotesChars < 500 || releases.maxNotesChars > 20000) {
    problems.push({ field: 'releases.maxNotesChars', code: 'CONFIG_INVALID', message: 'maxNotesChars 必须是 500–20000 的整数' });
  }
  if (output.dir.trim() === '' || path.isAbsolute(output.dir) || output.dir.split(/[\\/]/).includes('..')) {
    problems.push({ field: 'output.dir', code: 'CONFIG_INVALID', message: '输出目录必须是仓库内的相对路径，且不含 ..' });
  }
  if (!TIME_RE.test(schedule.time)) {
    problems.push({ field: 'schedule.time', code: 'CONFIG_INVALID', message: '时间格式必须是 HH:MM 或 HH:MM:SS' });
  }
  if (!isValidTimezone(schedule.timezone)) {
    problems.push({ field: 'schedule.timezone', code: 'CONFIG_INVALID', message: '时区必须是 IANA 名称（如 Asia/Shanghai）' });
  }
  return problems;
}

export function effectiveBaseURL(model: ModelSettings): string {
  return model.baseURL !== '' ? model.baseURL : PROVIDER_BASE_URLS[model.provider] ?? '';
}

/** 核心 `config.Config` 的对象形状（随后序列化成 YAML）。 */
export interface CoreConfig {
  model: {
    provider: string;
    name: string;
    baseURL: string;
    apiKey: string;
    temperature: number;
    maxTokens: number;
    allowDegraded: boolean;
  };
  repo: {
    path: string;
    remote: string;
    baseBranch: string;
    authorName?: string;
    authorEmail?: string;
  };
  pr: { enabled: boolean; titleTemplate: string; labels: string[]; autoMerge: boolean };
  trending: { languages: string[]; since: string; perLanguage: number };
  summarize: {
    batchSize: number;
    maxRetries: number;
    enrich: string;
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
    period: string;
  };
  output: { dir: string; branchPrefix: string; retentionDays: number };
}

/**
 * 生成核心配置。`apiKey` 单独传入：它只能来自宿主凭据或用户当次输入，
 * 绝不来自 settings.json。`period` 是本次运行的标的周期；核心 `run --period`
 * 会用它覆盖 `trending.since`，这里同步写入以免旧核心/调试时口径不一致。
 */
export function toCoreConfig(settings: Settings, apiKey: string, baseURLOverride?: string, period?: Period): CoreConfig {
  const config: CoreConfig = {
    model: {
      provider: settings.model.provider,
      name: settings.model.model,
      baseURL: baseURLOverride ?? effectiveBaseURL(settings.model),
      apiKey,
      temperature: settings.model.temperature,
      maxTokens: settings.model.maxTokens,
      allowDegraded: settings.model.allowDegraded,
    },
    repo: {
      path: settings.repo.path,
      remote: settings.repo.remote,
      baseBranch: settings.repo.baseBranch,
      ...(settings.repo.authorName !== '' ? { authorName: settings.repo.authorName } : {}),
      ...(settings.repo.authorEmail !== '' ? { authorEmail: settings.repo.authorEmail } : {}),
    },
    pr: {
      enabled: settings.repo.commitMode === 'branch' && settings.pr.enabled,
      titleTemplate: settings.pr.titleTemplate,
      labels: settings.pr.labels,
      autoMerge: settings.pr.autoMerge,
    },
    trending: {
      languages: settings.trending.languages,
      since: period ?? settings.trending.since,
      perLanguage: settings.trending.topN,
    },
    summarize: {
      batchSize: settings.summarize.batchSize,
      maxRetries: settings.summarize.maxRetries,
      enrich: settings.summarize.enrich,
      readmeChars: settings.summarize.readmeChars,
      enrichCacheTTLHours: settings.summarize.enrichCacheTTLHours,
      enrichConcurrency: settings.summarize.enrichConcurrency,
      enrichTimeoutSeconds: settings.summarize.enrichTimeoutSeconds,
      enrichBudgetSeconds: settings.summarize.enrichBudgetSeconds,
    },
    releases: {
      // 发版订阅常开：插件侧不再提供开关，是否产出由订阅列表决定。
      enabled: true,
      includePrerelease: settings.releases.includePrerelease,
      includeDrafts: settings.releases.includeDrafts,
      fallbackToTags: settings.releases.fallbackToTags,
      baselineOnFirstRun: settings.releases.baselineOnFirstRun,
      perRepoLimit: settings.releases.perRepoLimit,
      maxNotesChars: settings.releases.maxNotesChars,
      period: settings.releases.period,
    },
    output: {
      dir: settings.output.dir,
      branchPrefix: 'trending/',
      retentionDays: 90,
    },
  };
  return config;
}

/**
 * 极简 YAML 序列化：只覆盖「对象/数组/字符串/数字/布尔」。
 * 字符串一律用 JSON 双引号形式——JSON 字符串是合法 YAML 标量，且能避免
 * `: `、`#`、`- ` 之类的歧义；密钥因此不需要额外转义规则。
 */
export function toYaml(value: unknown, depth = 0): string {
  const pad = '  '.repeat(depth);
  if (Array.isArray(value)) return toYamlScalar(value);
  if (typeof value === 'object' && value !== null) {
    const lines: string[] = [];
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        lines.push(`${pad}${key}:\n${toYaml(item, depth + 1)}`);
      } else {
        lines.push(`${pad}${key}: ${toYamlScalar(item)}`);
      }
    }
    return lines.join('\n');
  }
  return `${pad}${toYamlScalar(value)}`;
}

function toYamlScalar(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => toYamlScalar(item)).join(', ')}]`;
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return 'null';
}
