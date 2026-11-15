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

/**
 * 摘要输出语言支持集（首期 zh/en）。核心 `language.outputLanguage` 接受 BCP47，
 * 但插件只暴露这里列出的语种；显式值必须落在这个集合内（见 `validateSettings`）。
 * `''` = 跟随宿主语言（宿主 locale 读不到 / 非中英时回落 `zh`，见 `host-language.ts`）。
 */
export const SUPPORTED_OUTPUT_LANGUAGES: readonly string[] = ['zh', 'en'];

/** 语言标签是否是「主标签在支持集内」的合法 BCP47（大小写不敏感，如 `en-US` 主标签 `en`）。 */
export function isSupportedOutputLanguage(value: string): boolean {
  const primary = value.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return SUPPORTED_OUTPUT_LANGUAGES.includes(primary);
}
/**
 * 三种可用方式：本机 `gh` 登录态、手动 PAT、浏览器 GitHub 登录（读核心凭据记录）。
 * 历史的 `device` 在归一化时迁移为 `gh`；`browser` 无记录时会降级到 ref/env 兜底。
 */
export type AuthMode = 'pat' | 'gh' | 'browser';

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
  /**
   * 备选模型链（核心 `ModelConfig.fallbacks`）。按序尝试；空数组 = 不启用（默认）。
   * 每一项是「完整且独立」的模型配置（provider/baseURL/apiKeyRef 各自解析），
   * 与主模型同构；插件侧额外带 `mode`/`hostProvider`（核心不认，只用于凭据与代理路由）。
   */
  fallbacks: ModelEntryView[];
}

/**
 * 备选模型来源。`custom`=手填；`dsh`=从 DSH 已配置目录沿用（保存时定格成具体字段）。
 * 未知值在归一化时回落 `custom`（向后兼容旧 settings.json）。
 */
export type ModelEntrySource = 'custom' | 'dsh';

/**
 * 备选模型链上的一环（插件侧视图）。字段与主模型 `ModelSettings` 对齐，
 * 但**不含** `allowDegraded`：降级只在整条链全败后由主模型的 allowDegraded 决定
 * （设计 §8 Q4），链上单项不单独持有降级开关。
 * 映射到核心 YAML 时：`model`→核心 `name`、`apiKeyRef`→核心 `apiKey`（密钥运行时注入）。
 */
