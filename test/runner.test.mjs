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
  // 等核心真的读到配置（假核心落 ready 标记）再取消：否则机器忙时取消可能撞在
  // 「已 spawn、还没读 FIFO」的窗口，插件会等满配置通道的 15 s 写超时，测到的就不是取消延迟了。
  const ready = path.join(mkdtempSync(path.join(tmpdir(), 'dshgt-ready-')), 'core-ready');
  const { runner, store } = makeRunner({ scenario: { FAKE_SLEEP: '4000', FAKE_READY_FILE: ready } });
  const pending = runner.run({ trigger: 'manual' });
  const deadline = Date.now() + 10_000;
  while (!existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(existsSync(ready), true, '核心应已读到配置并进入运行');
  assert.equal(runner.running !== undefined, true);
  // 只测「取消后多快结束」，不测整次运行的墙钟时长：并行跑测试文件时进程启动会被
  // 拖慢，用总时长做阈值会把机器负载误判成取消失效。
  const cancelAt = Date.now();
  assert.equal(runner.cancel(), true);
  const summary = await pending;
  const cancelMs = Date.now() - cancelAt;
  assert.equal(summary.ok, false);
  assert.equal(summary.error.code, 'CORE_CANCELLED');
  assert.ok(cancelMs < 3500, `应当在取消后很快结束，实际 ${cancelMs}ms`);
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

test('预览路径以 core 回传的 digest.path 为准（不再按文件名猜）', async () => {
  const { runner, store } = makeRunner({
    scenario: {
      FAKE_ARTIFACTS: JSON.stringify([
        { path: 'trending/extra.md', content: 'extra' },
        { path: `trending/${DATED}.md`, content: 'dated' },
      ]),
    },
  });
  const summary = await runner.run({ trigger: 'tool', date: DATED });
  assert.equal(summary.preview.file, 'trending/extra.md');
  assert.equal(store.readPreview(summary.id).text, 'extra');
});

test('核心没有回传 digest（纯发版 / 渲染前失败）→ 不生成预览，日志留痕', async () => {
  const events = [];
  const { runner } = makeRunner({
    logger: (event, data) => events.push({ event, data }),
    scenario: { FAKE_DIGEST: '0' },
  });
  const summary = await runner.run({ trigger: 'tool', date: DATED });
  assert.equal(summary.ok, true);
  assert.equal(summary.preview, undefined);
  assert.ok(events.some((item) => item.event === 'preview.skip' && item.data.reason === 'no-digest'));
});

test('仓库工作树里没有产物文件，也照样生成预览（不再读 repo）', async () => {
  const content = '# 来自信封\n\n今天没有落盘文件';
  const { runner, store, repo } = makeRunner({
    scenario: {
      FAKE_ARTIFACT_PATH: `trending/${DATED}.md`,
      FAKE_ARTIFACT_CONTENT: content,
    },
  });
  const summary = await runner.run({ trigger: 'tool', date: DATED });
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.preview, {
    file: `trending/${DATED}.md`,
    bytes: Buffer.byteLength(content),
    sha256: shaOf(content),
  });
  assert.equal(store.readPreview(summary.id).text, content);
  // 工作树里确实没有这个文件：预览完全来自 RunResult.digest。
  assert.equal(existsSync(path.join(repo, `trending/${DATED}.md`)), false);
});

test('usage + releases 投影进摘要与历史：tokens = 榜单 + 订阅', async () => {
  const { runner, store } = makeRunner({
    scenario: { FAKE_USAGE: '140', FAKE_RELEASES: '6,9,60,1,0,2' },
  });
  const summary = await runner.run({ trigger: 'tool', date: DATED });
  assert.equal(summary.tokens, 200); // 140 + 60
  assert.equal(summary.releases.repos, 6);
  assert.equal(summary.releases.newReleases, 9);
  assert.equal(summary.releases.degraded, 1);
  const record = store.readHistory()[0];
  assert.equal(record.tokens, 200);
  assert.equal(record.releases.newReleases, 9);
});

test('旧核心无 usage/releases：tokens/releases 缺省', async () => {
  const { runner } = makeRunner();
  const summary = await runner.run({ trigger: 'tool', date: DATED });
  assert.equal(summary.tokens, undefined);
  assert.equal(summary.releases, undefined);
});

