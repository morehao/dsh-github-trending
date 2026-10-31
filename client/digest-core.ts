/**
 * 最近 30 天日期切换的纯数据层（不依赖 React，可在 Node 测试里直接跑）。
 *
 * 数据源只有 `/state.status.history`（Host 最多 30 条），不新增列表接口：
 * - 每条记录的日期优先用 `record.date`（Host 按调度时区算好）；旧记录没有时用 `at`
 *   在调度时区里取日期，并标 legacy；
 * - 同一天多次运行只保留一条：优先「成功且有预览副本」的最近一条，否则最近一条；
 * - 只保留「调度时区今天回推 29 天」到今天的日期，倒序。
 */
export const DIGEST_WINDOW_DAYS = 30;

/** 产出周期（与 core 0.4.0 的 `--period` 一致）。 */
export type Period = 'daily' | 'weekly' | 'monthly';

/** 规范顺序：周期分段、分组、展示都以它为准。 */
export const PERIODS: readonly Period[] = ['daily', 'weekly', 'monthly'];

export interface DigestPreviewMeta {
  file: string;
  bytes: number;
  sha256: string;
  truncated?: boolean;
}

/** 只取渲染需要的字段，避免把 Host 的完整类型带进纯函数。 */
export interface DigestRecord {
  id: string;
  at: string;
  kind: 'run' | 'dry-run';
  ok: boolean;
  skipped: boolean;
  errorCode?: string;
  errorMessage?: string;
  durationMs: number;
  files: number;
  date?: string;
  /** 本次产出周期（daily|weekly|monthly）；旧记录没有，按 daily 处理。 */
  period?: Period;
  contentHash?: string;
  branch?: string;
  commit?: string;
  prUrl?: string;
  preview?: DigestPreviewMeta;
  coreVersion: string;
  model: { provider: string; model: string };
  languages: string[];
  warnings: string[];
  legacy?: boolean;
}

export type DigestStatus = 'preview' | 'failed' | 'skipped' | 'dry' | 'legacy' | 'missing';

export interface DigestDay {
  date: string;
  record: DigestRecord;
  status: DigestStatus;
  legacy: boolean;
}

export interface DigestOptions {
  /** IANA 时区；来自 `state.schedule.timezone`。 */
  timeZone: string;
  /** 测试可注入固定时间；默认 new Date()。 */
  now?: Date;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE_RE.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** 调度时区下的日历日期（YYYY-MM-DD）；时区非法时退回本地日期。 */
export function zonedDateString(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}

/** 纯日历加减，用 UTC 避免 DST/本地时区把日期挪一天。 */
export function addDays(date: string, days: number): string {
  const match = DATE_RE.exec(date);
  if (match === null) return date;
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** 记录属于哪一天：优先 Host 写好的 `date`，旧记录才用 `at` 换算。 */
export function recordDate(record: DigestRecord, timeZone: string): { date: string; derivedFromAt: boolean } | undefined {
  if (isValidDate(record.date)) return { date: record.date, derivedFromAt: false };
  const at = new Date(record.at);
  if (Number.isNaN(at.getTime())) return undefined;
  return { date: zonedDateString(at, timeZone), derivedFromAt: true };
}

export function digestStatus(record: DigestRecord): DigestStatus {
  if (!record.ok) return 'failed';
  if (record.skipped) return 'skipped';
  if (record.kind === 'dry-run') return 'dry';
  if (record.preview !== undefined) return 'preview';
  if (record.legacy === true) return 'legacy';
  return 'missing';
}

/** 记录所属周期；旧记录没有 period，一律按 daily 处理。 */
export function recordPeriod(record: DigestRecord): Period {
  return record.period === 'weekly' || record.period === 'monthly' ? record.period : 'daily';
}

/** 与 core `render.NameOf` 对齐的期数桶：daily=YYYY-MM-DD、weekly=YYYY-Wnn、monthly=YYYY-MM。 */
export function isoWeekName(date: string): string {
  const match = DATE_RE.exec(date);
  if (match === null) return date;
  const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(d.getTime())) return date;
  const dayIdx = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayIdx + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstIdx = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstIdx + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** 某周期下某个日历日期对应的期数桶。 */
export function periodBucket(period: Period, date: string): string {
  if (period === 'monthly') return date.slice(0, 7);
  if (period === 'weekly') return isoWeekName(date);
  return date;
}

/** ISO 周桶（YYYY-Www）对应的周一到周日日期区间。 */
function isoWeekRange(bucket: string): { start: string; end: string } | undefined {
  const match = /^(\d{4})-W(\d{2})$/.exec(bucket);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayIdx = (jan4.getUTCDay() + 6) % 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - dayIdx + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) };
}

/** 期数桶的可读标签：日=日期+星期、周=Wnn（区间）、月=年月。 */
export function formatBucketLabel(period: Period, bucket: string, lang: 'zh' | 'en'): string {
  if (period === 'daily') return formatDayLabel(bucket, lang);
  if (period === 'weekly') {
    const range = isoWeekRange(bucket);
    if (range === undefined) return bucket;
    const md = (d: string): string => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
    return `${bucket} ${lang === 'en' ? `(${md(range.start)}–${md(range.end)})` : `（${md(range.start)}–${md(range.end)}）`}`;
  }
  const match = /^(\d{4})-(\d{2})$/.exec(bucket);
  if (match === null) return bucket;
  return lang === 'en' ? bucket : `${match[1]} 年 ${Number(match[2])} 月`;
}

