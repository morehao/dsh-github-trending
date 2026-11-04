import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run as runModule } from '../lib/internal.js';

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

test('buildCoreArgs 追加 --stages（发版只跑 releases；缺省不传）', () => {
  assert.deepEqual(runModule.buildCoreArgs('/c', { dryRun: false, stages: ['releases'] }), [
    'run',
    '--config',
    '/c',
    '--json',
    '--stages',
    'releases',
  ]);
  assert.deepEqual(
    runModule.buildCoreArgs('/c', { dryRun: true, date: '2026-11-02', stages: ['releases'] }),
    ['run', '--config', '/c', '--json', '--dry-run', '--date', '2026-11-02', '--stages', 'releases'],
  );
  // 空数组 = 不窄化，保持旧行为的参数序列。
  assert.deepEqual(runModule.buildCoreArgs('/c', { dryRun: false, stages: [] }), ['run', '--config', '/c', '--json']);
});
