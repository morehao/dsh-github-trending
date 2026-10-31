import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner as runnerModule, state as stateModule, schedule as scheduleModule } from '../lib/internal.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CORE = path.join(here, 'fixtures', 'fake-core.mjs');
const ENV_KEY = 'DSHGT_TEST_MODEL_KEY';
// 与 test/fixtures/fake-core.mjs 保持一致：契约 RunResult 的 contentHash 有固定形态。
const HASH_WITH_KEY = `sha256:${'a'.repeat(64)}`;
const HASH_NO_KEY = `sha256:${'b'.repeat(64)}`;

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
  const runner = new runnerModule.Runner({
    store,
    get: () => undefined,
    env,
    ...(overrides.logger === undefined ? {} : { logger: overrides.logger }),
  });
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
  assert.equal(summary.contentHash, HASH_WITH_KEY);

  const state = store.readState();
  assert.equal(state.lastDigest.contentHash, HASH_WITH_KEY);
  assert.equal(state.lastDigest.contentHashAlgo, 'jcs-sha256-v1');
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
  const { runner, store } = makeRunner({ scenario: { FAKE_IPC_SCHEMA: '1' } });
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
  // 假核心只有在配置里读到非空 apiKey 时才返回 HASH_WITH_KEY；
  // 代理模式下这个 apiKey 必须是一次的代理 token，而不是空串。
  assert.equal(summary.contentHash, HASH_WITH_KEY);
});

test('默认按调度时区计算运行日期，并写进摘要与 lastDigest', async () => {
  const { runner, store } = makeRunner();
  const summary = await runner.run({ trigger: 'tool' });
  const expected = scheduleModule.zonedDateString(new Date(), 'Asia/Shanghai');
  assert.equal(summary.date, expected);
  assert.equal(store.readState().lastDigest.date, expected);
});

test('存在未合并 pendingPr 时也照常运行（同日重跑由核心追加提交并更新 PR）', async () => {
  const { runner, store } = makeRunner();
  const today = scheduleModule.zonedDateString(new Date(), 'Asia/Shanghai');
  store.writeState({ pendingPr: { url: 'https://github.com/o/r/pull/9', createdAt: new Date().toISOString(), date: today } });
  const summary = await runner.run({ trigger: 'manual' });
  assert.equal(summary.ok, true);
  assert.equal(store.readHistory().length, 1);
});


// ——— 预览副本 ———

const DATED = '2026-10-30';

