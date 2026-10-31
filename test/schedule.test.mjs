import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { schedule, state as stateModule } from '../lib/internal.js';

const SH = { enabled: true, time: '08:30:00', timezone: 'Asia/Shanghai' };

test('时区换算：上海 08:30 对应 UTC 00:30', () => {
  const next = schedule.nextOccurrence(new Date('2026-10-30T00:00:00Z'), SH);
  assert.equal(next.toISOString(), '2026-10-30T00:30:00.000Z');
});

test('已过点则顺延到次日', () => {
  const next = schedule.nextOccurrence(new Date('2026-10-30T01:00:00Z'), SH);
  assert.equal(next.toISOString(), '2026-10-31T00:30:00.000Z');
});

test('UTC 时区与跨月边界', () => {
  const utc = { enabled: true, time: '23:15', timezone: 'UTC' };
  const next = schedule.nextOccurrence(new Date('2026-10-31T22:00:00Z'), utc);
  assert.equal(next.toISOString(), '2026-10-31T23:15:00.000Z');
  const monthEnd = schedule.nextOccurrence(new Date('2026-10-31T23:30:00Z'), utc);
  assert.equal(monthEnd.toISOString(), '2026-11-01T23:15:00.000Z');
});

test('夏令时切换当天仍按墙上时间计算', () => {
  const ny = { enabled: true, time: '09:00', timezone: 'America/New_York' };
  const before = schedule.nextOccurrence(new Date('2026-11-01T05:00:00Z'), ny);
  // 2026-11-01 美东仍是 EDT（UTC-4）直到 06:00Z；09:00 墙上时间 = 13:00Z（EST）
  assert.equal(before.toISOString(), '2026-11-01T14:00:00.000Z');
});

test('isDue 只覆盖「过点且 6 h 内」的窗口', () => {
  assert.equal(schedule.isDue(new Date('2026-10-30T00:30:00Z'), SH), true);
  assert.equal(schedule.isDue(new Date('2026-10-30T00:00:00Z'), SH), false); // 未到点
  assert.equal(schedule.isDue(new Date('2026-10-30T07:00:00Z'), SH), false); // 超 6 h
});

test('Scheduler.tick 同日只触发一次，禁用时不触发', async () => {
  const { state: stateModule } = await import('../lib/internal.js');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'dshgt-sched-'));
  const store = new stateModule.Store({ dir });
  store.writeSettings({ schedule: { enabled: true, time: '08:30:00', timezone: 'Asia/Shanghai' } });

  let runs = 0;
  const scheduler = new schedule.Scheduler({
    store,
    isRunning: () => false,
    getTimer: () => undefined,
    run: async () => {
      runs += 1;
      const state = store.readState();
      store.writeState({ ...state, lastRunAt: new Date('2026-10-30T00:31:00Z').toISOString(), lastSuccessAt: new Date('2026-10-30T00:31:00Z').toISOString() });
    },
    runReleases: async () => undefined,
  });
  const now = new Date('2026-10-30T00:35:00Z');
  assert.equal(await scheduler.tick(now), 'ran');
  assert.equal(runs, 1);
  assert.equal(await scheduler.tick(now), 'skipped');

  const disabled = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-sched2-')) });
  disabled.writeSettings({ schedule: { enabled: false } });
  const off = new schedule.Scheduler({ store: disabled, isRunning: () => false, getTimer: () => undefined, run: async () => undefined, runReleases: async () => undefined });
  assert.equal(await off.tick(now), 'disabled');
  scheduler.stop();
  off.stop();
});

