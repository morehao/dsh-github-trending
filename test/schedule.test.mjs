import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule } from '../lib/internal.js';

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
  });
  const now = new Date('2026-10-30T00:35:00Z');
  assert.equal(await scheduler.tick(now), 'ran');
  assert.equal(runs, 1);
  assert.equal(await scheduler.tick(now), 'skipped');

  const disabled = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-sched2-')) });
  disabled.writeSettings({ schedule: { enabled: false } });
  const off = new schedule.Scheduler({ store: disabled, isRunning: () => false, getTimer: () => undefined, run: async () => undefined });
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