test('digest.path 不在 files 里 → IPC_INVALID（核心自相矛盾）', async () => {
  const { runner, store } = makeRunner({
    scenario: { FAKE_ARTIFACT_PATH: `trending/${DATED}.md`, FAKE_ARTIFACT_CONTENT: '# a', FAKE_DIGEST_PATH: 'elsewhere.md' },
  });
  const summary = await runner.run({ trigger: 'tool', date: DATED });
  assert.equal(summary.ok, false);
  assert.equal(summary.error.code, 'IPC_INVALID');
  assert.equal(store.readHistory().length, 1);
  assert.equal(store.readHistory()[0].preview, undefined);
  assert.equal(existsSync(path.join(store.dir, 'previews', `${summary.id}.md`)), false);
});

test('digest.bytes 与 text 的实际字节数不一致 → IPC_INVALID', async () => {
  const { runner } = makeRunner({
    scenario: { FAKE_ARTIFACT_PATH: `trending/${DATED}.md`, FAKE_ARTIFACT_CONTENT: '# a', FAKE_DIGEST_BYTES: '999' },
  });
  const summary = await runner.run({ trigger: 'tool', date: DATED });
  assert.equal(summary.ok, false);
  assert.equal(summary.error.code, 'IPC_INVALID');
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

test('digest 的 sha256 与 files 不一致 → IPC_INVALID，不生成预览', async () => {
  const { runner, store } = makeRunner({
    scenario: {
      FAKE_ARTIFACT_PATH: `trending/${DATED}.md`,
      FAKE_ARTIFACT_CONTENT: '# a',
      FAKE_DIGEST_SHA: `sha256:${'d'.repeat(64)}`,
    },
  });
  const summary = await runner.run({ trigger: 'tool', date: DATED });
  assert.equal(summary.ok, false);
  assert.equal(summary.error.code, 'IPC_INVALID');
  assert.equal(existsSync(path.join(store.dir, 'previews', `${summary.id}.md`)), false);
});

test('试跑 / 无产物 / 失败都不生成预览', async () => {
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

test('unchanged（skipped）只要核心回传 digest 也刷新预览，不再依赖 force', async () => {
  const content = '# unchanged digest\n';
  const { runner, store } = makeRunner({
    scenario: {
      FAKE_SKIPPED: '1',
      FAKE_SKIP_REASON: 'unchanged',
      FAKE_SKIPPED_WITH_ARTIFACTS: '1',
      FAKE_ARTIFACT_PATH: `trending/${DATED}.md`,
      FAKE_ARTIFACT_CONTENT: content,
    },
  });
  const summary = await runner.run({ trigger: 'schedule', date: DATED });
  assert.equal(summary.ok, true);
  assert.equal(summary.skipped, true);
  assert.deepEqual(summary.preview, {
    file: `trending/${DATED}.md`,
    bytes: Buffer.byteLength(content),
    sha256: shaOf(content),
  });
  assert.equal(store.readPreview(summary.id).text, content);
});

test('预览写盘失败不阻断运行，结果照常写盘', async () => {
  const events = [];
  const { runner, store } = makeRunner({
    logger: (event, data) => events.push({ event, data }),
    scenario: { FAKE_ARTIFACT_PATH: `trending/${DATED}.md`, FAKE_ARTIFACT_CONTENT: '# a' },
  });
  // 把 previews/ 变成只读目录：写预览必失败，但运行本身必须照常成功。
  const previews = path.join(store.dir, 'previews');
  mkdirSync(previews, { recursive: true });
  chmodSync(previews, 0o500);
  try {
    const summary = await runner.run({ trigger: 'manual', date: DATED });
    assert.equal(summary.ok, true);
    assert.equal(summary.preview, undefined);
    const record = store.readHistory()[0];
    assert.equal(record.ok, true);
    assert.equal(record.preview, undefined);
    assert.ok(events.some((item) => item.event === 'preview.skip' && item.data.reason === 'write-failed'));
  } finally {
    chmodSync(previews, 0o700);
  }
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

test('daily 预览：使用 core 声明的 digest（根 index.md 不影响）', async () => {
  const { runner, store } = makeRunner({
    scenario: {
      FAKE_ARTIFACTS: JSON.stringify([
        { path: `daily/2026-10/${DATED}.md`, content: '# daily' },
        { path: 'index.md', content: '# index' },
      ]),
    },
  });
  const summary = await runner.run({ trigger: 'tool', date: DATED });
  assert.equal(summary.period, 'daily');
  assert.equal(summary.preview.file, `daily/2026-10/${DATED}.md`);
  assert.equal(store.readPreview(summary.id).text, '# daily');
});

test('周榜预览：使用 core 声明的 digest（YYYY-Wnn）', async () => {
  const { runner, store } = makeRunner({
    scenario: {
      FAKE_ARTIFACTS: JSON.stringify([
        { path: 'weekly/2026/2026-W44.md', content: '# weekly' },
        { path: 'index.md', content: '# index' },
      ]),
    },
  });
  const summary = await runner.run({ trigger: 'tool', date: '2026-11-01', period: 'weekly' });
  assert.equal(summary.period, 'weekly');
  assert.equal(summary.preview.file, 'weekly/2026/2026-W44.md');
  assert.equal(store.readPreview(summary.id).text, '# weekly');
});

test('月榜预览：使用 core 声明的 digest（YYYY-MM）', async () => {
  const { runner, store } = makeRunner({
    scenario: {
      FAKE_ARTIFACTS: JSON.stringify([
        { path: 'monthly/2026/2026-10.md', content: '# monthly' },
        { path: 'index.md', content: '# index' },
      ]),
    },
  });
  const summary = await runner.run({ trigger: 'tool', date: '2026-10-31', period: 'monthly' });
  assert.equal(summary.period, 'monthly');
  assert.equal(summary.preview.file, 'monthly/2026/2026-10.md');
  assert.equal(store.readPreview(summary.id).text, '# monthly');
});

test('period 落进摘要与历史（schedule 触发按周期）', async () => {
  const { runner, store } = makeRunner();
  const summary = await runner.run({ trigger: 'schedule', period: 'weekly' });
  assert.equal(summary.period, 'weekly');
  assert.equal(store.readHistory()[0].period, 'weekly');
  assert.equal(store.readState().periodSuccess.weekly !== undefined, true);
});

test('runMany：省略 period 时默认依次跑日/周/月三榜，各自落历史与 periodSuccess', async () => {
  const { runner, store } = makeRunner();
  const summaries = await runner.runMany({ trigger: 'manual' });
  assert.deepEqual(summaries.map((summary) => summary.period), ['daily', 'weekly', 'monthly']);
  assert.equal(summaries.every((summary) => summary.ok), true);
  const history = store.readHistory();
  assert.deepEqual(history.map((record) => record.period), ['monthly', 'weekly', 'daily']); // 最新在前
  const state = store.readState();
  assert.notEqual(state.periodSuccess.daily, undefined);
  assert.notEqual(state.periodSuccess.weekly, undefined);
  assert.notEqual(state.periodSuccess.monthly, undefined);
  assert.equal(runner.running, undefined);
});

test('runMany：显式 periods 只跑选定周期', async () => {
  const { runner, store } = makeRunner();
  const summaries = await runner.runMany({ trigger: 'manual', periods: ['weekly'] });
  assert.deepEqual(summaries.map((summary) => summary.period), ['weekly']);
  assert.equal(store.readHistory().length, 1);
});

// ——— 发版运行（run --stages releases） ———

test('runReleases：只跑发版阶段并落一条 releaseRuns 记录，不写 history', async () => {
  const { runner, store } = makeRunner({
    // FAKE_REQUIRE_STAGES 让假核心在缺少 `--stages releases` 时直接失败。
    scenario: { FAKE_REQUIRE_STAGES: '1', FAKE_RELEASES: '6,9,60,1,0,2,6,2' },
  });
  const record = await runner.runReleases({ trigger: 'manual' });
  assert.equal(record.status, 'ok');
  assert.equal(record.checked, 6);
  assert.equal(record.changed, 2);
  assert.equal(record.newTags, 9);
  assert.equal(record.summarized, 9);
  assert.equal(record.degraded, 1);
  assert.equal(record.failed, 0);
  assert.equal(record.rateLimited, 0);
  assert.equal(record.durationMs, 1000); // 取 releases 阶段自己的耗时
  assert.equal(record.tokens, 60);
  assert.equal(record.commit, 'deadbeef');
  assert.equal(record.prUrl, 'https://example.invalid/pr/1');
  assert.equal(record.branch, 'trending/2026-10-30');
  assert.equal(record.coreVersion, '0.3.0-fake');

  const state = store.readState();
  assert.equal(state.lastReleaseAt, record.finishedAt);
  assert.equal(state.lastReleaseWeek, scheduleModule.isoWeekKey(new Date(record.finishedAt), 'Asia/Shanghai'));
  assert.equal(store.readReleaseRuns().length, 1);
  assert.equal(store.readHistory().length, 0); // 发版运行绝不进榜单历史
  assert.equal(runner.running, undefined);
});

test('runReleases：skipped 也算成功（锁本周），history 仍为空', async () => {
  const { runner, store } = makeRunner({ scenario: { FAKE_REQUIRE_STAGES: '1', FAKE_SKIPPED: '1' } });
  const record = await runner.runReleases({ trigger: 'schedule' });
  assert.equal(record.status, 'skipped');
  assert.equal(record.checked, 0);
  const state = store.readState();
  assert.equal(state.lastReleaseWeek, scheduleModule.isoWeekKey(new Date(record.finishedAt), 'Asia/Shanghai'));
  assert.equal(store.readHistory().length, 0);
});

test('runReleases：核心失败 → failed 记录，不锁本周（下一 tick 还能重试）', async () => {
  const { runner, store } = makeRunner({
    scenario: { FAKE_REQUIRE_STAGES: '1', FAKE_EXIT: '1', FAKE_STDERR: 'error: INTERNAL: boom' },
  });
  const record = await runner.runReleases({ trigger: 'schedule' });
  assert.equal(record.status, 'failed');
  assert.equal(record.errorCode, 'INTERNAL');
  assert.match(record.errorMessage, /boom/);
  const state = store.readState();
  assert.equal(state.lastReleaseAt, record.finishedAt);
  assert.equal(state.lastReleaseWeek, undefined);
  assert.equal(store.readReleaseRuns()[0].status, 'failed');
});

test('runReleases：与榜单运行共享单跑锁（并发直接拒绝）', async () => {
  const { runner } = makeRunner({ scenario: { FAKE_SLEEP: '1200' } });
  const first = runner.run({ trigger: 'manual' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await assert.rejects(async () => {
    await runner.runReleases({ trigger: 'manual' });
  }, /已有一次运行在进行中/);
  runner.cancel();
  await first;
});

test('runReleases：取消 → cancelled 记录，不写任何成功状态', async () => {
  const { runner, store } = makeRunner({ scenario: { FAKE_SLEEP: '4000', FAKE_REQUIRE_STAGES: '1' } });
  const pending = runner.runReleases({ trigger: 'manual' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(runner.running !== undefined, true);
  assert.equal(runner.cancel(), true);
  const record = await pending;
  assert.equal(record.status, 'cancelled');
  assert.equal(record.errorCode, 'CORE_CANCELLED');
  const state = store.readState();
  assert.equal(state.lastReleaseWeek, undefined);
  assert.equal(store.readHistory().length, 0);
});

test('runReleases：订阅列表读不到也照跑（repoCount 按 0），auto 并发回落 4', async () => {
  // 模型/仓库配置合法，但核心在 subscribe list 上失败：不应让发版运行整体失败。
  const { runner, store } = makeRunner({ scenario: { FAKE_REQUIRE_STAGES: '1', FAKE_SUBSCRIBE_FAIL: '1', FAKE_RELEASES: '1,1,0' } });
  const record = await runner.runReleases({ trigger: 'manual' });
  assert.equal(record.status, 'ok');
  assert.equal(record.coreVersion, '0.3.0-fake');
  assert.equal(store.readHistory().length, 0);
});

// ——— 单仓发版分析（run --stages releases --repo owner/repo） ———

test('runReleases(repo)：核心支持 --repo 时透传，且单仓不推进 lastReleaseWeek', async () => {
  const { runner, store } = makeRunner({
    scenario: {
      FAKE_REQUIRE_STAGES: '1',
      FAKE_REQUIRE_REPO: 'vercel/next.js',
      FAKE_VERSION: '0.8.0', // >= REPO_MIN_CORE_VERSION，才会真正传 --repo
      FAKE_RELEASES: '1,1,0',
    },
  });
  const record = await runner.runReleases({ trigger: 'manual', repo: 'vercel/next.js' });
  assert.equal(record.status, 'ok');
  assert.equal(record.scopeRepo, 'vercel/next.js');
  const state = store.readState();
  // 关键回归：单仓手动触发不能锁本周（否则周调度会跳过本周真正检查）。
  assert.equal(state.lastReleaseWeek, undefined);
  // 但仍更新 lastReleaseAt 并记一条 releaseRun。
  assert.equal(state.lastReleaseAt, record.finishedAt);
  assert.equal(store.readReleaseRuns().length, 1);
  assert.equal(store.readReleaseRuns()[0].scopeRepo, 'vercel/next.js');
  assert.equal(store.readHistory().length, 0);
});

test('runReleases(repo)：全量运行仍推进 lastReleaseWeek（不回归）', async () => {
  const { runner, store } = makeRunner({ scenario: { FAKE_REQUIRE_STAGES: '1', FAKE_RELEASES: '1,1,0' } });
  const record = await runner.runReleases({ trigger: 'manual' });
  assert.equal(record.status, 'ok');
  assert.equal(record.scopeRepo, undefined);
  const state = store.readState();
  assert.equal(state.lastReleaseWeek, scheduleModule.isoWeekKey(new Date(record.finishedAt), 'Asia/Shanghai'));
});