test('失败不锁当天：间隔后可重试，但最多 2 次', async () => {
  const { state: stateModule } = await import('../lib/internal.js');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'dshgt-sched-retry-'));
  const store = new stateModule.Store({ dir });
  store.writeSettings({ schedule: { enabled: true, time: '08:30:00', timezone: 'Asia/Shanghai' } });

  let runs = 0;
  let failures = 0;
  const scheduler = new schedule.Scheduler({
    store,
    isRunning: () => false,
    getTimer: () => undefined,
    run: async () => {
      runs += 1;
      failures += 1;
      throw new Error('boom');
    },
    runReleases: async () => undefined,
  });
  const first = new Date('2026-10-30T00:35:00Z');
  assert.equal(await scheduler.tick(first), 'skipped'); // 首次尝试失败，tick 返回 skipped
  assert.equal(runs, 1);

  // 间隔不足：不再尝试
  assert.equal(await scheduler.tick(new Date(first.getTime() + 60_000)), 'skipped');
  assert.equal(runs, 1);

  // 间隔够了：第二次尝试
  assert.equal(await scheduler.tick(new Date(first.getTime() + 6 * 60_000)), 'skipped');
  assert.equal(runs, 2);

  // 超过当日上限：不再尝试
  assert.equal(await scheduler.tick(new Date(first.getTime() + 12 * 60_000)), 'skipped');
  assert.equal(runs, 2);
  assert.equal(failures, 2);
  scheduler.stop();
});

test('周/月触发日：周日与月末（本地时区）', () => {
  // 2026-11-01 是周日；2026-10-31 是周六/月末。
  assert.equal(schedule.isPeriodTriggerDay('weekly', new Date('2026-11-01T02:00:00Z'), 'Asia/Shanghai'), true);
  assert.equal(schedule.isPeriodTriggerDay('weekly', new Date('2026-10-31T02:00:00Z'), 'Asia/Shanghai'), false);
  assert.equal(schedule.isPeriodTriggerDay('monthly', new Date('2026-10-31T02:00:00Z'), 'Asia/Shanghai'), true);
  assert.equal(schedule.isPeriodTriggerDay('monthly', new Date('2026-10-30T02:00:00Z'), 'Asia/Shanghai'), false);
  assert.equal(schedule.isPeriodTriggerDay('daily', new Date('2026-10-30T02:00:00Z'), 'Asia/Shanghai'), true);
});

test('nextOccurrenceFor：周榜落在下一个周日、月榜落在月末', () => {
  const cfg = { enabled: true, time: '08:30:00', timezone: 'Asia/Shanghai', periods: ['daily'] };
  // 2026-10-28（周三）出发 → 下一个周日 2026-11-01 08:30 上海 = 00:30Z
  assert.equal(schedule.nextOccurrenceFor('weekly', new Date('2026-10-28T02:00:00Z'), cfg).toISOString(), '2026-11-01T00:30:00.000Z');
  // 2026-10-15 出发 → 月末 2026-10-31 08:30 上海 = 00:30Z
  assert.equal(schedule.nextOccurrenceFor('monthly', new Date('2026-10-15T00:00:00Z'), cfg).toISOString(), '2026-10-31T00:30:00.000Z');
});

async function makeMultiScheduler(periods, scenarioNow, ran) {
  const { state: stateModule } = await import('../lib/internal.js');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const store = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-sched-multi-')) });
  store.writeSettings({ schedule: { enabled: true, time: '08:30:00', timezone: 'Asia/Shanghai', periods } });
  const scheduler = new schedule.Scheduler({
    store,
    isRunning: () => false,
    getTimer: () => undefined,
    run: async (_trigger, period) => {
      ran.push(period);
      const state = store.readState();
      store.writeState({ ...state, periodSuccess: { ...(state.periodSuccess ?? {}), [period]: scenarioNow } });
    },
    runReleases: async () => undefined,
  });
  return scheduler;
}

test('三周期并行：周日跑 daily+weekly，且同一周期当天不重复', async () => {
  const ran = [];
  const now = '2026-11-01T00:35:00Z';
  const scheduler = await makeMultiScheduler(['daily', 'weekly', 'monthly'], now, ran);
  assert.equal(await scheduler.tick(new Date(now)), 'ran');
  assert.deepEqual(ran.sort(), ['daily', 'weekly']); // 周日：非月末 → 无 monthly
  assert.equal(await scheduler.tick(new Date('2026-11-01T00:40:00Z')), 'skipped');
  assert.deepEqual(ran.sort(), ['daily', 'weekly']);
  scheduler.stop();
});

test('三周期并行：月末跑 daily+monthly', async () => {
  const ran = [];
  const now = '2026-10-31T00:35:00Z';
  const scheduler = await makeMultiScheduler(['daily', 'weekly', 'monthly'], now, ran);
  assert.equal(await scheduler.tick(new Date(now)), 'ran');
  assert.deepEqual(ran.sort(), ['daily', 'monthly']); // 月末：周六非周日 → 无 weekly
  scheduler.stop();
});