function shaOf(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

test('成功运行：从 outcome.files 复制当天 .md 到 previews/，并写 date/commit/preview', async () => {
  const content = '# 日报\n\n今天的条目';
  const { runner, store } = makeRunner({
    scenario: { FAKE_ARTIFACT_PATH: `trending/${DATED}.md`, FAKE_ARTIFACT_CONTENT: content },
  });
  const summary = await runner.run({ trigger: 'tool', date: DATED });
  assert.equal(summary.ok, true);
  assert.equal(summary.commit, 'deadbeef');
  assert.deepEqual(summary.preview, {
    file: `trending/${DATED}.md`,
    bytes: Buffer.byteLength(content),
    sha256: shaOf(content),
  });
  const preview = store.readPreview(summary.id);
  assert.equal(preview.text, content);
  const file = path.join(store.dir, 'previews', `${summary.id}.md`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const record = store.readHistory()[0];
  assert.equal(record.date, DATED);
  assert.equal(record.commit, 'deadbeef');
  assert.equal(record.preview.file, `trending/${DATED}.md`);
});

test('多个 .md 时优先 basename === <date>.md', async () => {
  const { runner } = makeRunner({
    scenario: {
      FAKE_ARTIFACTS: JSON.stringify([
        { path: 'trending/extra.md', content: 'extra' },
        { path: `trending/${DATED}.md`, content: 'dated' },
      ]),
    },
  });
  const summary = await runner.run({ trigger: 'tool', date: DATED });
  assert.equal(summary.preview.file, `trending/${DATED}.md`);
});

test('只有一个 .md 时回退使用它', async () => {
  const { runner } = makeRunner({
    scenario: { FAKE_ARTIFACT_PATH: 'trending/all.md', FAKE_ARTIFACT_CONTENT: 'single' },
  });
  const summary = await runner.run({ trigger: 'tool', date: DATED });
  assert.equal(summary.preview.file, 'trending/all.md');
});

test('多个 .md 且没有当天文件时不猜，不生成预览', async () => {
  const events = [];
  const { runner } = makeRunner({
    logger: (event, data) => events.push({ event, data }),
    scenario: {
      FAKE_ARTIFACTS: JSON.stringify([
        { path: 'trending/a.md', content: 'a' },
        { path: 'trending/b.md', content: 'b' },
      ]),
    },
  });
  const summary = await runner.run({ trigger: 'tool', date: DATED });
  assert.equal(summary.preview, undefined);
  assert.ok(events.some((item) => item.event === 'preview.skip' && item.data.reason === 'ambiguous'));
});

test('路径穿越 / 绝对路径：不读 repo 外的文件', async () => {
  const outsideDir = mkdtempSync(path.join(tmpdir(), 'dshgt-outside-'));
  const outside = path.join(outsideDir, 'evil.md');
  writeFileSync(outside, '# evil');

  const traversal = makeRunner({
    scenario: { FAKE_ARTIFACT_PATH: '../evil.md', FAKE_ARTIFACT_CONTENT: '# evil' },
  });
  const traversalSummary = await traversal.runner.run({ trigger: 'tool', date: DATED });
  assert.equal(traversalSummary.preview, undefined);

  const absolute = makeRunner({
    scenario: { FAKE_ARTIFACT_PATH: outside },
  });
  const absoluteSummary = await absolute.runner.run({ trigger: 'tool', date: DATED });
  assert.equal(absoluteSummary.preview, undefined);
  assert.equal(existsSync(path.join(traversal.store.dir, 'previews', `${traversalSummary.id}.md`)), false);
});

test('超过 512 KB 的 artifact 不复制', async () => {
  const { runner, store } = makeRunner({
    scenario: { FAKE_ARTIFACT_PATH: `trending/${DATED}.md`, FAKE_ARTIFACT_SIZE: String(512 * 1024 + 1) },
  });
  const summary = await runner.run({ trigger: 'tool', date: DATED });
  assert.equal(summary.preview, undefined);
  assert.equal(store.readHistory()[0].preview, undefined);
});

test('内容含 NUL 字节时跳过', async () => {
  const { runner } = makeRunner({
    scenario: { FAKE_ARTIFACT_PATH: `trending/${DATED}.md`, FAKE_ARTIFACT_CONTENT: '# a', FAKE_ARTIFACT_NUL: '1' },
  });
  const summary = await runner.run({ trigger: 'tool', date: DATED });
  assert.equal(summary.preview, undefined);
});

test('artifact 的 sha256 与内容不一致时跳过', async () => {
  const { runner, store } = makeRunner({
    scenario: {
      FAKE_ARTIFACT_PATH: `trending/${DATED}.md`,
      FAKE_ARTIFACT_CONTENT: '# a',
      FAKE_ARTIFACT_SHA: `sha256:${'d'.repeat(64)}`,
    },
  });
  const summary = await runner.run({ trigger: 'tool', date: DATED });
  assert.equal(summary.preview, undefined);
  assert.equal(existsSync(path.join(store.dir, 'previews', `${summary.id}.md`)), false);
});

test('试跑 / 无变更 / 失败都不生成预览', async () => {
  const dry = makeRunner({
    scenario: { FAKE_ARTIFACT_PATH: `trending/${DATED}.md`, FAKE_ARTIFACT_CONTENT: '# dry' },
  });
  const drySummary = await dry.runner.run({ trigger: 'manual', date: DATED, dryRun: true });
  assert.equal(drySummary.preview, undefined);

  const skipped = makeRunner({ scenario: { FAKE_SKIPPED: '1' } });
  const skippedSummary = await skipped.runner.run({ trigger: 'schedule', date: DATED });
  assert.equal(skippedSummary.preview, undefined);

  const failed = makeRunner({ scenario: { FAKE_EXIT: '1', FAKE_STDERR: 'error: INTERNAL: boom' } });
  const failedSummary = await failed.runner.run({ trigger: 'manual', date: DATED });
  assert.equal(failedSummary.preview, undefined);
  assert.equal(failed.store.readHistory()[0].preview, undefined);
});

test('预览生成失败不阻断运行，结果照常写盘', async () => {
  const events = [];
  const { runner, store } = makeRunner({
    logger: (event, data) => events.push({ event, data }),
    scenario: { FAKE_ARTIFACT_PATH: `trending/${DATED}.md`, FAKE_ARTIFACT_SHA: `sha256:${'d'.repeat(64)}`, FAKE_ARTIFACT_CONTENT: '# a' },
  });
  const summary = await runner.run({ trigger: 'manual', date: DATED });
  assert.equal(summary.ok, true);
  assert.equal(store.readHistory().length, 1);
  const record = store.readHistory()[0];
  assert.equal(record.ok, true);
  assert.equal(record.preview, undefined);
  assert.ok(events.some((item) => item.event === 'preview.skip'));
});

test('触发来源经环境变量传给核心：schedule → schedule，tool → manual', async () => {
  const scheduled = makeRunner({ scenario: { FAKE_ECHO_TRIGGER: '1' } });
  const s1 = await scheduled.runner.run({ trigger: 'schedule' });
  assert.deepEqual(s1.warnings, ['trigger=schedule']);

  const manual = makeRunner({ scenario: { FAKE_ECHO_TRIGGER: '1' } });
  const s2 = await manual.runner.run({ trigger: 'tool' });
  assert.deepEqual(s2.warnings, ['trigger=manual']);
});

test('核心的 skipReason 进入摘要与历史', async () => {
  const { runner, store } = makeRunner({ scenario: { FAKE_SKIPPED: '1', FAKE_SKIP_REASON: 'pr-closed' } });
  const summary = await runner.run({ trigger: 'schedule' });
  assert.equal(summary.skipReason, 'pr-closed');
  assert.equal(store.readHistory()[0].skipReason, 'pr-closed');
});

test('push 失败带 reason：stale info → stale-lease，提示可自愈', async () => {
  const stderr = [
    'error: GIT_OPERATION_FAILED: To github.com:owner/repo.git',
    ' ! [rejected]        trending/2026-10-31 -> trending/2026-10-31 (stale info)',
    "error: failed to push some refs to 'github.com:owner/repo.git'",
  ].join('\n');
  const { runner, store } = makeRunner({ scenario: { FAKE_EXIT: '1', FAKE_STDERR: stderr } });
  const summary = await runner.run({ trigger: 'tool' });
  assert.equal(summary.error.code, 'GIT_OPERATION_FAILED');
  assert.equal(summary.error.reason, 'stale-lease');
  assert.match(summary.error.hint, /fetch --prune/);
  assert.doesNotMatch(summary.error.hint, /non-fast-forward/);
  assert.equal(store.readHistory()[0].errorReason, 'stale-lease');
});
