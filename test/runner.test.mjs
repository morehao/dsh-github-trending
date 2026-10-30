import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner as runnerModule, state as stateModule, schedule as scheduleModule } from '../lib/internal.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CORE = path.join(here, 'fixtures', 'fake-core.mjs');
const ENV_KEY = 'DSHGT_TEST_MODEL_KEY';

function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), 'dshgt-repo-'));
  mkdirSync(path.join(repo, '.git'));
  return repo;
}

/**
 * 每个用例生成一个「场景版」核心：把 FAKE_* 写进脚本自身再 import 真正的假核心。
 * 为什么不靠子进程环境变量：插件的 sanitizedEnv 只传白名单变量，FAKE_* 本来就到不了子进程
 * ——这正好证明了环境清洗生效，测试也必须按这个事实来写。
 */
function fakeCore(scenario = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dshgt-core-'));
  const file = path.join(dir, 'core.mjs');
  const assignments = Object.entries(scenario)
    .map(([key, value]) => `process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)};`)
    .join('\n');
  writeFileSync(
    file,
    `#!/usr/bin/env node\n${assignments}\nawait import(${JSON.stringify(`file://${FAKE_CORE}`)});\n`,
  );
  chmodSync(file, 0o755);
  return file;
}

function makeRunner(overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dshgt-run-'));
  const store = new stateModule.Store({ dir });
  const repo = makeRepo();
  store.writeSettings({
    model: { provider: 'deepseek', model: 'deepseek-chat', apiKeyRef: ENV_KEY, baseURL: 'https://api.deepseek.com/v1' },
    repo: { path: repo },
    ...overrides.settings,
  });
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TRENDING_DIGEST_CORE: overrides.core ?? fakeCore(overrides.scenario ?? {}),
    [ENV_KEY]: 'sk-test-key',
    ...overrides.env,
  };
  const runner = new runnerModule.Runner({ store, get: () => undefined, env });
  return { runner, store, repo, env };
}

test('成功运行：结果归一化 + 状态与历史落盘 + 密钥经通道送达', async () => {
  const { runner, store } = makeRunner();
  const summary = await runner.run({ trigger: 'tool' });
  assert.equal(summary.ok, true);
  assert.equal(summary.skipped, false);
  assert.equal(summary.files, 1);
  assert.equal(summary.branch, 'trending/2026-10-30');
  assert.equal(summary.prUrl, 'https://example.invalid/pr/1');
  assert.equal(summary.channel, 'fifo');
  // 假核心只有读到带 apiKey 的配置才会输出这个哈希：证明密钥确实经通道送达
  assert.equal(summary.contentHash, 'hash-with-key');

  const state = store.readState();
  assert.equal(state.lastDigest.contentHash, 'hash-with-key');
  assert.equal(state.pendingPr.url, 'https://example.invalid/pr/1');
  assert.equal(store.readHistory().length, 1);
  assert.equal(runner.running, undefined);
});

test('skipped 运行不覆盖 lastDigest，也不产生 pendingPr', async () => {
  const { runner, store } = makeRunner({ scenario: { FAKE_SKIPPED: '1' } });
  const summary = await runner.run({ trigger: 'schedule' });
  assert.equal(summary.ok, true);
  assert.equal(summary.skipped, true);
  assert.equal(summary.files, 0);
  assert.equal(store.readState().lastDigest, undefined);
  assert.equal(store.readState().pendingPr, undefined);
});

test('核心协议不匹配 → CORE_INCOMPATIBLE，且不产生任何文件级结果', async () => {
  const { runner, store } = makeRunner({ scenario: { FAKE_IPC_SCHEMA: '2' } });
  const summary = await runner.run({ trigger: 'tool' });
  assert.equal(summary.ok, false);
  assert.equal(summary.error.code, 'CORE_INCOMPATIBLE');
  assert.equal(store.readHistory().length, 1);
});

test('核心不存在 → CORE_UNAVAILABLE', async () => {
  const { runner } = makeRunner({ env: { TRENDING_DIGEST_CORE: '/definitely/not/here' } });
  const summary = await runner.run({ trigger: 'tool' });
  assert.equal(summary.ok, false);
  assert.equal(summary.error.code, 'CORE_UNAVAILABLE');
});

test('模型 401 → MODEL_UNAUTHORIZED，并标记 error 由文本推断', async () => {
  const { runner } = makeRunner({ scenario: { FAKE_EXIT: '1', FAKE_STDERR: 'HTTP 401: incorrect api key provided' } });
  const summary = await runner.run({ trigger: 'tool' });
  assert.equal(summary.ok, false);
  assert.equal(summary.error.code, 'MODEL_UNAUTHORIZED');
  assert.equal(summary.error.inferred, true);
  assert.equal(summary.error.area, 'model');
});

