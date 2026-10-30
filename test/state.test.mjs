import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { state as stateModule } from '../lib/internal.js';

const dir = mkdtempSync(path.join(tmpdir(), 'dshgt-state-'));

function record(index) {
  return {
    id: `run-${index}`,
    at: new Date(2026, 9, 30, 8, 30, index).toISOString(),
    kind: 'run',
    ok: true,
    skipped: false,
    durationMs: 1000 + index,
    files: 1,
    coreVersion: '0.1.0',
    model: { provider: 'deepseek', model: 'deepseek-chat' },
    languages: ['all'],
    warnings: [],
  };
}

test('设置写入后可读回，且文件权限为 0600', () => {
  const store = new stateModule.Store({ dir });
  store.writeSettings({ model: { provider: 'deepseek' }, repo: { path: '/tmp/x' } });
  const settings = store.readSettings();
  assert.equal(settings.repo.path, '/tmp/x');
  assert.equal(settings.model.provider, 'deepseek');
});

test('历史最多 30 条，最新在前', () => {
  const store = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-hist-')) });
  for (let index = 0; index < 35; index += 1) store.recordRun(record(index));
  const history = store.readHistory();
  assert.equal(history.length, 30);
  assert.equal(history[0].id, 'run-34');
  assert.equal(history[29].id, 'run-5');
});

test('recordRun 同时更新 state.lastResult 与 lastDigest', () => {
  const store = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-last-')) });
  store.recordRun(record(1), { lastRunAt: record(1).at, lastDigest: { date: '2026-10-30', contentHash: 'h', coreVersion: '0.1.0' } });
  const current = store.readState();
  assert.equal(current.lastResult.id, 'run-1');
  assert.equal(current.lastDigest.contentHash, 'h');
});

test('坏 JSON 不抛异常，按空状态处理', () => {
  const store = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-bad-')) });
  store.writeSettings({});
  writeFileSync(store.settingsPath, '{ not json');
  assert.equal(store.readSettings().repo.basePath, undefined);
  assert.equal(store.readSettings().repo.baseBranch, 'main');
});

test('日志写入可读回，且目录里不残留临时文件', () => {
  const store = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-log-')) });
  const file = store.newLogPath('abc');
  store.appendLog(file, 'line one');
  assert.match(store.readLog(file), /line one/);
  const leftovers = readdirSync(store.dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});
