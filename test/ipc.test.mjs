import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { ipc } from '../lib/internal.js';

const expectCode = (fn, code) => {
  try {
    fn();
  } catch (error) {
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected ${code}`);
};

const timing = { coreVersion: '0.3.0', startedAt: '2026-10-30T00:00:00.000Z', finishedAt: '2026-10-30T00:00:05.000Z', durationMs: 5000, dryRun: false };
const HASH = `sha256:${'a'.repeat(64)}`;

function runResult(patch = {}) {
  return {
    ipcSchema: 3,
    ok: true,
    command: 'run',
    startedAt: '2026-10-30T00:00:00Z',
    finishedAt: '2026-10-30T00:00:01Z',
    skipped: false,
    files: [{ path: 'a.md', bytes: 3, sha256: `sha256:${'c'.repeat(64)}` }],
    branch: 'trending/2026-10-30',
    commit: 'deadbeef',
    prUrl: 'https://example.invalid/1',
    contentHash: HASH,
    warnings: [],
    ...patch,
  };
}

test('parseRunResult 接受契约 RunResult v2 并映射可选字段', () => {
  const outcome = ipc.parseRunResult(JSON.stringify(runResult()), timing);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.skipped, false);
  assert.equal(outcome.contentHash, HASH);
  assert.equal(outcome.branch, 'trending/2026-10-30');
  assert.equal(outcome.commit, 'deadbeef');
  assert.equal(outcome.prUrl, 'https://example.invalid/1');
  assert.equal(outcome.files.length, 1);
});

const DIGEST_TEXT = '---\ndate: 2026-11-04\n---\n\n# 2026-11-04 趋势摘要\n\n## all\n';

function sha256Of(text) {
  return `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`;
}

/** 自洽的 digest + files：text/bytes/sha256 与 path 全部对得上。 */
function digestResult(digestPatch = {}, filesPatch) {
  const bytes = Buffer.byteLength(DIGEST_TEXT);
  const digest = { path: 'a.md', bytes, sha256: sha256Of(DIGEST_TEXT), text: DIGEST_TEXT, ...digestPatch };
  const files = filesPatch ?? [{ path: digest.path, bytes: digest.bytes, sha256: digest.sha256 }];
  return runResult({ files, digest });
}

test('parseRunResult 映射 ipc v3 的 digest（text/bytes/sha256/path）', () => {
  const outcome = ipc.parseRunResult(JSON.stringify(digestResult()), timing);
  assert.equal(outcome.digest.path, 'a.md');
  assert.equal(outcome.digest.bytes, Buffer.byteLength(DIGEST_TEXT));
  assert.equal(outcome.digest.sha256, sha256Of(DIGEST_TEXT));
  assert.equal(outcome.digest.text, DIGEST_TEXT);
  // 没有 digest 时缺省，不是空对象
  const legacy = ipc.parseRunResult(JSON.stringify(runResult()), timing);
  assert.equal(legacy.digest, undefined);
});

test('digest 与 text / files 自相矛盾 → IPC_INVALID', () => {
  // bytes 与 text 实际字节数不符
  expectCode(() => ipc.parseRunResult(JSON.stringify(digestResult({ bytes: 1 })), timing), 'IPC_INVALID');
  // sha256 与 text 不符
  expectCode(() => ipc.parseRunResult(JSON.stringify(digestResult({ sha256: `sha256:${'d'.repeat(64)}` })), timing), 'IPC_INVALID');
  // path 不在 files 里（files 仍只列 a.md）
  expectCode(
    () => ipc.parseRunResult(
      JSON.stringify(digestResult({ path: 'elsewhere.md' }, [{ path: 'a.md', bytes: Buffer.byteLength(DIGEST_TEXT), sha256: sha256Of(DIGEST_TEXT) }])),
      timing,
    ),
    'IPC_INVALID',
  );
  // digest 与 files 里同路径条目的 sha/bytes 不一致
  expectCode(
    () => ipc.parseRunResult(
      JSON.stringify(digestResult({}, [{ path: 'a.md', bytes: Buffer.byteLength(DIGEST_TEXT), sha256: `sha256:${'d'.repeat(64)}` }])),
      timing,
    ),
    'IPC_INVALID',
  );
});

test('parseRunResult 映射失败结果与 warnings', () => {
  const outcome = ipc.parseRunResult(
    JSON.stringify(runResult({ ok: false, error: { code: 'REPO_DIRTY', message: 'dirty', retriable: false }, warnings: ['w'] })),
    timing,
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'REPO_DIRTY');
  assert.deepEqual(outcome.warnings, ['w']);
});

test('非契约形状一律 IPC_INVALID：不猜字段、不接受旧 runOutput / 旧 ipcSchema', () => {
  // 旧核心的 runOutput（只有 files/digest）
  expectCode(
    () => ipc.parseRunResult(JSON.stringify({ files: [{ path: 'a.md', bytes: 3, sha256: 'x' }], digest: { contentHash: 'h1' } }), timing),
    'IPC_INVALID',
  );
  // ipcSchema=1 的旧信封
  expectCode(() => ipc.parseRunResult(JSON.stringify(runResult({ ipcSchema: 1 })), timing), 'IPC_INVALID');
  // contentHash 不符合 ^sha256:[0-9a-f]{64}$
  expectCode(() => ipc.parseRunResult(JSON.stringify(runResult({ contentHash: 'hash-with-key' })), timing), 'IPC_INVALID');
  expectCode(() => ipc.parseRunResult(JSON.stringify({ hello: 1 }), timing), 'IPC_INVALID');
  expectCode(() => ipc.parseRunResult('', timing), 'IPC_INVALID');
  expectCode(() => ipc.parseRunResult('{"files":[]}\n{"files":[]}', timing), 'IPC_INVALID');
});

test('parseVersionInfo 拒绝缺字段的输出', () => {
  expectCode(() => ipc.parseVersionInfo('{"version":"1"}'), 'IPC_INVALID');
  const info = ipc.parseVersionInfo(JSON.stringify({ version: '0.3.0', ipcSchema: 3, digestSchema: 2, contractVersion: '0.2.0' }));
  assert.equal(info.version, '0.3.0');
  assert.equal(info.contractVersion, '0.2.0');
});

test('parseRunResult 透传 skipReason（契约允许额外字段）', () => {
  const outcome = ipc.parseRunResult(JSON.stringify(runResult({ skipped: true, skipReason: 'merged' })), timing);
  assert.equal(outcome.skipped, true);
  assert.equal(outcome.skipReason, 'merged');
  // 非字符串/缺失时保持 undefined，不把脏值带进界面
  const dirty = ipc.parseRunResult(JSON.stringify(runResult({ skipReason: 42 })), timing);
  assert.equal(dirty.skipReason, undefined);
});

test('parseRunResult 容忍核心 skipped 时的 files:null（归一成 []，不判 IPC_INVALID）', () => {
  // 回归：--stages releases 且订阅为空/内容无变化时，核心 v0.8.0 会吐 files:null +
  // skipped:true（契约 files 要求 array，直接校验会误判 IPC_INVALID，前端表现为一闪而过报错）。
  const outcome = ipc.parseRunResult(
    JSON.stringify(runResult({ skipped: true, skipReason: 'unchanged', files: null })),
    timing,
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.skipped, true);
  assert.equal(outcome.skipReason, 'unchanged');
  assert.deepEqual(outcome.files, []);
  // files 缺失同样归一成 []
  const missing = ipc.parseRunResult(JSON.stringify(runResult({ files: undefined })), timing);
  assert.deepEqual(missing.files, []);
});


const USAGE = {
  promptTokens: 100,
  completionTokens: 40,
  totalTokens: 140,
  cachedTokens: 0,
  usageKnown: true,
  calls: 1,
  retries: 0,
  batches: 1,
  cacheHits: 0,
};
const RELEASES = {
  enabled: true,
  repos: 3,
  checked: 3,
  changed: 2,
  newReleases: 2,
  summarized: 2,
  durationMs: 900,
  usage: { ...USAGE, totalTokens: 60 },
};

test('parseRunResult 映射 usage / releases（契约强类型）', () => {
  const outcome = ipc.parseRunResult(JSON.stringify(runResult({ usage: USAGE, releases: RELEASES })), timing);
  assert.equal(outcome.usage?.totalTokens, 140);
  assert.equal(outcome.releases?.enabled, true);
  assert.equal(outcome.releases?.repos, 3);
  assert.equal(outcome.releases?.usage.totalTokens, 60);
});

test('parseRunResult 旧核心无 usage/releases 时两者缺省', () => {
  const outcome = ipc.parseRunResult(JSON.stringify(runResult()), timing);
  assert.equal(outcome.usage, undefined);
  assert.equal(outcome.releases, undefined);
});

test('parseRunResult 畸形 usage（缺必需字段）被契约校验拦下 → IPC_INVALID', () => {
  expectCode(
    () => ipc.parseRunResult(JSON.stringify(runResult({ usage: { totalTokens: 5 } })), timing),
    'IPC_INVALID',
  );
});

test('parseSubscribeResult：list 从信封前逐行取仓库，信封只带 ok', () => {
  const out = 'vercel/next.js\noven-sh/bun\n' + JSON.stringify({ ipcSchema: 3, ok: true, command: 'subscribe', startedAt: 'x', finishedAt: 'y', skipped: false, files: [] });
  const result = ipc.parseSubscribeResult(out);
  assert.equal(result.ok, true);
  assert.deepEqual(result.repos, ['vercel/next.js', 'oven-sh/bun']);
  // 旧核心没有新 payload：items/doc 必须缺省，不能凭空造空对象。
  assert.equal(result.items, undefined);
  assert.equal(result.doc, undefined);
});

test('parseSubscribeResult：失败信封带 error，repos 为空', () => {
  const out = JSON.stringify({ ipcSchema: 3, ok: false, command: 'subscribe', startedAt: 'x', finishedAt: 'y', skipped: false, files: [], error: { code: 'CONFIG_INVALID', message: 'bad', retriable: false } });
  const result = ipc.parseSubscribeResult(out);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONFIG_INVALID');
  assert.deepEqual(result.repos, []);
});

test('parseSubscribeResult：空输出 / 非信封结尾 → IPC_INVALID', () => {
  expectCode(() => ipc.parseSubscribeResult(''), 'IPC_INVALID');
  expectCode(() => ipc.parseSubscribeResult('not json'), 'IPC_INVALID');
  expectCode(() => ipc.parseSubscribeResult('{"hello":1}'), 'IPC_INVALID');
});

// ——— 契约 0.4.0：payload 进信封（subscriptions / subscriptionDoc） ———

const SUB_ENVELOPE = { ipcSchema: 3, ok: true, command: 'subscribe', startedAt: 'x', finishedAt: 'y', skipped: false, files: [] };

test('parseSubscribeResult：信封里的 subscriptions（repos + items）优先于逐行兜底', () => {
  const out = JSON.stringify({
    ...SUB_ENVELOPE,
    subscriptions: {
      repos: ['vercel/next.js', 'oven-sh/bun'],
      items: [
        { fullName: 'vercel/next.js', status: 'ok', latestTag: 'v15.1.0', url: 'https://github.com/vercel/next.js' },
        { fullName: 'oven-sh/bun', status: 'no_change' },
        // 畸形行丢掉，不让一行坏数据毁掉整张表
        { fullName: 'bad row', status: 'bogus' },
        { status: 'ok' },
      ],
    },
  });
  const result = ipc.parseSubscribeResult(out);
  assert.equal(result.ok, true);
  assert.deepEqual(result.repos, ['vercel/next.js', 'oven-sh/bun']);
  assert.deepEqual(
    result.items.map((item) => [item.fullName, item.status]),
    [
      ['vercel/next.js', 'ok'],
      ['oven-sh/bun', 'no_change'],
    ],
  );
  assert.equal(result.items[0].latestTag, 'v15.1.0');
  assert.equal(result.doc, undefined);
});

test('parseSubscribeResult：subscriptions.repos 不是字符串数组 → IPC_INVALID（不静默当空表）', () => {
  expectCode(() => ipc.parseSubscribeResult(JSON.stringify({ ...SUB_ENVELOPE, subscriptions: { repos: 'a/b' } })), 'IPC_INVALID');
  expectCode(() => ipc.parseSubscribeResult(JSON.stringify({ ...SUB_ENVELOPE, subscriptions: { repos: [1] } })), 'IPC_INVALID');
  expectCode(() => ipc.parseSubscribeResult(JSON.stringify({ ...SUB_ENVELOPE, subscriptions: 42 })), 'IPC_INVALID');
});

test('parseSubscribeResult：subscriptionDoc 合法时透出，畸形时 IPC_INVALID', () => {
  const doc = {
    fullName: 'vercel/next.js',
    volume: 2,
    volumes: [{ index: 1, file: 'vercel/next.js.md', from: '2026-W40', to: '2026-W43', lines: 120 }],
    updatedAt: '2026-11-01T00:00:00Z',
    markdown: '# 发版记录\n',
  };
  const ok = ipc.parseSubscribeResult(JSON.stringify({ ...SUB_ENVELOPE, subscriptionDoc: doc }));
  assert.deepEqual(ok.doc, doc);
  assert.deepEqual(ok.repos, []);
  for (const bad of [
    { fullName: 'a/b', volume: 0, markdown: '' },
    { fullName: 'a/b', volume: 1.5, markdown: '' },
    { fullName: 'a/b', volume: 1 },
    { volume: 1, markdown: 'x' },
    'nope',
  ]) {
    expectCode(() => ipc.parseSubscribeResult(JSON.stringify({ ...SUB_ENVELOPE, subscriptionDoc: bad })), 'IPC_INVALID');
  }
  assert.equal(ipc.isSubscriptionDoc(doc), true);
  assert.equal(ipc.isSubscriptionDoc({ ...doc, volume: 0 }), false);
  assert.equal(ipc.isSubscriptionDoc({ ...doc, markdown: undefined }), false);
});
