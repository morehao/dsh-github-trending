import { test } from 'node:test';
import assert from 'node:assert/strict';
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
    ipcSchema: 2,
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
  const info = ipc.parseVersionInfo(JSON.stringify({ version: '0.3.0', ipcSchema: 2, digestSchema: 2, contractVersion: '0.2.0' }));
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