/** 记录 → 日报视图可直接跳转的「周期 + 期数」定位。 */
export function digestTarget(record: DigestRecord, timeZone: string): { period: Period; bucket: string } | undefined {
  const info = recordDate(record, timeZone);
  if (info === undefined) return undefined;
  const period = recordPeriod(record);
  return { period, bucket: periodBucket(period, info.date) };
}

/** 最近 30 天内有记录的日期，每天一条，倒序（仅日榜；概览「最近 7 天」用）。 */
export function buildDigestDates(records: DigestRecord[], options: DigestOptions): DigestDay[] {
  const now = options.now ?? new Date();
  const today = zonedDateString(now, options.timeZone);
  const earliest = addDays(today, -(DIGEST_WINDOW_DAYS - 1));
  const groups = new Map<string, { records: DigestRecord[]; derivedFromAt: boolean }>();

  for (const record of records) {
    if (recordPeriod(record) !== 'daily') continue;
    const info = recordDate(record, options.timeZone);
    if (info === undefined) continue;
    if (info.date < earliest || info.date > today) continue;
    const group = groups.get(info.date);
    if (group === undefined) groups.set(info.date, { records: [record], derivedFromAt: info.derivedFromAt });
    else {
      group.records.push(record);
      group.derivedFromAt = group.derivedFromAt || info.derivedFromAt;
    }
  }

  const days: DigestDay[] = [];
  for (const [date, group] of groups) {
    const sorted = [...group.records].sort((a, b) => b.at.localeCompare(a.at));
    const preferred = sorted.find(
      (record) => record.preview !== undefined && record.ok && record.kind !== 'dry-run' && !record.skipped,
    );
    const record = preferred ?? sorted[0];
    if (record === undefined) continue;
    const info = recordDate(record, options.timeZone);
    const legacy = record.legacy === true || info?.derivedFromAt === true || group.derivedFromAt;
    days.push({ date, record, status: digestStatus(record), legacy });
  }
  days.sort((a, b) => b.date.localeCompare(a.date));
  return days;
}

export interface PeriodDay {
  period: Period;
  /** 期数桶：YYYY-MM-DD / YYYY-Wnn / YYYY-MM。 */
  bucket: string;
  /** 代表日期（YYYY-MM-DD），用于跳转与排序兜底。 */
  date: string;
  record: DigestRecord;
  status: DigestStatus;
  legacy: boolean;
}

export interface PeriodGroup {
  period: Period;
  /** 同一周期内的各期，按桶倒序（最新在前）。 */
  days: PeriodDay[];
  /** 有预览副本的期数，用于分段上的计数。 */
  previewCount: number;
}

/**
 * 按「周期 → 期数桶」分组：三个周期各自成组，互不吞并。
 *
 * - 日榜按「调度时区最近 30 天」窗口裁剪；周/月榜不裁剪（历史条数本身有限）；
 * - 同一周期同一桶多次运行只留一条：优先「成功且有预览副本」的最近一条；
 * - 每个周期都返回（即使为空），便于分段控件稳定渲染计数。
 */
export function buildPeriodGroups(records: DigestRecord[], options: DigestOptions): PeriodGroup[] {
  const now = options.now ?? new Date();
  const today = zonedDateString(now, options.timeZone);
  const dailyEarliest = addDays(today, -(DIGEST_WINDOW_DAYS - 1));
  const groups = new Map<string, { period: Period; bucket: string; records: DigestRecord[]; derivedFromAt: boolean }>();

  for (const record of records) {
    const info = recordDate(record, options.timeZone);
    if (info === undefined) continue;
    const period = recordPeriod(record);
    if (period === 'daily' && (info.date < dailyEarliest || info.date > today)) continue;
    const bucket = periodBucket(period, info.date);
    const key = `${period}|${bucket}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { period, bucket, records: [record], derivedFromAt: info.derivedFromAt });
    else {
      group.records.push(record);
      group.derivedFromAt = group.derivedFromAt || info.derivedFromAt;
    }
  }

  const byPeriod = new Map<Period, PeriodDay[]>();
  for (const group of groups.values()) {
    const sorted = [...group.records].sort((a, b) => b.at.localeCompare(a.at));
    const preferred = sorted.find(
      (record) => record.preview !== undefined && record.ok && record.kind !== 'dry-run' && !record.skipped,
    );
    const record = preferred ?? sorted[0];
    if (record === undefined) continue;
    const info = recordDate(record, options.timeZone);
    const legacy = record.legacy === true || info?.derivedFromAt === true || group.derivedFromAt;
    const list = byPeriod.get(group.period) ?? [];
    list.push({
      period: group.period,
      bucket: group.bucket,
      date: info?.date ?? group.bucket.slice(0, 10),
      record,
      status: digestStatus(record),
      legacy,
    });
    byPeriod.set(group.period, list);
  }

  return PERIODS.map((period) => {
    const days = (byPeriod.get(period) ?? []).sort((a, b) => b.bucket.localeCompare(a.bucket));
    return { period, days, previewCount: days.filter((day) => day.status === 'preview').length };
  });
}


/** 从最早到今天的连续日期（概览的最近 7 天用）。 */
export function recentDates(today: string, count: number): string[] {
  const dates: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) dates.push(addDays(today, -offset));
  return dates;
}

export function formatDayLabel(date: string, lang: 'zh' | 'en'): string {
  let weekday = '';
  try {
    weekday = new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'zh-CN', {
      weekday: 'short',
      timeZone: 'UTC',
    }).format(new Date(`${date}T12:00:00Z`));
  } catch {
    weekday = '';
  }
  return weekday === '' ? date : `${date} ${weekday}`;
}

/** 文件大小：B / KB / MB，保留 1 位小数。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
