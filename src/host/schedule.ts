/**
 * 调度（FR-P-08 / 规格 §9）。
 *
 * 规格原本设想「复用宿主 schedule 服务」，但实测：宿主的 `ctx.schedule` 是 **会话本地**
 * 的提醒（rc.5 才引入，create 需要 sessionId，冷会话不投递），而本插件的运行完全不依赖会话。
 * 因此这里实现规格 §9 已经写明的兜底：宿主 `timer` 服务（或 `setInterval`）60 s tick、
 * 按 IANA 时区判当日、6 h 内补跑、同日不重复。
 *
 * 两条**互相独立**的行程共用同一个 tick：
 *   - 榜单（`schedule.*`）：按日/周/月周期产出，去重键是「周期 + 本地日期」；
 *   - 发版订阅（`releases.schedule.*`）：每周一次只跑 `--stages releases`，
 *     去重键是 ISO 周（`2026-W44`）。两者都可以单独关闭。
 *
 * 「下一次运行」也由同一份时区算术给出，界面与工具都用它。
 */
import { PERIODS } from '../config.js';
import type { Period, ReleaseScheduleSettings } from '../config.js';
import type { PluginState, Store } from '../state.js';

export interface ScheduleConfig {
  enabled: boolean;
  time: string;
  timezone: string;
  /** 自动产出的周期；每个周期只在「它自己的触发日」跑（日=每天、周=周日、月=月末）。 */
  periods: Period[];
}

/** 每周发版行程的开关/时间点（纯插件概念，核心没有对应字段）。 */
export type ReleaseScheduleConfig = ReleaseScheduleSettings;

const MINUTE = 60_000;
const CATCH_UP_MINUTES = 6 * 60;
/** 发版行程的补跑窗口：超过 6 h 就放弃本周（下一周那次会同时覆盖两周的内容）。 */
export const RELEASE_CATCH_UP_MINUTES = 6 * 60;
/** 同一天失败后最多再试几次（含首次）。 */
const MAX_ATTEMPTS_PER_DAY = 2;
/** 两次尝试之间的最小间隔，避免失败风暴烧模型。 */
const RETRY_GAP_MS = 5 * MINUTE;

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsOf(date: Date, timezone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map = new Map<string, string>();
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') map.set(part.type, part.value);
  }
  return {
    year: Number(map.get('year')),
    month: Number(map.get('month')),
    day: Number(map.get('day')),
    hour: Number(map.get('hour')),
    minute: Number(map.get('minute')),
    second: Number(map.get('second')),
  };
}

/** 该时刻在目标时区的偏移（毫秒，东八区为 +8h）。 */
function offsetMs(date: Date, timezone: string): number {
  const parts = partsOf(date, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** 目标时区的墙上时间 → UTC 时刻（按 DST 修正一次，够用且可测）。 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timezone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = new Date(guess - offsetMs(new Date(guess), timezone));
  return new Date(guess - offsetMs(first, timezone));
}

export function parseClock(time: string): { hour: number; minute: number; second: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(time.trim());
  if (match === null) throw new Error(`非法时间：${time}`);
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
    second: Number(match[3] ?? '0'),
  };
}

/** 目标时区下的本地日期串（YYYY-MM-DD）。 */
export function zonedDateString(date: Date, timezone: string): string {
  const parts = partsOf(date, timezone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** 下一次应当运行的时刻（严格晚于 now）。 */
export function nextOccurrence(now: Date, schedule: ScheduleConfig): Date {
  const { hour, minute, second } = parseClock(schedule.time);
  const today = partsOf(now, schedule.timezone);
  const candidate = zonedTimeToUtc(today.year, today.month, today.day, hour, minute, second, schedule.timezone);
  if (candidate.getTime() > now.getTime()) return candidate;
  // 明天的同一天墙时间：借 UTC 日期加一天再折回时区，避免自己处理月末/闰年
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day) + 86_400_000);
  return zonedTimeToUtc(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    hour,
    minute,
    second,
    schedule.timezone,
  );
}

