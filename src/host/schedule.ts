/**
 * 调度（FR-P-08 / 规格 §9）。
 *
 * 规格原本设想「复用宿主 schedule 服务」，但实测：宿主的 `ctx.schedule` 是 **会话本地**
 * 的提醒（rc.5 才引入，create 需要 sessionId，冷会话不投递），而本插件的运行完全不依赖会话。
 * 因此这里实现规格 §9 已经写明的兜底：宿主 `timer` 服务（或 `setInterval`）60 s tick、
 * 按 IANA 时区判当日、6 h 内补跑、同日不重复。
 *
 * 「下一次运行」也由同一份时区算术给出，界面与工具都用它。
 */
import type { PluginState, Store } from '../state.js';

export interface ScheduleConfig {
  enabled: boolean;
  time: string;
  timezone: string;
}

const MINUTE = 60_000;
const CATCH_UP_MINUTES = 6 * 60;

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

export interface SchedulerDeps {
  store: Store;
  run: (trigger: 'schedule') => Promise<unknown>;
  isRunning: () => boolean;
  getTimer: () => { interval?: (fn: () => void, ms: number) => unknown; timeout?: (fn: () => void, ms: number) => unknown } | undefined;
  onError?: (error: unknown) => void;
}

export class Scheduler {
  private readonly deps: SchedulerDeps;
  private timerHandle: unknown;
  private stopped = false;
  private lastFiredFor: string | undefined;

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

  /** 公开给测试：判断此刻是否该跑，并按需触发一次。 */
  async tick(now: Date = new Date()): Promise<'skipped' | 'ran' | 'disabled' | 'busy'> {
    if (this.stopped) return 'skipped';
    const schedule = this.readSchedule();
    if (!schedule.enabled) return 'disabled';
    if (!isDue(now, schedule)) return 'skipped';
    const today = zonedDateString(now, schedule.timezone);
    const state = this.deps.store.readState();
    const lastDate = state.lastRunAt === undefined ? undefined : zonedDateString(new Date(state.lastRunAt), schedule.timezone);
    if (lastDate === today) return 'skipped';
    if (this.lastFiredFor === today) return 'skipped';
    if (this.deps.isRunning()) return 'busy';
    this.lastFiredFor = today;
    try {
      await this.deps.run('schedule');
      return 'ran';
    } catch (error) {
      this.deps.onError?.(error);
      return 'skipped';
    }
  }

  private readSchedule(): ScheduleConfig {
    const settings = this.deps.store.readSettings();
    return {
      enabled: settings.schedule.enabled,
      time: settings.schedule.time,
      timezone: settings.schedule.timezone,
    };
  }

  /** 下一次运行（禁用时为 undefined）。 */
  next(): Date | undefined {
    const schedule = this.readSchedule();
    if (!schedule.enabled) return undefined;
    try {
      return nextOccurrence(new Date(), schedule);
    } catch {
      return undefined;
    }
  }

  describe(state: PluginState, now: Date = new Date()): {
    enabled: boolean;
    time: string;
    timezone: string;
    nextRunAt?: string;
    lastRunDate?: string;
    catchUpMinutes: number;
    source: 'timer';
  } {
    const schedule = this.readSchedule();
    const next = schedule.enabled ? this.next() : undefined;
    return {
      enabled: schedule.enabled,
      time: schedule.time,
      timezone: schedule.timezone,
      ...(next === undefined ? {} : { nextRunAt: next.toISOString() }),
      ...(state.lastRunAt === undefined ? {} : { lastRunDate: zonedDateString(new Date(state.lastRunAt), schedule.timezone) }),
      catchUpMinutes: CATCH_UP_MINUTES,
      source: 'timer',
    };
  }
}
