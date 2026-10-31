import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run as runModule, runner as runnerModule } from '../lib/internal.js';

test('buildCoreArgs 追加 --period（三周期一致）', () => {
  assert.deepEqual(runModule.buildCoreArgs('/c', { dryRun: true, date: '2026-11-01', period: 'weekly' }), [
    'run',
    '--config',
    '/c',
    '--json',
    '--dry-run',
    '--date',
    '2026-11-01',
    '--period',
    'weekly',
  ]);
  assert.deepEqual(runModule.buildCoreArgs('/c', { dryRun: false, period: 'monthly' }), [
    'run',
    '--config',
    '/c',
    '--json',
    '--period',
    'monthly',
  ]);
  // 不传 period 时保持旧行为（无 --period），旧核心也不会因未知参数失败。
  assert.deepEqual(runModule.buildCoreArgs('/c', { dryRun: false }), ['run', '--config', '/c', '--json']);
});

test('periodFileBase / isoWeekName 与 core render.NameOf 对齐', () => {
  assert.equal(runnerModule.periodFileBase('daily', '2026-10-31'), '2026-10-31');
  assert.equal(runnerModule.periodFileBase('monthly', '2026-10-31'), '2026-10');
  assert.equal(runnerModule.periodFileBase('weekly', '2026-11-01'), '2026-W44');
  // ISO 周年跨年：周日归属上周开始的 ISO 周。
  assert.equal(runnerModule.isoWeekName('2025-12-29'), '2026-W01');
  assert.equal(runnerModule.isoWeekName('2027-01-01'), '2026-W53');
  // 非法日期原样返回，不抛。
  assert.equal(runnerModule.isoWeekName('bad'), 'bad');
});