export interface ModelEntryView {
  /**
   * 来源：`custom`=手填（默认，向后兼容）；`dsh`=从 DSH 已配置目录沿用、保存时定格成下方各字段。
   * 纯插件侧元数据：`toCoreConfig` 不读它，只影响设置页交互（只读哪些字段）。
   */
  source: ModelEntrySource;
  provider: Provider;
  /** `direct` / `proxy`，语义同主模型；`proxy` 时由插件为该项单独注入回环代理地址。 */
  mode: 'direct' | 'proxy';
  /** `mode=proxy` 时该项转发到哪个宿主 provider 路由（核心不认）。 */
  hostProvider: string;
  baseURL: string;
  model: string;
  apiKeyRef: string;
  temperature: number;
  maxTokens: number;
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
 * 本地 star 观测库（核心 `observe.*`，core ≥ 0.8.8）。
 * 观测库让「今日新增」来自本地每日快照的差分，而不是趋势页上的一行字；
 * 默认开启，`enabled=false` 是回滚开关（回到「增量只来自趋势页」的旧行为）。
 * 存储位置由核心自己解析到 `$DSH_HOME`（计划 D4），**不**在这里暴露，避免用户
 * 把观测库指进归档仓库。
 */
export interface ObserveSettings {
  /** 是否启用观测库；关闭即回到旧行为（`starsInPeriod` 只来自趋势页/搜索）。 */
  enabled: boolean;
  /** 首次见到的仓库从历史接口回填多少天（0=不回填，从今天开始攒）。 */
  backfillDays: number;
  /** 单次运行最多记多少个候选仓库（上限 300，约 3 个 GraphQL 批量/天）。 */
  maxCandidates: number;
}

/**
 * 每周发版运行的插件侧节奏（核心没有这个字段，**绝不**写进核心 YAML）。
 * 与榜单调度（`schedule.*`）完全独立：两者各有自己的开关与时间点。
 */
export interface ReleaseScheduleSettings {
  enabled: boolean;
  /** ISO 星期：1=周一 … 7=周日（和 `Intl` 的 0=周日 不同，避免调用方来回换算）。 */
  weekday: number;
  /** `HH:MM[:SS]`（本地墙钟，按 timezone 解释）。 */
  time: string;
  timezone: string;
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
  /**
   * 首次订阅的仓库基线运行时补发最近 N 个版本（核心 `releases.backfillLatest`）。
   * `0` = 不补发，只记录基线、不产文档（首次变更分析会为空）；`> 0` = 把最近 N 个
   * 版本直接摘要进文档作为起点。之后每次照常做增量 diff——补发的版本会进游标，不重复总结。
   */
  backfillLatest: number;
  /** 文档**列出**多少个版本（核心 0.7.0 起不再限制抓取条数，摘要覆盖全周）。 */
  perRepoLimit: number;
  maxNotesChars: number;
  /** 每仓库每周一条中文摘要的字数上限（核心 `releases.summaryMaxChars`）。 */
  summaryMaxChars: number;
  /** 每仓库文档的行数预算，超了核心才开新卷（核心 `releases.docMaxLines`）。 */
  docMaxLines: number;
  /** 订阅检查并发；`auto` 由插件按订阅数解析成 1–8 的数字（核心只认数字）。 */
  concurrency: 'auto' | number;
  /** 订阅阶段的模型预算秒数；`auto` 由插件按订阅数解析（核心只认数字）。 */
  budgetSeconds: 'auto' | number;
  /**
   * 发版摘要周期。核心 0.7.0 只实现 `weekly`（一个 ISO 周一次模型调用），
   * 因此这里保留枚举类型只为让校验能明确告诉用户「daily/monthly 已不支持」。
   */
  period: Period;
  /** 插件侧每周触发节奏；核心配置里只用到它的 `timezone`（切周口径），不写整个对象。 */
  schedule: ReleaseScheduleSettings;
}

/**
 * 推送渠道三取值（核心 `notify.channels`）。键名即渠道名，核心 YAML 也用它。
 * 顺序即界面展示顺序：企微 / 钉钉 / 飞书。
 */
export type NotifyChannelKey = 'dingtalk' | 'lark' | 'wecom';
export const NOTIFY_CHANNEL_KEYS: readonly NotifyChannelKey[] = ['dingtalk', 'lark', 'wecom'];

/** 各渠道允许的 `msgtype`（核心按渠道校验，见设计 §4.1）。 */
export const NOTIFY_MSGTYPES: Record<NotifyChannelKey, readonly string[]> = {
  dingtalk: ['markdown', 'text'],
  lark: ['post', 'text'],
  wecom: ['markdown', 'text'],
};

/** 投递策略（核心 `notify.strategy`）：广播 / 全员必达 / 降级到首个成功渠道。 */
export type NotifyStrategy = 'broadcast' | 'requireAll' | 'firstSuccess';
export const NOTIFY_STRATEGIES: readonly NotifyStrategy[] = ['broadcast', 'requireAll', 'firstSuccess'];

export function isNotifyStrategy(value: unknown): value is NotifyStrategy {
  return value === 'broadcast' || value === 'requireAll' || value === 'firstSuccess';
}

/**
 * 单个推送渠道配置（核心 `config.NotifyChannel`）。字段与核心 YAML 一一对应：
 * `enabled / webhookURL / secret / msgtype`。`wecom` 无 `secret`（不支持加签），
 * 归一化时对 `secret` 做形态保留即可，核心对该渠道忽略。
 * 密钥（webhookURL / secret）沿用 trendradar 约定只写 `${VAR}` 引用，不写明文。
 */
export interface NotifyChannelSettings {
  enabled: boolean;
  webhookURL: string;
  secret: string;
  msgtype: string;
}

/** 推送内容分区开关（核心 `notify.sections`）：榜单一条 / 订阅一条。 */
export interface NotifySectionsSettings {
  trending: boolean;
  releases: boolean;
}

/**
 * 每日推送通知配置（核心 `notify.*`，core ≥ 0.8.9 / 契约 0.8.0）。
 * 字段与核心 `config.NotifyConfig` **一一对应，字段名不翻译、不增不减**（AGENTS「唯一映射」）。
 * `enabled=false` 时整段旁路（核心不产出、不推送），但插件仍写整段 YAML 保持形状稳定。
 */
export interface NotifySettings {
  enabled: boolean;
  sections: NotifySectionsSettings;
  /** 跳过（merged / pr-closed / unchanged）时是否仍推已有内容。 */
  onSkipped: boolean;
  /** 订阅本次无任何变更时是否发一条「本周无变动」。 */
  onEmptyReleases: boolean;
  strategy: NotifyStrategy;
  /** 三渠道配置；键即渠道名。 */
  channels: Record<NotifyChannelKey, NotifyChannelSettings>;
  /** 摘要里最多点名 N 个仓库，其余折叠成「其余 N 个」。 */
  maxReposPerSection: number;
  /** 正文硬上限字符数；`0` = 按渠道自动取默认上限。 */
  maxBodyChars: number;
  /** 单渠道单次请求超时秒数。 */
  timeoutSeconds: number;
  /** 模型总结摘要的目标字数（榜单/订阅各一条，分别约束）。 */
  summaryMaxChars: number;
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
  observe: ObserveSettings;
  releases: ReleasesSettings;
  notify: NotifySettings;
  output: OutputSettings;
  schedule: ScheduleSettings;
  /** 核心二进制覆盖；只在开发/排障时用，对应 TRENDING_DIGEST_CORE。 */
  corePath: string;
  /** 缓存缺失时是否自动从 Release 下载核心（首次运行需要联网）。 */
  coreAutoDownload: boolean;
  /**
   * 摘要输出语言（核心 `language.outputLanguage`）。
   * `''` = 跟随宿主语言（宿主 locale 的 preference，读不到或非中英时回落 `zh`）；
   * 非空时必须是 `SUPPORTED_OUTPUT_LANGUAGES` 里的主标签（见 `validateSettings`）。
   * 显式值优先，宿主语言次之，最后回落到 `zh`——见 `src/host/host-language.ts`。
   */
  outputLanguage: string;
  /**
   * 核心进程的出站网络代理（如 http://127.0.0.1:7890）。GUI 宿主往往不继承
   * shell 的 http(s)_proxy，国内直连 GitHub 会超时；这里显式注入到核心子进程的
   * HTTP_PROXY/HTTPS_PROXY/ALL_PROXY（含大小写两份）。空串 = 不使用代理。
   */
  network: NetworkSettings;
  /**
   * 单次运行的编排参数（不进核心 YAML：核心没有这些字段，只在插件层生效）。
   */
  run: RunSettings;
}

export interface NetworkSettings {
  proxy: string;
}

export interface RunSettings {
  /**
   * 单次核心运行的硬超时（毫秒）。超时后 SIGTERM→3s→SIGKILL。
   * 默认 5 分钟：给 observe 阶段几十个仓库串行抓取留足余量（GitHub 单请求
   * 10s×4 重试，慢网络下容易堆到分钟级）。仅影响插件对核心进程的看门狗，
   * 与核心内部 budgetSeconds 无关。
   */
  timeoutMs: number;
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
    fallbacks: [],
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
  trending: { since: 'daily', languages: ['all', 'typescript', 'python', 'go', 'rust'] },
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
  observe: { enabled: true, backfillDays: 30, maxCandidates: 300 },
  releases: {
    includePrerelease: false,
    includeDrafts: false,
    fallbackToTags: true,
    baselineOnFirstRun: true,
    backfillLatest: 3,
    perRepoLimit: 10,
    maxNotesChars: 4000,
    summaryMaxChars: 1200,
    docMaxLines: 600,
    concurrency: 'auto',
    budgetSeconds: 'auto',
    period: 'weekly',
    schedule: { enabled: true, weekday: 1, time: '08:00:00', timezone: 'Asia/Shanghai' },
  },
  notify: {
    enabled: false,
    sections: { trending: true, releases: true },
    onSkipped: false,
    onEmptyReleases: false,
    strategy: 'broadcast',
    channels: {
      dingtalk: { enabled: false, webhookURL: '${DINGTALK_WEBHOOK}', secret: '${DINGTALK_SECRET}', msgtype: 'markdown' },
      lark: { enabled: false, webhookURL: '${LARK_WEBHOOK}', secret: '${LARK_SECRET}', msgtype: 'post' },
      wecom: { enabled: false, webhookURL: '${WECOM_WEBHOOK}', secret: '', msgtype: 'markdown' },
    },
    maxReposPerSection: 10,
    maxBodyChars: 0,
    timeoutSeconds: 15,
    summaryMaxChars: 800,
  },
  output: { dir: 'trending' },
  schedule: { enabled: true, time: '08:30:00', timezone: 'Asia/Shanghai', periods: ['daily', 'weekly', 'monthly'] },
  corePath: '',
  coreAutoDownload: true,
  outputLanguage: '',
  network: { proxy: '' },
  run: { timeoutMs: 300_000 },
};

/** 核心支持的 provider 默认端点（空字符串 = 必须由用户填）。 */
export const PROVIDER_BASE_URLS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com/v1',
  'openai-compatible': '',
  anthropic: '',
};