test('取消：SIGTERM 终止核心，返回 CORE_CANCELLED 且不写 lastDigest', async () => {
  const { runner, store } = makeRunner({ scenario: { FAKE_SLEEP: '4000' } });
  const pending = runner.run({ trigger: 'manual' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(runner.running !== undefined, true);
  assert.equal(runner.cancel(), true);
  const summary = await pending;
  assert.equal(summary.ok, false);
  assert.equal(summary.error.code, 'CORE_CANCELLED');
  assert.ok(summary.durationMs < 3500, `应当在取消后很快结束，实际 ${summary.durationMs}ms`);
  assert.equal(store.readState().lastDigest, undefined);
});

test('并发第二次运行被拒绝', async () => {
  const { runner } = makeRunner({ scenario: { FAKE_SLEEP: '1200' } });
  const first = runner.run({ trigger: 'manual' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await assert.rejects(async () => {
    await runner.run({ trigger: 'manual' });
  }, /已有一次运行在进行中/);
  runner.cancel();
  await first;
});

test('配置不完整时直接失败，不 spawn', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dshgt-badcfg-'));
  const store = new stateModule.Store({ dir });
  store.writeSettings({ repo: { path: '' } });
  const runner = new runnerModule.Runner({ store, get: () => undefined, env: { TRENDING_DIGEST_CORE: FAKE_CORE, [ENV_KEY]: 'k' } });
  // 配置不完整属于「还没开始跑」：直接抛 IpcError，HTTP 层回 400，不写任何运行记录
  await assert.rejects(async () => {
    await runner.run({ trigger: 'tool' });
  }, /配置不完整/);
  assert.equal(store.readHistory().length, 0);
});

test('握手途中取消 → CORE_CANCELLED（而不是 CORE_INCOMPATIBLE）', async () => {
  const { runner } = makeRunner({ scenario: { FAKE_SLEEP: '1' } });
  const pending = runner.run({ trigger: 'manual' });
  // 立刻取消：此时大概率还在握手/定位阶段
  runner.cancel();
  const summary = await pending;
  assert.equal(summary.ok, false);
  assert.equal(summary.error.code, 'CORE_CANCELLED');
});

test('代理模式：把代理一次性 token 作为 apiKey 传给核心（否则核心静默降级为英文）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dshgt-proxy-'));
  const store = new stateModule.Store({ dir });
  const repo = makeRepo();
  store.writeSettings({
    model: { provider: 'openai-compatible', mode: 'proxy', hostProvider: 'magpie', model: 'm', baseURL: '', apiKeyRef: 'UNUSED' },
    repo: { path: repo },
  });
  // 宿主 llm 服务：代理开启需要它，但假核心不会真的发请求。
  const llm = { stream: async function* () {} };
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TRENDING_DIGEST_CORE: fakeCore({}),
  };
  const runner = new runnerModule.Runner({ store, get: (name) => (name === 'llm' ? llm : undefined), env });
  const summary = await runner.run({ trigger: 'tool' });
  assert.equal(summary.ok, true);
  assert.equal(summary.proxy, true);
  // 假核心只有在配置里读到非空 apiKey 时才返回 hash-with-key；
  // 代理模式下这个 apiKey 必须是一次的代理 token，而不是空串。
  assert.equal(summary.contentHash, 'hash-with-key');
});

test('默认按调度时区计算运行日期，并写进摘要与 lastDigest', async () => {
  const { runner, store } = makeRunner();
  const summary = await runner.run({ trigger: 'tool' });
  const expected = scheduleModule.zonedDateString(new Date(), 'Asia/Shanghai');
  assert.equal(summary.date, expected);
  assert.equal(store.readState().lastDigest.date, expected);
});

test('存在未合并 pendingPr 时也照常运行（核心 v0.2.0 用 force-with-lease 更新 PR，插件不再拦截）', async () => {
  const { runner, store } = makeRunner();
  const today = scheduleModule.zonedDateString(new Date(), 'Asia/Shanghai');
  store.writeState({ pendingPr: { url: 'https://github.com/o/r/pull/9', createdAt: new Date().toISOString(), date: today } });
  const summary = await runner.run({ trigger: 'manual' });
  assert.equal(summary.ok, true);
  assert.equal(store.readHistory().length, 1);
});

