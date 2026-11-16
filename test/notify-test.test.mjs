import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentials, notifyTest } from '../lib/internal.js';

// ── credentials.envVarNames ────────────────────────────────────────────
test('envVarNames 取出 ${VAR} 变量名，忽略非引用', () => {
  assert.deepEqual(credentials.envVarNames('${LARK_WEBHOOK}'), ['LARK_WEBHOOK']);
  assert.deepEqual(credentials.envVarNames('https://x/${A}/y/${B}'), ['A', 'B']);
  assert.deepEqual(credentials.envVarNames(''), []);
  assert.deepEqual(credentials.envVarNames('https://plain.url/hook'), []);
});

// ── credentials.resolveNotifyEnv ───────────────────────────────────────
test('resolveNotifyEnv：把 ${VAR} 解析成真实值（凭据服务 → env 回退）', async () => {
  const services = {
    resolve: async (ref) => (ref === 'LARK_WEBHOOK' ? { value: 'https://stored/hook', source: 'store' } : undefined),
  };
  const env = { DINGTALK_SECRET: 'env-secret' };
  const channels = {
    lark: { webhookURL: '${LARK_WEBHOOK}', secret: '' },
    dingtalk: { webhookURL: '', secret: '${DINGTALK_SECRET}' },
  };
  const out = await credentials.resolveNotifyEnv(services, channels, env);
  assert.equal(out.LARK_WEBHOOK, 'https://stored/hook');
  assert.equal(out.DINGTALK_SECRET, 'env-secret');
});

test('resolveNotifyEnv：真实 URL（无 ${}）不产生任何 env 键', async () => {
  const channels = { lark: { webhookURL: 'https://open.feishu.cn/hook/abc', secret: '' } };
  const out = await credentials.resolveNotifyEnv(undefined, channels, {});
  assert.deepEqual(out, {});
});

test('resolveNotifyEnv：解析不到的变量不注入（核心会因空而失败，返回空值即可）', async () => {
  const channels = { lark: { webhookURL: '${MISSING}', secret: '' } };
  const out = await credentials.resolveNotifyEnv(undefined, channels, {});
  assert.deepEqual(out, {});
});

// ── notifyTest.parseNotifyResult ───────────────────────────────────────
test('parseNotifyResult：契约 RunResult（command=notify）→ {ok, report}', () => {
  const stdout = JSON.stringify({
    ipcSchema: 4,
    ok: true,
    command: 'notify',
    notify: {
      enabled: true,
      attempted: true,
      messages: [{ kind: 'trending', bodyChars: 10, summarySource: 'fallback', channels: [{ channel: 'lark', status: 'sent' }] }],
    },
  });
  const result = notifyTest.parseNotifyResult(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.report.messages[0].channels[0].status, 'sent');
});

test('parseNotifyResult：某渠道 failed → ok=false 但仍返回 report', () => {
  const stdout = JSON.stringify({
    ipcSchema: 4,
    ok: false,
    command: 'notify',
    notify: {
      enabled: true,
      attempted: true,
      messages: [{ kind: 'trending', bodyChars: 1, summarySource: 'fallback', channels: [{ channel: 'lark', status: 'failed', error: 'invalid webhook' }] }],
    },
  });
  const result = notifyTest.parseNotifyResult(stdout);
  assert.equal(result.ok, false);
  assert.equal(result.report.messages[0].channels[0].error, 'invalid webhook');
});

test('parseNotifyResult：核心返回 error 信封 → 抛 IpcError', () => {
  const stdout = JSON.stringify({ ipcSchema: 4, ok: false, command: 'notify', error: { code: 'CONFIG_INVALID', message: 'bad channel' } });
  assert.throws(() => notifyTest.parseNotifyResult(stdout), /bad channel/);
});

test('parseNotifyResult：command≠notify → 拒绝', () => {
  assert.throws(() => notifyTest.parseNotifyResult(JSON.stringify({ command: 'run' })), /command≠notify/);
});

test('parseNotifyResult：空输出 / 非 JSON → 拒绝', () => {
  assert.throws(() => notifyTest.parseNotifyResult(''), /没有任何输出/);
  assert.throws(() => notifyTest.parseNotifyResult('not json'), /不是 JSON/);
});
