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

/** 最近 30 天内有记录的日期，每天一条，倒序。 */
export function buildDigestDates(records: DigestRecord[], options: DigestOptions): DigestDay[] {
  const now = options.now ?? new Date();
  const today = zonedDateString(now, options.timeZone);
  const earliest = addDays(today, -(DIGEST_WINDOW_DAYS - 1));
  const groups = new Map<string, { records: DigestRecord[]; derivedFromAt: boolean }>();

  for (const record of records) {
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