export const CORE_PROVIDERS = ['deepseek', 'openai-compatible'] as const;

/** 设置页分区；分段保存时只提交并校验对应分区，互不牵连。 */
export const SETTINGS_SECTIONS = ['source', 'model', 'repo', 'auth', 'scope', 'summarize', 'releases', 'schedule', 'notify'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** 校验问题字段 → 所属分区（用于分段保存时只把本分区的问题回给界面）。 */
export function sectionOfField(field: string): SettingsSection | undefined {
  if (field.startsWith('model.')) return 'model';
  if (field.startsWith('repo.') || field.startsWith('output.') || field.startsWith('pr.')) return 'repo';
  if (field.startsWith('github.')) return 'auth';
  if (field.startsWith('trending.')) return 'scope';
  if (field.startsWith('summarize.')) return 'scope';
  if (field === 'outputLanguage') return 'scope';
  if (field.startsWith('observe.')) return 'scope';
  if (field.startsWith('releases.')) return 'releases';
  if (field.startsWith('notify.')) return 'notify';
  if (field.startsWith('schedule.')) return 'scope';
  if (field === 'corePath' || field === 'coreAutoDownload' || field === 'network.proxy' || field === 'run.timeoutMs') return 'source';
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
      next.network = incoming.network;
      next.run = incoming.run;
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
      // 设置页「榜单」tab 同时承载榜单范围、调度、摘要与用量、观测库，这几组字段的
      // 保存都走 scope 分段（与 client 的 sectionSlice('scope') 对齐）。分别赋值成
      // 各自的子对象，避免整块 incoming 覆盖带来未知字段。
      next.trending = incoming.trending;
      next.observe = incoming.observe;
      next.summarize = incoming.summarize;
      next.schedule = incoming.schedule;
      next.outputLanguage = incoming.outputLanguage;
      break;
    case 'summarize':
      next.summarize = incoming.summarize;
      next.outputLanguage = incoming.outputLanguage;
      break;
    case 'releases':
      next.releases = incoming.releases;
      break;
    case 'notify':
      next.notify = incoming.notify;
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
 * 「auto 或整数」的归一化（核心 0.7.0 的 `releases.concurrency` / `budgetSeconds`）。
 * 只做形态收敛，不做范围收敛：越界留给 `validateSettings` 报字段路径，
 * 免得用户填 9 却被悄悄改成 8 还不知道。
 */
function autoNumber(value: unknown, fallback: 'auto' | number): 'auto' | number {
  if (value === 'auto') return 'auto';
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  return fallback;
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
 * 备选模型链归一：读数组、逐项收敛成 `ModelEntryView`。
 * 空项判定：`provider` 与 `model` 都为空（trim 后）视为无效项，直接丢弃——
 * 设置页里刚点「添加」还没填的空白行不会被当成一条会跑的真实备选。
 * 只做形态收敛，不做合法性判断（provider 支持集、proxy 需 baseURL 等留给 validateSettings）。
 */
function normalizeFallbacks(value: unknown): ModelEntryView[] {
  if (!Array.isArray(value)) return [];
  const items: ModelEntryView[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const provider = str(raw.provider, '').trim();
    const model = str(raw.model, '').trim();
    if (provider === '' && model === '') continue; // 空项丢弃
    items.push({
      source: str(raw.source, 'custom') === 'dsh' ? 'dsh' : 'custom',
      provider,
      mode: str(raw.mode, 'direct') === 'proxy' ? 'proxy' : 'direct',
      hostProvider: str(raw.hostProvider, '').trim(),
      baseURL: str(raw.baseURL, '').trim(),
      model,
      apiKeyRef: str(raw.apiKeyRef, '').trim(),
      temperature: num(raw.temperature, DEFAULT_SETTINGS.model.temperature),
      maxTokens: num(raw.maxTokens, DEFAULT_SETTINGS.model.maxTokens),
    });
  }
  return items;
}

/**
 * 单个渠道归一：`enabled / webhookURL / secret / msgtype` 四字段形态收敛。
 * `msgtype` 非法/缺失 → 回落到该渠道默认（`DEFAULT_SETTINGS.notify.channels[key].msgtype`），
 * 不做白名单强制（非法值留给 validateSettings 报字段路径，避免静默改写）。
 * `webhookURL` / `secret` 原样保留字符串（含 `${VAR}` 引用），不做任何解析/替换——密钥不进插件。
 */
function normalizeNotifyChannel(
  raw: Record<string, unknown>,
  key: NotifyChannelKey,
): NotifyChannelSettings {
  const defaults = DEFAULT_SETTINGS.notify.channels[key];
  return {
    enabled: bool(raw.enabled, defaults.enabled),
    webhookURL: str(raw.webhookURL, defaults.webhookURL).trim(),
    secret: str(raw.secret, defaults.secret).trim(),
    msgtype: str(raw.msgtype, defaults.msgtype).trim() || defaults.msgtype,
  };
}

/**
 * 推送通知归一：把任意来源对象收敛成完整 `NotifySettings`。
 * 三渠道固定存在（缺哪个补默认），保证 `channels` 形状稳定、界面总能渲染三张卡。
 */
function normalizeNotify(value: unknown): NotifySettings {
  const defaults = DEFAULT_SETTINGS.notify;
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const sections = (raw.sections ?? {}) as Record<string, unknown>;
  const channels = (raw.channels ?? {}) as Record<string, unknown>;
  const channelOf = (key: NotifyChannelKey): NotifyChannelSettings =>
    normalizeNotifyChannel(
      (typeof channels[key] === 'object' && channels[key] !== null ? channels[key] : {}) as Record<string, unknown>,
      key,
    );
  const strategy = str(raw.strategy, defaults.strategy);
  return {
    enabled: bool(raw.enabled, defaults.enabled),
    sections: {
      trending: bool(sections.trending, defaults.sections.trending),
      releases: bool(sections.releases, defaults.sections.releases),
    },
    onSkipped: bool(raw.onSkipped, defaults.onSkipped),
    onEmptyReleases: bool(raw.onEmptyReleases, defaults.onEmptyReleases),
    strategy: isNotifyStrategy(strategy) ? strategy : defaults.strategy,
    channels: {
      dingtalk: channelOf('dingtalk'),
      lark: channelOf('lark'),
      wecom: channelOf('wecom'),
    },
    maxReposPerSection: Math.round(num(raw.maxReposPerSection, defaults.maxReposPerSection)),
    maxBodyChars: Math.round(num(raw.maxBodyChars, defaults.maxBodyChars)),
    timeoutSeconds: Math.round(num(raw.timeoutSeconds, defaults.timeoutSeconds)),
    summaryMaxChars: Math.round(num(raw.summaryMaxChars, defaults.summaryMaxChars)),
  };
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
  const observe = (raw.observe ?? {}) as Record<string, unknown>;
  const releases = (raw.releases ?? {}) as Record<string, unknown>;
  const releasesSchedule = (releases.schedule ?? {}) as Record<string, unknown>;
  const output = (raw.output ?? {}) as Record<string, unknown>;
  const schedule = (raw.schedule ?? {}) as Record<string, unknown>;
  const run = (raw.run ?? {}) as Record<string, unknown>;
  const commitMode = str(repo.commitMode, DEFAULT_SETTINGS.repo.commitMode);
  const authMode = str(github.authMode, DEFAULT_SETTINGS.github.authMode);
  const since = str(trending.since, DEFAULT_SETTINGS.trending.since);
  const enrich = str(summarize.enrich, DEFAULT_SETTINGS.summarize.enrich);
  // 只把「不是周期枚举」的垃圾值收敛成默认：daily/monthly 保留原值，
  // 交给 validateSettings 明确告诉用户本版本只支持 weekly（静默改写会让人不知道为什么没生效）。
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
      fallbacks: normalizeFallbacks(model.fallbacks),
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
      // 白名单三值：'pat' / 'gh' / 'browser'；其余（含旧版 'device'）统一迁移到真正可用的「本机 gh」。
      authMode: authMode === 'pat' || authMode === 'browser' ? authMode : 'gh',
      tokenRef: str(github.tokenRef, DEFAULT_SETTINGS.github.tokenRef).trim() || DEFAULT_SETTINGS.github.tokenRef,
    },
    trending: {
      since: isPeriod(since) ? since : 'daily',
      languages: strArray(trending.languages, DEFAULT_SETTINGS.trending.languages),
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
    observe: {
      enabled: bool(observe.enabled, DEFAULT_SETTINGS.observe.enabled),
      backfillDays: Math.round(num(observe.backfillDays, DEFAULT_SETTINGS.observe.backfillDays)),
      maxCandidates: Math.round(num(observe.maxCandidates, DEFAULT_SETTINGS.observe.maxCandidates)),
    },
    releases: {
      includePrerelease: bool(releases.includePrerelease, DEFAULT_SETTINGS.releases.includePrerelease),
      includeDrafts: bool(releases.includeDrafts, DEFAULT_SETTINGS.releases.includeDrafts),
      fallbackToTags: bool(releases.fallbackToTags, DEFAULT_SETTINGS.releases.fallbackToTags),
      baselineOnFirstRun: bool(releases.baselineOnFirstRun, DEFAULT_SETTINGS.releases.baselineOnFirstRun),
      backfillLatest: Math.round(num(releases.backfillLatest, DEFAULT_SETTINGS.releases.backfillLatest)),
      perRepoLimit: Math.round(num(releases.perRepoLimit, DEFAULT_SETTINGS.releases.perRepoLimit)),
      maxNotesChars: Math.round(num(releases.maxNotesChars, DEFAULT_SETTINGS.releases.maxNotesChars)),
      summaryMaxChars: Math.round(num(releases.summaryMaxChars, DEFAULT_SETTINGS.releases.summaryMaxChars)),
      docMaxLines: Math.round(num(releases.docMaxLines, DEFAULT_SETTINGS.releases.docMaxLines)),
      concurrency: autoNumber(releases.concurrency, DEFAULT_SETTINGS.releases.concurrency),
      budgetSeconds: autoNumber(releases.budgetSeconds, DEFAULT_SETTINGS.releases.budgetSeconds),
      period: isPeriod(releasesPeriod) ? releasesPeriod : DEFAULT_SETTINGS.releases.period,
      schedule: {
        enabled: bool(releasesSchedule.enabled, DEFAULT_SETTINGS.releases.schedule.enabled),
        weekday: Math.round(num(releasesSchedule.weekday, DEFAULT_SETTINGS.releases.schedule.weekday)),
        time: str(releasesSchedule.time, DEFAULT_SETTINGS.releases.schedule.time),
        timezone: str(releasesSchedule.timezone, DEFAULT_SETTINGS.releases.schedule.timezone),
      },
    },
    notify: normalizeNotify(raw.notify),
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
    // 缺失/空串/非字符串一律归一为 ''（= 跟随宿主）；合法性留给 validateSettings。
    outputLanguage: str(raw.outputLanguage, DEFAULT_SETTINGS.outputLanguage).trim().toLowerCase(),
    network: {
      proxy: str((raw.network as Record<string, unknown> | undefined)?.proxy, DEFAULT_SETTINGS.network.proxy).trim(),
    },
    run: {
      // 缺失/非法一律回落默认；范围合法性交给 validateSettings。
      timeoutMs: num(run.timeoutMs, DEFAULT_SETTINGS.run.timeoutMs),
    },
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

/** `auto` 或落在 [min, max] 的整数；这两种写法核心都接受。 */
function autoInRange(value: 'auto' | number, min: number, max: number): boolean {
  if (value === 'auto') return true;
  return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * 设置校验。`providers` 来自核心 `version --json` 的 `supportedProviders`
 * （拿不到时按 CORE_PROVIDERS 兜底）——provider 不在核心能力里必须当场拦下，
 * 否则会变成运行时一个莫名其妙的模型错误。
 */
export function validateSettings(settings: Settings, providers: readonly string[] = CORE_PROVIDERS): Problem[] {
  const problems: Problem[] = [];
  const { model, repo, trending, summarize, releases, output, schedule } = settings;

  // network.proxy：空串 = 不代理；否则必须是 http(s)://host:port 形态的 URL。
  const proxy = (settings.network?.proxy ?? '').trim();
  if (proxy !== '' && !/^https?:\/\/[^\s]+$/.test(proxy)) {
    problems.push({
      field: 'network.proxy',
      code: 'CONFIG_INVALID',
      message: '代理必须是 http(s):// 地址（如 http://127.0.0.1:7890），留空则不使用代理',
    });
  }

  // run.timeoutMs：单次运行硬超时，60s–30min 的整数毫秒；越界会给用户一个莫名其妙的
  // 「运行很久才失败」，所以当场拦下。
  const runTimeout = settings.run?.timeoutMs;
  if (!Number.isInteger(runTimeout) || runTimeout < 60_000 || runTimeout > 1_800_000) {
    problems.push({
      field: 'run.timeoutMs',
      code: 'CONFIG_INVALID',
      message: '单次运行超时必须是 60000–1800000 之间的整数毫秒（默认 300000，即 5 分钟）',
    });
  }

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

  // 备选模型链：每项与主模型同构校验（provider 支持集、model 非空、proxy 需 baseURL、
  // 温度/Token 范围）。字段路径带下标（`model.fallbacks.<i>.*`），方便界面定位到具体一行。
  (model.fallbacks ?? []).forEach((entry, index) => {
    const at = `model.fallbacks.${index}`;
    if (entry.provider.trim() === '') {
      problems.push({ field: `${at}.provider`, code: 'CONFIG_INVALID', message: '缺少 provider' });
    } else if (!providers.includes(entry.provider)) {
      problems.push({
        field: `${at}.provider`,
        code: 'MODEL_PROVIDER_UNSUPPORTED',
        message: `核心不支持 provider「${entry.provider}」；可用：${providers.join(' / ')}`,
      });
    }
    if (entry.model.trim() === '') {
      problems.push({ field: `${at}.model`, code: 'CONFIG_INVALID', message: '必须填模型 ID' });
    }
    // 与主模型一致：proxy 模式下端点由插件运行时注入回环代理，baseURL 允许留空。
    if (entry.mode === 'proxy') {
      if (entry.baseURL !== '' && !/^https?:\/\//.test(entry.baseURL)) {
        problems.push({ field: `${at}.baseURL`, code: 'CONFIG_INVALID', message: 'baseURL 必须是 http(s) 地址' });
      }
    } else {
      const baseURL = entry.baseURL || PROVIDER_BASE_URLS[entry.provider] || '';
      if (baseURL === '') {
        problems.push({ field: `${at}.baseURL`, code: 'CONFIG_INVALID', message: '该 provider 需要显式 baseURL' });
      } else if (!/^https?:\/\//.test(baseURL)) {
        problems.push({ field: `${at}.baseURL`, code: 'CONFIG_INVALID', message: 'baseURL 必须是 http(s) 地址' });
      }
    }
    if (entry.temperature < 0 || entry.temperature > 2) {
      problems.push({ field: `${at}.temperature`, code: 'CONFIG_INVALID', message: 'temperature 必须在 0–2 之间' });
    }
    if (!Number.isInteger(entry.maxTokens) || entry.maxTokens <= 0) {
      problems.push({ field: `${at}.maxTokens`, code: 'CONFIG_INVALID', message: 'maxTokens 必须是正整数' });
    }
    // 沿用 DSH 的备选项：proxy 来源必须定格了宿主路由（hostProvider），否则运行时无从转发。
    // direct 的凭据（apiKeyRef）允许为空——运行时解析不到会按现状回落到下一项，不阻断保存。
    if (entry.source === 'dsh' && entry.mode === 'proxy' && entry.hostProvider.trim() === '') {
      problems.push({
        field: `${at}.hostProvider`,
        code: 'CONFIG_INVALID',
        message: '沿用 DSH 的代理型备选缺少宿主路由，请重新从 DSH 选择模型',
      });
    }
  });

  if (repo.path.trim() === '') {
    problems.push({ field: 'repo.path', code: 'CONFIG_INVALID', message: '必须选择归档仓库目录' });
  } else if (!path.isAbsolute(repo.path)) {
    problems.push({ field: 'repo.path', code: 'CONFIG_INVALID', message: '仓库路径必须是绝对路径' });
  }
  // summarize.*
  if (!isEnrich(summarize.enrich)) {
    problems.push({ field: 'summarize.enrich', code: 'CONFIG_INVALID', message: 'enrich 必须是 none / repo / readme' });
  }
  // outputLanguage：空串 = 跟随宿主，允许；非空时必须是支持语种（主标签在支持集内）。
  if (settings.outputLanguage !== '' && !isSupportedOutputLanguage(settings.outputLanguage)) {
    problems.push({
      field: 'outputLanguage',
      code: 'CONFIG_INVALID',
      message: `摘要语言只支持 ${SUPPORTED_OUTPUT_LANGUAGES.join(' / ')}（或留空跟随宿主），收到「${settings.outputLanguage}」`,
    });
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
  // observe.*
  const { observe } = settings;
  if (!Number.isInteger(observe.backfillDays) || observe.backfillDays < 0 || observe.backfillDays > 365) {
    problems.push({ field: 'observe.backfillDays', code: 'CONFIG_INVALID', message: 'backfillDays 必须是 0–365 的整数' });
  }
  if (!Number.isInteger(observe.maxCandidates) || observe.maxCandidates < 1 || observe.maxCandidates > 1000) {
    problems.push({ field: 'observe.maxCandidates', code: 'CONFIG_INVALID', message: 'maxCandidates 必须是 1–1000 的整数' });
  }
  // releases.*
  // 0.7.0 只实现每周一次：daily/monthly 明确拒绝，而不是悄悄按 weekly 跑。
  if (releases.period !== 'weekly') {
    problems.push({
      field: 'releases.period',
      code: 'CONFIG_INVALID',
      message: '本版本只支持每周（weekly）订阅摘要，请把 releases.period 改为 weekly',
    });
  }
  if (!Number.isInteger(releases.perRepoLimit) || releases.perRepoLimit < 1 || releases.perRepoLimit > 20) {
    problems.push({ field: 'releases.perRepoLimit', code: 'CONFIG_INVALID', message: 'perRepoLimit 必须是 1–20 的整数' });
  }
  if (!Number.isInteger(releases.backfillLatest) || releases.backfillLatest < 0 || releases.backfillLatest > 20) {
    problems.push({ field: 'releases.backfillLatest', code: 'CONFIG_INVALID', message: 'backfillLatest 必须是 0–20 的整数' });
  }
  if (!Number.isInteger(releases.maxNotesChars) || releases.maxNotesChars < 500 || releases.maxNotesChars > 20000) {
    problems.push({ field: 'releases.maxNotesChars', code: 'CONFIG_INVALID', message: 'maxNotesChars 必须是 500–20000 的整数' });
  }
  if (!Number.isInteger(releases.summaryMaxChars) || releases.summaryMaxChars < 500 || releases.summaryMaxChars > 2000) {
    problems.push({ field: 'releases.summaryMaxChars', code: 'CONFIG_INVALID', message: 'summaryMaxChars 必须是 500–2000 的整数' });
  }
  if (!Number.isInteger(releases.docMaxLines) || releases.docMaxLines < 100 || releases.docMaxLines > 2000) {
    problems.push({ field: 'releases.docMaxLines', code: 'CONFIG_INVALID', message: 'docMaxLines 必须是 100–2000 的整数' });
  }
  if (!autoInRange(releases.concurrency, 1, 8)) {
    problems.push({ field: 'releases.concurrency', code: 'CONFIG_INVALID', message: 'concurrency 必须是 auto 或 1–8 的整数' });
  }
  if (!autoInRange(releases.budgetSeconds, 1, 300)) {
    problems.push({ field: 'releases.budgetSeconds', code: 'CONFIG_INVALID', message: 'budgetSeconds 必须是 auto 或 1–300 的整数' });
  }
  // releases.schedule.* 是插件自己的每周节奏（不进核心 YAML），字段路径仍归 releases 分区。
  if (!Number.isInteger(releases.schedule.weekday) || releases.schedule.weekday < 1 || releases.schedule.weekday > 7) {
    problems.push({ field: 'releases.schedule.weekday', code: 'CONFIG_INVALID', message: '订阅检查日必须是 ISO 星期 1–7（1=周一）' });
  }
  if (!TIME_RE.test(releases.schedule.time)) {
    problems.push({ field: 'releases.schedule.time', code: 'CONFIG_INVALID', message: '时间格式必须是 HH:MM 或 HH:MM:SS' });
  }
  if (!isValidTimezone(releases.schedule.timezone)) {
    problems.push({ field: 'releases.schedule.timezone', code: 'CONFIG_INVALID', message: '时区必须是 IANA 名称（如 Asia/Shanghai）' });
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
  // notify.*（核心 `notify` 段，core ≥ 0.8.9）。只在启用时做「至少一个分区 / 至少一个渠道」的结构校验，
  // 关闭时整段旁路，不因未配置的渠道卡阻塞保存（用户可能只切总开关、还没填渠道）。
  const { notify } = settings;
  if (!isNotifyStrategy(notify.strategy)) {
    problems.push({
      field: 'notify.strategy',
      code: 'CONFIG_INVALID',
      message: '投递策略必须是 broadcast / requireAll / firstSuccess',
    });
  }
  if (!Number.isInteger(notify.maxReposPerSection) || notify.maxReposPerSection < 1 || notify.maxReposPerSection > 50) {
    problems.push({ field: 'notify.maxReposPerSection', code: 'CONFIG_INVALID', message: '最多点名仓库数必须是 1–50 的整数' });
  }
  // maxBodyChars：0 = 按渠道自动（允许）；>0 时落在 200–20000 的合理区间。
  if (!Number.isInteger(notify.maxBodyChars) || notify.maxBodyChars < 0 || (notify.maxBodyChars > 0 && notify.maxBodyChars < 200) || notify.maxBodyChars > 20000) {
    problems.push({ field: 'notify.maxBodyChars', code: 'CONFIG_INVALID', message: '正文上限必须是 0（按渠道自动）或 200–20000 的整数' });
  }
  if (!Number.isInteger(notify.timeoutSeconds) || notify.timeoutSeconds < 1 || notify.timeoutSeconds > 120) {
    problems.push({ field: 'notify.timeoutSeconds', code: 'CONFIG_INVALID', message: '渠道超时必须是 1–120 的整数秒' });
  }
  if (!Number.isInteger(notify.summaryMaxChars) || notify.summaryMaxChars < 100 || notify.summaryMaxChars > 4000) {
    problems.push({ field: 'notify.summaryMaxChars', code: 'CONFIG_INVALID', message: '摘要字数必须是 100–4000 的整数' });
  }
  // 逐渠道：msgtype 必须在允许集合内；启用的渠道 webhook 必须非空（不校验 ${VAR} 是否已解析——
  // 插件不接触密钥与 .env，解析发生在核心，插件只保证形态上已填）。
  for (const key of NOTIFY_CHANNEL_KEYS) {
    const channel = notify.channels[key];
    const allowed = NOTIFY_MSGTYPES[key];
    if (!allowed.includes(channel.msgtype)) {
      problems.push({
        field: `notify.channels.${key}.msgtype`,
        code: 'CONFIG_INVALID',
        message: `${key} 的消息类型必须是 ${allowed.join(' / ')}`,
      });
    }
    if (channel.enabled && channel.webhookURL.trim() === '') {
      problems.push({
        field: `notify.channels.${key}.webhookURL`,
        code: 'CONFIG_INVALID',
        message: `${key} 已启用但缺少 webhook 地址`,
      });
    }
  }
  // 启用总开关时：至少一个内容分区、至少一个渠道——否则「开了却什么都不发」，是典型的点了没反应。
  if (notify.enabled) {
    if (!notify.sections.trending && !notify.sections.releases) {
      problems.push({ field: 'notify.sections', code: 'CONFIG_INVALID', message: '启用通知时至少要勾选一个推送内容（榜单或订阅）' });
    }
    const anyChannel = NOTIFY_CHANNEL_KEYS.some((key) => notify.channels[key].enabled);
    if (!anyChannel) {
      problems.push({ field: 'notify.channels', code: 'CONFIG_INVALID', message: '启用通知时至少要启用一个推送渠道' });
    }
  }
  return problems;
}

export function effectiveBaseURL(model: { baseURL: string; provider: string }): string {
  return model.baseURL !== '' ? model.baseURL : PROVIDER_BASE_URLS[model.provider as Provider] ?? '';
}

/**
 * 核心 `ModelEntry` 的对象形状（备选模型链一环，随后序列化成 YAML）。
 * yaml tag 与核心 `internal/config/config.go` 的 `ModelEntry` 严格对齐：
 * `provider / name / baseURL / apiKey / temperature / maxTokens`。
 * 插件侧 `model`→核心 `name`、`apiKeyRef`→核心 `apiKey`（密钥运行时注入）。
 */
export interface CoreModelEntry {
  provider: string;
  name: string;
  baseURL: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
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
    /** 备选模型链（核心 `ModelConfig.Fallbacks`）；空链**不写**该键，兼容旧核心二进制。 */
    fallbacks?: CoreModelEntry[];
  };
  repo: {
    path: string;
    remote: string;
    baseBranch: string;
    authorName?: string;
    authorEmail?: string;
  };
  pr: { enabled: boolean; titleTemplate: string; labels: string[]; autoMerge: boolean };
  /** 摘要输出语言（核心 `language.outputLanguage`，空=zh 由核心自己兜底；这里始终写解析后的值）。 */
  language: { outputLanguage: string };
  trending: { languages: string[]; since: string };
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
  observe: {
    enabled: boolean;
    backfillDays: number;
    maxCandidates: number;
  };
  releases: {
    enabled: boolean;
    includePrerelease: boolean;
    includeDrafts: boolean;
    fallbackToTags: boolean;
    baselineOnFirstRun: boolean;
    /** 首次订阅仓库基线补发最近 N 个版本（核心 `releases.backfillLatest`）。 */
    backfillLatest: number;
    perRepoLimit: number;
    maxNotesChars: number;
    summaryMaxChars: number;
    docMaxLines: number;
    timezone: string;
    weekStart: 'monday';
    concurrency: number;
    budgetSeconds: number;
    period: 'weekly';
  };
  /**
   * 推送通知（核心 `notify`，core ≥ 0.8.9）。字段与核心 `config.NotifyConfig` 严格对齐；
   * 密钥（webhookURL/secret）只写 `${VAR}` 引用，核心侧解析。`enabled=false` 时整段仍写出，
   * 形状稳定（核心看到 false 即旁路）。
   */
  notify: {
    enabled: boolean;
    sections: { trending: boolean; releases: boolean };
    onSkipped: boolean;
    onEmptyReleases: boolean;
    strategy: NotifyStrategy;
    channels: Record<NotifyChannelKey, { enabled: boolean; webhookURL: string; secret: string; msgtype: string }>;
    maxReposPerSection: number;
    maxBodyChars: number;
    timeoutSeconds: number;
    summaryMaxChars: number;
  };
  output: {
    dir: string;
    branchPrefix: string;
    retentionDays: number;
    /** 核心 0.8.9+ 才认识；旧核心会忽略未知字段。 */
    branchGrouping?: 'per-period' | 'per-date';
  };
}

/**
 * 生成核心配置。`apiKey` 单独传入：它只能来自宿主凭据或用户当次输入，
 * 绝不来自 settings.json。`period` 是本次运行的标的周期；核心 `run --period`
 * 会用它覆盖 `trending.since`，这里同步写入以免旧核心/调试时口径不一致。
 *
 * `repoCount` 只用于把发版订阅的 `auto` 解析成数字（核心 0.7.0 的 YAML 只认整数）：
 * 并发 = clamp(4, ceil(n/10), 8)，预算 = min(300, 30+3n)。显式数字永远优先。
 * 不发版调度对象——`releases.schedule` 是纯插件概念，写进 YAML 核心会当成未知字段。
 */
export function toCoreConfig(
  settings: Settings,
  apiKey: string,
  baseURLOverride?: string,
  period?: Period,
  repoCount = 0,
  resolvedOutputLanguage?: string,
  fallbackApiKeys: readonly string[] = [],
): CoreConfig {
  const releases = settings.releases;
  const repoTotal = Number.isFinite(repoCount) && repoCount > 0 ? Math.floor(repoCount) : 0;
  const concurrency =
    releases.concurrency === 'auto' ? Math.min(8, Math.max(4, Math.ceil(repoTotal / 10))) : releases.concurrency;
  const budgetSeconds = releases.budgetSeconds === 'auto' ? Math.min(300, 30 + 3 * repoTotal) : releases.budgetSeconds;
  // resolvedOutputLanguage 由 runner 每次运行解析（显式 > 宿主 > zh）；缺省回落到空串，
  // 核心把空串当 zh（与旧核心「无该字段 → 默认 zh」的行为一致）。
  const outputLanguage = resolvedOutputLanguage ?? '';
  // 备选模型链：仅当至少有一项时才写 `model.fallbacks`（空链不写该键 → 兼容旧核心二进制，
  // 旧核心的 yaml.Unmarshal 非严格、忽略未知字段，但空数组也没必要下发）。
  // 每项的 `apiKey` 只能来自宿主凭据，绝不来自 settings.json：由调用方（runner）按序
  // 解析各自 `apiKeyRef` 后经 `fallbackApiKeys` 传入；缺省为空串（与主模型 apiKey 走参数一致）。
  // 注意：`entry.source`（custom/dsh）是纯插件侧元数据，**不**参与此处映射——dsh 项在保存时
  // 已定格成与 custom 同形的字段，故核心对「来源」无感知。
  const fallbacks: CoreModelEntry[] = (settings.model.fallbacks ?? []).map((entry, index) => ({
    provider: entry.provider,
    name: entry.model,
    baseURL: entry.baseURL !== '' ? entry.baseURL : PROVIDER_BASE_URLS[entry.provider] ?? '',
    apiKey: fallbackApiKeys[index] ?? '',
    temperature: entry.temperature,
    maxTokens: entry.maxTokens,
  }));
  const config: CoreConfig = {
    model: {
      provider: settings.model.provider,
      name: settings.model.model,
      baseURL: baseURLOverride ?? effectiveBaseURL(settings.model),
      apiKey,
      temperature: settings.model.temperature,
      maxTokens: settings.model.maxTokens,
      allowDegraded: settings.model.allowDegraded,
      ...(fallbacks.length > 0 ? { fallbacks } : {}),
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
    language: { outputLanguage },
    trending: {
      languages: settings.trending.languages,
      since: period ?? settings.trending.since,
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
    observe: {
      enabled: settings.observe.enabled,
      backfillDays: settings.observe.backfillDays,
      maxCandidates: settings.observe.maxCandidates,
    },
    releases: {
      // 发版订阅常开：插件侧不再提供开关，是否产出由订阅列表决定。
      enabled: true,
      includePrerelease: releases.includePrerelease,
      includeDrafts: releases.includeDrafts,
      fallbackToTags: releases.fallbackToTags,
      baselineOnFirstRun: releases.baselineOnFirstRun,
      backfillLatest: releases.backfillLatest,
      perRepoLimit: releases.perRepoLimit,
      maxNotesChars: releases.maxNotesChars,
      summaryMaxChars: releases.summaryMaxChars,
      docMaxLines: releases.docMaxLines,
      // 核心按这个时区切 ISO 周；必须与插件侧 lastReleaseWeek 的去重口径一致。
      timezone: releases.schedule.timezone,
      weekStart: 'monday',
      concurrency,
      budgetSeconds,
      // 核心只实现每周一次；非法值在校验阶段已拦下，这里不再透传枚举。
      period: 'weekly',
    },
    // 推送通知：字段与设置一一对应，原样透传（密钥仍走 ${VAR} 引用，插件不解析）。
    notify: {
      enabled: settings.notify.enabled,
      sections: {
        trending: settings.notify.sections.trending,
        releases: settings.notify.sections.releases,
      },
      onSkipped: settings.notify.onSkipped,
      onEmptyReleases: settings.notify.onEmptyReleases,
      strategy: settings.notify.strategy,
      channels: {
        dingtalk: { ...settings.notify.channels.dingtalk },
        lark: { ...settings.notify.channels.lark },
        wecom: { ...settings.notify.channels.wecom },
      },
      maxReposPerSection: settings.notify.maxReposPerSection,
      maxBodyChars: settings.notify.maxBodyChars,
      timeoutSeconds: settings.notify.timeoutSeconds,
      summaryMaxChars: settings.notify.summaryMaxChars,
    },
    output: {
      dir: settings.output.dir,
      branchPrefix: 'trending/',
      retentionDays: 90,
      // 分支模式下插件每次调度都跑日/周/月三个周期（periodList 固定返回全部
      // 周期），三个兄弟分支都要写同一份 trending/index.md —— 第一个 PR 合完，
      // 第二个就冲突。把同一天的周期合并到一条分支（per-date）后，索引在一条
      // 分支上自然累计，一个 PR 带齐当期全部产物。direct 模式直接提交基线分支，
      // 不涉及分支布局，保持 per-period 以免改变旧核心行为。
      branchGrouping: settings.repo.commitMode === 'branch' ? 'per-date' : 'per-period',
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
