import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run as runModule } from '../lib/internal.js';

test('buildCoreArgs：force=true 时追加 --force，false/缺省不追加', () => {
  const { buildCoreArgs } = runModule;
  const base = { dryRun: false, period: 'daily' };
  assert.ok(buildCoreArgs('/cfg', { ...base, force: true }).includes('--force'));
  assert.equal(buildCoreArgs('/cfg', base).includes('--force'), false);
  assert.equal(buildCoreArgs('/cfg', { ...base, force: false }).includes('--force'), false);
});

test('proxyEnv：空串/intra 不注入，合法地址大小写两份都注入', () => {
  const { proxyEnv } = runModule;
  assert.deepEqual(proxyEnv(''), {});
  assert.deepEqual(proxyEnv(undefined), {});
  const env = proxyEnv('http://127.0.0.1:7890');
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    assert.equal(env[k], 'http://127.0.0.1:7890', `${k} 应注入`);
  }
});