// ——— 每周发版行程（releases.schedule.*） ———

const RELEASE = { enabled: true, weekday: 1, time: '08:00:00', timezone: 'Asia/Shanghai' };

test('isoWeekKey：周一为一周起点，按目标时区取周键', () => {
  // 2026-10-26（周一）～ 2026-11-01（周日）同属 2026-W44。
  assert.equal(schedule.isoWeekKey(new Date('2026-10-26T02:00:00Z'), 'Asia/Shanghai'), '2026-W44');
  assert.equal(schedule.isoWeekKey(new Date('2026-11-01T02:00:00Z'), 'Asia/Shanghai'), '2026-W44');
  // 同一 UTC 时刻，上海已经跨到周一 → 下一周；UTC 仍算周日 → 本周。
  assert.equal(schedule.isoWeekKey(new Date('2026-11-01T20:00:00Z'), 'Asia/Shanghai'), '2026-W45');
  assert.equal(schedule.isoWeekKey(new Date('2026-11-01T20:00:00Z'), 'UTC'), '2026-W44');
  // ISO 周年：跨年那周归属上一年。
  assert.equal(schedule.isoWeekKey(new Date('2026-12-28T02:00:00Z'), 'Asia/Shanghai'), '2026-W53');
  assert.equal(schedule.isoWeekKey(new Date('2027-01-01T02:00:00Z'), 'Asia/Shanghai'), '2026-W53');
});

test('nextReleaseOccurrence：严格晚于 now 的下一个发版日', () => {
  // 周三 10:00 上海 → 下周一 08:00 上海 = 00:00Z
  assert.equal(schedule.nextReleaseOccurrence(new Date('2026-10-28T02:00:00Z'), RELEASE).toISOString(), '2026-11-02T00:00:00.000Z');
  // 正好在触发时刻：顺延到下周同一星期
  assert.equal(schedule.nextReleaseOccurrence(new Date('2026-11-02T00:00:00Z'), RELEASE).toISOString(), '2026-11-09T00:00:00.000Z');
  // 周日发版（ISO 7）
  assert.equal(
    schedule.nextReleaseOccurrence(new Date('2026-10-28T02:00:00Z'), { ...RELEASE, weekday: 7 }).toISOString(),
    '2026-11-01T00:00:00.000Z',
  );
  // 非法 weekday 不猜时间，直接抛
  assert.throws(() => schedule.nextReleaseOccurrence(new Date('2026-10-28T02:00:00Z'), { ...RELEASE, weekday: 9 }));
});

test('isReleaseDue：星期匹配 + 过点 + 6 h 补跑窗口', () => {
  assert.equal(schedule.RELEASE_CATCH_UP_MINUTES, 360);
  assert.equal(schedule.isReleaseDue(new Date('2026-11-02T00:00:00Z'), RELEASE), true); // 08:00 整
  assert.equal(schedule.isReleaseDue(new Date('2026-11-02T05:59:00Z'), RELEASE), true); // 13:59，迟到 359 min
  assert.equal(schedule.isReleaseDue(new Date('2026-11-02T06:01:00Z'), RELEASE), false); // 迟到 361 min
  assert.equal(schedule.isReleaseDue(new Date('2026-11-01T23:00:00Z'), RELEASE), false); // 周一 07:00，还没到点
  assert.equal(schedule.isReleaseDue(new Date('2026-11-01T01:00:00Z'), RELEASE), false); // 周日，星期不匹配
});

