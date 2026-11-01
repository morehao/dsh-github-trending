import { test } from 'node:test';
import assert from 'node:assert/strict';
import { version as versionModule, run as runModule } from '../lib/internal.js';

test('versionAtLeast：三段数字比较，含阈值相等', () => {
  const { versionAtLeast } = versionModule;
  assert.equal(versionAtLeast('0.7.1', '0.7.1'), true);
  assert.equal(versionAtLeast('0.7.2', '0.7.1'), true);
  assert.equal(versionAtLeast('0.8.0', '0.7.1'), true);
  assert.equal(versionAtLeast('1.0.0', '0.7.1'), true);
  assert.equal(versionAtLeast('0.7.0', '0.7.1'), false);
  assert.equal(versionAtLeast('0.6.9', '0.7.1'), false);
  // 预发布后缀忽略；可解析前缀即可
  assert.equal(versionAtLeast('0.7.1-rc1', '0.7.1'), true);
  assert.equal(versionAtLeast('v0.7.1', '0.7.1'), true);
  // 不可解析 → 保守判 false
  assert.equal(versionAtLeast('dev', '0.7.1'), false);
});

test('buildCoreArgs：force=true 时追加 --force，false/缺省不追加', () => {
  const { buildCoreArgs } = runModule;
  const base = { dryRun: false, period: 'daily' };
  assert.ok(buildCoreArgs('/cfg', { ...base, force: true }).includes('--force'));
  assert.equal(buildCoreArgs('/cfg', base).includes('--force'), false);
  assert.equal(buildCoreArgs('/cfg', { ...base, force: false }).includes('--force'), false);
});
