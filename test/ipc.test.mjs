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

const timing = { coreVersion: '0.1.0', startedAt: '2026-10-30T00:00:00.000Z', finishedAt: '2026-10-30T00:00:05.000Z', durationMs: 5000, dryRun: false };

test('parseRunResult 接受核心 run --json 形状', () => {
  const outcome = ipc.parseRunResult(
    JSON.stringify({ files: [{ path: 'a.md', bytes: 3, sha256: 'sha256:x' }], skipped: false, branch: 'trending/2026-10-30', prUrl: 'https://example.invalid/1', digest: { contentHash: 'h1' } }),
    timing,
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.skipped, false);
  assert.equal(outcome.contentHash, 'h1');
  assert.equal(outcome.branch, 'trending/2026-10-30');
  assert.equal(outcome.files.length, 1);
});

test('parseRunResult 接受契约 RunResult 形状', () => {
  const outcome = ipc.parseRunResult(
    JSON.stringify({
      ipcSchema: 1,
      ok: false,
      command: 'run',
      startedAt: '2026-10-30T00:00:00Z',
      finishedAt: '2026-10-30T00:00:01Z',
      skipped: false,
      files: [],
      error: { code: 'REPO_DIRTY', message: 'dirty', retriable: false },
      warnings: ['w'],
    }),
    timing,
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'REPO_DIRTY');
  assert.deepEqual(outcome.warnings, ['w']);
});

test('两种形状都不像时抛 IPC_INVALID，不猜字段', () => {
  expectCode(() => ipc.parseRunResult(JSON.stringify({ hello: 1 }), timing), 'IPC_INVALID');
  expectCode(() => ipc.parseRunResult('', timing), 'IPC_INVALID');
  expectCode(() => ipc.parseRunResult('{"files":[]}\n{"files":[]}', timing), 'IPC_INVALID');
});

test('parseVersionInfo 拒绝缺字段的输出', () => {
  expectCode(() => ipc.parseVersionInfo('{"version":"1"}'), 'IPC_INVALID');
  const info = ipc.parseVersionInfo(JSON.stringify({ version: '0.1.0', ipcSchema: 1, digestSchema: 1 }));
  assert.equal(info.version, '0.1.0');
});