test('Scheduler.tick 每周只触发一次发版运行，成功后按 ISO 周去重', async () => {
  const store = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-sched-release-')) });
  store.writeSettings({ schedule: { enabled: false }, releases: { schedule: RELEASE } });

  let releaseRuns = 0;
  const scheduler = new schedule.Scheduler({
    store,
    isRunning: () => false,
    getTimer: () => undefined,
    run: async () => {
      throw new Error('榜单行程已禁用，不该触发');
    },
    runReleases: async () => {
      releaseRuns += 1;
      store.writeState({ ...store.readState(), lastReleaseAt: new Date().toISOString(), lastReleaseWeek: '2026-W45' });
    },
  });

  // 2026-11-02 是周一，上海 08:05。
  assert.equal(await scheduler.tick(new Date('2026-11-02T00:05:00Z')), 'ran');
  assert.equal(releaseRuns, 1);
  // 同周再 tick（含下一次日间 tick）：已经成功过，不再跑。
  assert.equal(await scheduler.tick(new Date('2026-11-02T00:30:00Z')), 'disabled');
  assert.equal(releaseRuns, 1);
  // 下一周同一星期：lastReleaseWeek 不同 → 再跑。
  store.writeState({ ...store.readState(), lastReleaseWeek: '2026-W45' });
  assert.equal(await scheduler.tick(new Date('2026-11-09T00:05:00Z')), 'ran');
  assert.equal(releaseRuns, 2);

  const describe = scheduler.describe(store.readState(), new Date('2026-11-09T01:00:00Z'));
  assert.equal(describe.releaseEnabled, true);
  assert.equal(describe.releaseWeekday, 1);
  assert.equal(describe.releaseTime, '08:00:00');
  assert.equal(describe.releaseTimezone, 'Asia/Shanghai');
  assert.equal(describe.releaseCatchUpMinutes, 360);
  assert.equal(describe.nextReleaseAt, '2026-11-16T00:00:00.000Z');
  scheduler.stop();
});

test('Scheduler.tick：超过 6 h 补跑窗口不触发发版；禁用时不触发', async () => {
  const store = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-sched-release2-')) });
  store.writeSettings({ schedule: { enabled: false }, releases: { schedule: RELEASE } });
  let releaseRuns = 0;
  const scheduler = new schedule.Scheduler({
    store,
    isRunning: () => false,
    getTimer: () => undefined,
    run: async () => undefined,
    runReleases: async () => {
      releaseRuns += 1;
    },
  });
  // 上海 14:30，迟到 6.5 h：本周这次放弃，等下周。
  await scheduler.tick(new Date('2026-11-02T06:30:00Z'));
  assert.equal(releaseRuns, 0);

  const disabledStore = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-sched-release3-')) });
  disabledStore.writeSettings({ schedule: { enabled: false }, releases: { schedule: { ...RELEASE, enabled: false } } });
  const off = new schedule.Scheduler({
    store: disabledStore,
    isRunning: () => false,
    getTimer: () => undefined,
    run: async () => undefined,
    runReleases: async () => {
      releaseRuns += 1;
    },
  });
  assert.equal(await off.tick(new Date('2026-11-02T00:05:00Z')), 'disabled');
  assert.equal(releaseRuns, 0);
  scheduler.stop();
  off.stop();
});

test('Scheduler.tick：发版失败后 5 min 内不重试，且最多 2 次（不刷爆 GitHub/模型预算）', async () => {
  const store = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-sched-release4-')) });
  store.writeSettings({ schedule: { enabled: false }, releases: { schedule: RELEASE } });
  let attempts = 0;
  const scheduler = new schedule.Scheduler({
    store,
    isRunning: () => false,
    getTimer: () => undefined,
    run: async () => undefined,
    runReleases: async () => {
      attempts += 1;
      throw new Error('boom');
    },
  });
  const first = new Date('2026-11-02T00:05:00Z');
  await scheduler.tick(first);
  await scheduler.tick(new Date(first.getTime() + 60_000)); // 间隔不足
  assert.equal(attempts, 1);
  await scheduler.tick(new Date(first.getTime() + 6 * 60_000)); // 第二次尝试
  assert.equal(attempts, 2);
  await scheduler.tick(new Date(first.getTime() + 12 * 60_000)); // 超过当日上限
  assert.equal(attempts, 2);
  scheduler.stop();
});

test('Scheduler.tick：有别的运行占锁时发版行程返回 busy，不抢跑', async () => {
  const store = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-sched-release5-')) });
  store.writeSettings({ schedule: { enabled: false }, releases: { schedule: RELEASE } });
  let releaseRuns = 0;
  const scheduler = new schedule.Scheduler({
    store,
    isRunning: () => true,
    getTimer: () => undefined,
    run: async () => undefined,
    runReleases: async () => {
      releaseRuns += 1;
    },
  });
  assert.equal(await scheduler.tick(new Date('2026-11-02T00:05:00Z')), 'busy');
  assert.equal(releaseRuns, 0);
  scheduler.stop();
});