/** 今天这一次是否已过点且在补跑窗口内。 */
export function isDue(now: Date, schedule: ScheduleConfig): boolean {
  const { hour, minute } = parseClock(schedule.time);
  const parts = partsOf(now, schedule.timezone);
  const nowMinutes = parts.hour * 60 + parts.minute;
  const targetMinutes = hour * 60 + minute;
  const late = nowMinutes - targetMinutes;
  return late >= 0 && late <= CATCH_UP_MINUTES;
}

/**
 * 日历日 → ISO 周年/周键（周一为一周起点，形如 `2026-W44`）。
 *
 * 核心的发版文档按 ISO 周累积，插件的「本周是否已经跑过」必须用同一个键，
 * 否则跨年那一周会出现「文档写进 2026-W01、插件却以为 2025-W53 已经跑过」。
 */
function isoWeekOf(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  // 以周四定年/周序：把日期挪到本周周四，再和「当年第一个周四」比周数。
  const dayIdx = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayIdx + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstIdx = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstIdx + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** 某时刻在 `timezone` 下的 ISO 周键；发版周去重就用它。 */
export function isoWeekKey(date: Date, timezone: string): string {
  const parts = partsOf(date, timezone);
  return isoWeekOf(parts.year, parts.month, parts.day);
}

/** 该时刻在 `timezone` 下的 ISO 星期（1=周一 … 7=周日）。 */
function isoWeekdayOf(date: Date, timezone: string): number {
  const parts = partsOf(date, timezone);
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** 下一次发版运行时刻：ISO 星期匹配 `cfg.weekday`、当天的墙钟 `cfg.time`，严格晚于 now。 */
export function nextReleaseOccurrence(now: Date, cfg: ReleaseScheduleConfig): Date {
  const { hour, minute, second } = parseClock(cfg.time);
  const today = partsOf(now, cfg.timezone);
  const start = Date.UTC(today.year, today.month - 1, today.day);
  // 最多看 15 天：足够覆盖「今天已过点 → 下周同一星期」，也自动处理月末/闰年。
  for (let index = 0; index <= 15; index += 1) {
    const d = new Date(start + index * 86_400_000);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const dayOfWeek = d.getUTCDay();
    const weekday = dayOfWeek === 0 ? 7 : dayOfWeek;
    if (weekday !== cfg.weekday) continue;
    const candidate = zonedTimeToUtc(year, month, day, hour, minute, second, cfg.timezone);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  // 理论不可达（weekday 合法时 7 天内必有一命中）；宁可报错也不返回一个错的时间。
  throw new Error(`无法计算下一次发版运行时刻（weekday=${String(cfg.weekday)}）`);
}

/**
 * 发版行程此刻是否该跑：星期匹配、已过点、且迟到不超过 6 h。
 * 超过窗口就**放弃本周**——下周那次会同时覆盖两周的内容（核心按周累积，不需要补跑）。
 */
export function isReleaseDue(now: Date, cfg: ReleaseScheduleConfig): boolean {
  if (isoWeekdayOf(now, cfg.timezone) !== cfg.weekday) return false;
  const { hour, minute } = parseClock(cfg.time);
  const parts = partsOf(now, cfg.timezone);
  const late = parts.hour * 60 + parts.minute - (hour * 60 + minute);
  return late >= 0 && late <= RELEASE_CATCH_UP_MINUTES;
}

export function daysInMonth(year: number, month: number): number {
  // month 从 1 开始；下个月的第 0 天 = 本月最后一天。
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 纯日历判断（不涉及时区投影）：该 (年,月,日) 是否是该周期的结算日。 */
function isPeriodTriggerDate(period: Period, year: number, month: number, day: number): boolean {
  if (period === 'weekly') {
    // 周日 = 一周终点（ISO 周从周一开始）。
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 0;
  }
  if (period === 'monthly') return day === daysInMonth(year, month);
  return true; // daily：每天都是结算日
}

/** 该时刻是否落在某个周期的结算日（按 timezone 的本地日历）。 */
export function isPeriodTriggerDay(period: Period, now: Date, timezone: string): boolean {
  const parts = partsOf(now, timezone);
  return isPeriodTriggerDate(period, parts.year, parts.month, parts.day);
}

/** 某周期下一次触发时刻（触发日的墙钟 time，严格晚于 now）。 */
export function nextOccurrenceFor(period: Period, now: Date, schedule: ScheduleConfig): Date {
  const { hour, minute, second } = parseClock(schedule.time);
  const today = partsOf(now, schedule.timezone);
  const start = Date.UTC(today.year, today.month - 1, today.day);
  for (let i = 0; i < 400; i += 1) {
    const d = new Date(start + i * 86_400_000);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    if (!isPeriodTriggerDate(period, year, month, day)) continue;
    const candidate = zonedTimeToUtc(year, month, day, hour, minute, second, schedule.timezone);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  // 理论不可达（daily 最迟一天内命中）；兜底顺延到下一次日常时刻。
  return nextOccurrence(now, schedule);
}

export interface SchedulerDeps {
  store: Store;
  run: (trigger: 'schedule', period: Period) => Promise<unknown>;
  /** 每周发版行程：与榜单 `run` 共享 Runner 的单跑锁（Runner 自己会拒绝并发）。 */
  runReleases: (trigger: 'schedule') => Promise<unknown>;
  isRunning: () => boolean;
  getTimer: () => { interval?: (fn: () => void, ms: number) => unknown; timeout?: (fn: () => void, ms: number) => unknown } | undefined;
  onError?: (error: unknown) => void;
}

export class Scheduler {
  private readonly deps: SchedulerDeps;
  private timerHandle: unknown;
  private stopped = false;
  /** 当天已尝试次数与时间；只在内存里，进程重启后重新计数。 */
  private readonly attempts = new Map<string, { count: number; lastAt: number }>();
  /** 发版行程的尝试计数（键 = ISO 周 + 本地日期）；理由同榜单：失败不能每分钟重试。 */
  private readonly releaseAttempts = new Map<string, { count: number; lastAt: number }>();

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  start(): void {
    this.stopped = false;
    const timer = this.deps.getTimer();
    const tick = (): void => {
      void this.tick();
    };
    if (timer !== undefined && typeof timer.interval === 'function') {
      this.timerHandle = timer.interval(tick, MINUTE);
    } else {
      const handle = setInterval(tick, MINUTE);
      handle.unref?.();
      this.timerHandle = handle;
    }
    // 启动先跑一次 tick：宿主刚起来时可能已经过了当天的时间点
    setTimeout(tick, 5000).unref?.();
  }

  stop(): void {
    this.stopped = true;
    const handle = this.timerHandle as { clear?: () => void } | number | undefined;
    if (typeof handle === 'object' && handle !== null && typeof handle.clear === 'function') handle.clear();
    else if (typeof handle === 'number' || handle !== undefined) clearInterval(handle as NodeJS.Timeout);
    this.timerHandle = undefined;
  }

  /**
   * 公开给测试：判断此刻是否该跑，并按需触发。
   *
   * 每个 tick 都**同时**评估榜单与发版两条行程（interval 已经是 60 s）。返回值合并规则
   * 保证老调用方不受影响：真的跑了 → `ran`；否则有人占着锁 → `busy`；再否则只要有
   * 一条行程是禁用状态就沿用旧的 `disabled`；都没有 → `skipped`。
   */
  async tick(now: Date = new Date()): Promise<'skipped' | 'ran' | 'disabled' | 'busy'> {
    if (this.stopped) return 'skipped';
    const digest = await this.tickDigest(now);
    const releases = await this.tickReleases(now);
    if (digest === 'ran' || releases === 'ran') return 'ran';
    if (digest === 'busy' || releases === 'busy') return 'busy';
    if (digest === 'disabled' || releases === 'disabled') return 'disabled';
    return 'skipped';
  }

  /** 榜单行程（原 tick 的逻辑，不改）。 */
  private async tickDigest(now: Date): Promise<'skipped' | 'ran' | 'disabled' | 'busy'> {
    const schedule = this.readSchedule();
    if (!schedule.enabled) return 'disabled';
    if (!isDue(now, schedule)) return 'skipped';
    const today = zonedDateString(now, schedule.timezone);
    // 只保留今日的尝试计数；跨日的旧键清掉，避免无限增长。
    for (const key of this.attempts.keys()) {
      if (!key.endsWith(`:${today}`)) this.attempts.delete(key);
    }
    const periods = schedule.periods.length > 0 ? schedule.periods : (PERIODS as readonly Period[] as Period[]);
    let ran = false;
    for (const period of periods) {
      if (!isPeriodTriggerDay(period, now, schedule.timezone)) continue;
      const state = this.deps.store.readState();
      // 只有「成功」（含无变更跳过）才锁「该周期 + 当天」：网络抖动不该丢整天，
      // 但失败也不能无限重试。去重键含 period，切换/新增周期不会被旧成功挡住。
      if (this.succeededToday(state, period, today, schedule.timezone)) continue;
      const key = `${period}:${today}`;
      const attempt = this.attempts.get(key);
      if (attempt !== undefined) {
        if (attempt.count >= MAX_ATTEMPTS_PER_DAY) continue;
        if (now.getTime() - attempt.lastAt < RETRY_GAP_MS) continue;
      }
      if (this.deps.isRunning()) return 'busy';
      this.attempts.set(key, { count: (attempt?.count ?? 0) + 1, lastAt: now.getTime() });
      try {
        await this.deps.run('schedule', period);
        ran = true;
      } catch (error) {
        this.deps.onError?.(error);
      }
    }
    return ran ? 'ran' : 'skipped';
  }

  /**
   * 发版行程：每周一次、只跑 `--stages releases`。
   *
   * 跳过条件（全部满足才跑）：开启、星期/时间命中且迟到 ≤ 6 h、本周尚未成功过
   * （`state.lastReleaseWeek`）、当前没有别的运行占锁。
   * 失败**不锁本周**，但也只有 2 次机会（间隔 5 min）——否则一个坏 token 会在 6 h 的
   * 补跑窗口里每分钟 spawn 一次核心、白白打 GitHub API。
   */
  private async tickReleases(now: Date): Promise<'skipped' | 'ran' | 'disabled' | 'busy'> {
    const cfg = this.readReleaseSchedule();
    if (!cfg.enabled) return 'disabled';
    if (!isReleaseDue(now, cfg)) return 'skipped';
    const week = ((): string | undefined => {
      try {
        return isoWeekKey(now, cfg.timezone);
      } catch {
        return undefined;
      }
    })();
    if (week === undefined) return 'skipped';
    const state = this.deps.store.readState();
    if (state.lastReleaseWeek === week) return 'skipped';

    const key = `${week}:${zonedDateString(now, cfg.timezone)}`;
    // 只保留本周的尝试计数；跨周的旧键清掉。
    for (const existing of this.releaseAttempts.keys()) {
      if (!existing.startsWith(`${week}:`)) this.releaseAttempts.delete(existing);
    }
    const attempt = this.releaseAttempts.get(key);
    if (attempt !== undefined) {
      if (attempt.count >= MAX_ATTEMPTS_PER_DAY) return 'skipped';
      if (now.getTime() - attempt.lastAt < RETRY_GAP_MS) return 'skipped';
    }
    if (this.deps.isRunning()) return 'busy';
    this.releaseAttempts.set(key, { count: (attempt?.count ?? 0) + 1, lastAt: now.getTime() });
    try {
      await this.deps.runReleases('schedule');
      return 'ran';
    } catch (error) {
      this.deps.onError?.(error);
      return 'skipped';
    }
  }

  /** 该周期今天是否已经成功过（含无变更跳过）。 */
  private succeededToday(state: PluginState, period: Period, today: string, timezone: string): boolean {
    const stamp = state.periodSuccess?.[period];
    if (stamp !== undefined && zonedDateString(new Date(stamp), timezone) === today) return true;
    // 向后兼容：旧 state 只有全局 lastSuccessAt，按 daily 视为当日已成功。
    if (period === 'daily' && state.lastSuccessAt !== undefined && zonedDateString(new Date(state.lastSuccessAt), timezone) === today) {
      return true;
    }
    return false;
  }

  private readSchedule(): ScheduleConfig {
    const settings = this.deps.store.readSettings();
    return {
      enabled: settings.schedule.enabled,
      time: settings.schedule.time,
      timezone: settings.schedule.timezone,
      periods: settings.schedule.periods,
    };
  }

  /** 发版行程的节奏来自 `settings.releases.schedule`（与榜单 `schedule.*` 相互独立）。 */
  private readReleaseSchedule(): ReleaseScheduleConfig {
    const { schedule } = this.deps.store.readSettings().releases;
    return {
      enabled: schedule.enabled,
      weekday: schedule.weekday,
      time: schedule.time,
      timezone: schedule.timezone,
    };
  }

  /** 下一次运行（取所有已启用周期里最近的一次；禁用时为 undefined）。 */
  next(): Date | undefined {
    const schedule = this.readSchedule();
    if (!schedule.enabled) return undefined;
    const periods = schedule.periods.length > 0 ? schedule.periods : (PERIODS as readonly Period[] as Period[]);
    try {
      const now = new Date();
      let earliest: Date | undefined;
      for (const period of periods) {
        const occurrence = nextOccurrenceFor(period, now, schedule);
        if (earliest === undefined || occurrence.getTime() < earliest.getTime()) earliest = occurrence;
      }
      return earliest;
    } catch {
      return undefined;
    }
  }

  /** 下一次发版运行（禁用/非法时为 undefined）。 */
  nextRelease(now: Date = new Date()): Date | undefined {
    const cfg = this.readReleaseSchedule();
    if (!cfg.enabled) return undefined;
    try {
      return nextReleaseOccurrence(now, cfg);
    } catch {
      return undefined;
    }
  }

  describe(state: PluginState, now: Date = new Date()): {
    enabled: boolean;
    time: string;
    timezone: string;
    periods: Period[];
    nextRunAt?: string;
    lastRunDate?: string;
    catchUpMinutes: number;
    source: 'timer';
    releaseEnabled: boolean;
    releaseWeekday: number;
    releaseTime: string;
    releaseTimezone: string;
    nextReleaseAt?: string;
    lastReleaseAt?: string;
    lastReleaseWeek?: string;
    releaseCatchUpMinutes: number;
  } {
    const schedule = this.readSchedule();
    const release = this.readReleaseSchedule();
    const next = schedule.enabled ? this.next() : undefined;
    const nextRelease = release.enabled ? this.nextRelease(now) : undefined;
    return {
      enabled: schedule.enabled,
      time: schedule.time,
      timezone: schedule.timezone,
      periods: schedule.periods,
      ...(next === undefined ? {} : { nextRunAt: next.toISOString() }),
      ...(state.lastRunAt === undefined ? {} : { lastRunDate: zonedDateString(new Date(state.lastRunAt), schedule.timezone) }),
      catchUpMinutes: CATCH_UP_MINUTES,
      source: 'timer',
      // 发版行程的信息并列给出，界面/工具不必再去读设置才知道下一次何时跑。
      releaseEnabled: release.enabled,
      releaseWeekday: release.weekday,
      releaseTime: release.time,
      releaseTimezone: release.timezone,
      ...(nextRelease === undefined ? {} : { nextReleaseAt: nextRelease.toISOString() }),
      ...(state.lastReleaseAt === undefined ? {} : { lastReleaseAt: state.lastReleaseAt }),
      ...(state.lastReleaseWeek === undefined ? {} : { lastReleaseWeek: state.lastReleaseWeek }),
      releaseCatchUpMinutes: RELEASE_CATCH_UP_MINUTES,
    };
  }
}
