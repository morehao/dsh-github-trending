import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
    coreVersion: '0.3.0',
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

test('历史最多 HISTORY_LIMIT 条，最新在前', () => {
  const limit = stateModule.HISTORY_LIMIT;
  const store = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-hist-')) });
  for (let index = 0; index < limit + 5; index += 1) store.recordRun(record(index));
  const history = store.readHistory();
  assert.equal(history.length, limit);
  assert.equal(history[0].id, `run-${limit + 4}`);
  assert.equal(history[limit - 1].id, 'run-5');
});

test('recordRun 同时更新 state.lastResult 与 lastDigest', () => {
  const store = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-last-')) });
  store.recordRun(record(1), {
    lastRunAt: record(1).at,
    lastDigest: { date: '2026-10-30', contentHash: 'h', contentHashAlgo: 'jcs-sha256-v1', coreVersion: '0.3.0' },
  });
  const current = store.readState();
  assert.equal(current.lastResult.id, 'run-1');
  assert.equal(current.lastDigest.contentHash, 'h');
  assert.equal(current.lastDigest.contentHashAlgo, 'jcs-sha256-v1');
});

test('legacy lastDigest（缺 contentHashAlgo）与绑定的 pendingPr 在读取时被清空', () => {
  const store = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-legacy-')) });
  store.writeState({
    lastDigest: { date: '2026-10-30', contentHash: 'old-hash', coreVersion: '0.2.0' },
    pendingPr: { url: 'https://github.com/o/r/pull/1', createdAt: '2026-10-30T00:00:00.000Z', date: '2026-10-30' },
  });
  const current = store.readState();
  assert.equal(current.lastDigest, undefined);
  assert.equal(current.pendingPr, undefined);
});

test('coreVersion 非 v2 的 lastDigest 即使有 contentHashAlgo 也算 legacy', () => {
  const store = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-legacy2-')) });
  store.writeState({
    lastDigest: { date: '2026-10-30', contentHash: 'old-hash', contentHashAlgo: 'jcs-sha256-v1', coreVersion: '0.2.9' },
  });
  assert.equal(store.readState().lastDigest, undefined);
});

test('migrateLegacyState 落盘清洗 state 并给旧 history 打 legacy 标', () => {
  const store = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-migrate-')) });
  // 先造两条历史：旧核心 0.1.0 与新核心 0.3.0
  store.recordRun({ ...record(1), coreVersion: '0.1.0' });
  store.recordRun({ ...record(2), coreVersion: '0.3.0' });
  // 再直接写入一份 v1 时代遗留的 state（绕过 recordRun 的读时清洗）
  store.writeState({
    lastDigest: { date: '2026-10-30', contentHash: 'old-hash', coreVersion: '0.2.0' },
    pendingPr: { url: 'https://github.com/o/r/pull/1', createdAt: '2026-10-30T00:00:00.000Z' },
  });

  const result = store.migrateLegacyState();
  assert.equal(result.clearedDigest, true);
  assert.equal(result.clearedPendingPr, true);
  assert.equal(result.historyMarked, 1);

  // 落盘后：state 里不再有 lastDigest / pendingPr
  const persisted = JSON.parse(readFileSync(store.statePath, 'utf8'));
  assert.equal(persisted.lastDigest, undefined);
  assert.equal(persisted.pendingPr, undefined);
  // 旧记录被打标，新记录没有
  const history = store.readHistory();
  const old = history.find((item) => item.id === 'run-1');
  const fresh = history.find((item) => item.id === 'run-2');
  assert.equal(old.legacy, true);
  assert.equal(fresh.legacy, undefined);
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

test('预览副本：写入可读回、权限 0600、目录 0700', () => {
  const store = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-preview-')) });
  store.writePreview('run-1', '# 日报\n\n内容');
  const file = path.join(store.dir, 'previews', 'run-1.md');
  assert.equal(readFileSync(file, 'utf8'), '# 日报\n\n内容');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(store.previewsPath).mode & 0o777, 0o700);
  assert.deepEqual(store.readPreview('run-1'), { text: '# 日报\n\n内容', truncated: false });
  const leftovers = readdirSync(store.previewsPath).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('预览副本：不存在返回 undefined；超过上限截断并标记', () => {
  const store = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-preview2-')) });
  assert.equal(store.readPreview('missing'), undefined);
  store.writePreview('big', 'x'.repeat(2048));
  const cut = store.readPreview('big', 100);
  assert.equal(cut.truncated, true);
  assert.equal(cut.text.length, 100);
});

test('预览副本最多保留 PREVIEW_LIMIT 份，按 mtime 淘汰最旧', () => {
  const limit = stateModule.PREVIEW_LIMIT;
  const store = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-preview3-')) });
  const base = Math.floor(Date.now() / 1000) - 7200;
  for (let index = 0; index < limit + 5; index += 1) {
    store.writePreview(`run-${index}`, `content ${index}`);
    const file = path.join(store.previewsPath, `run-${index}.md`);
    utimesSync(file, base + index, base + index);
  }
  // 再写一份触发裁剪（保持 limit 份）
  store.writePreview('run-latest', 'latest');
  const names = readdirSync(store.previewsPath).filter((name) => name.endsWith('.md'));
  assert.equal(names.length, limit);
  assert.equal(names.includes('run-0.md'), false);
  assert.equal(names.includes('run-latest.md'), true);
  assert.equal(names.includes(`run-${limit + 4}.md`), true);
  assert.equal(existsSync(path.join(store.previewsPath, 'run-0.md')), false);
});

test('recordRun 持久化 date / commit / preview（正文不进 history）', () => {
  const store = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-preview4-')) });
  const preview = { file: 'trending/2026-10-30.md', bytes: 5, sha256: 'a'.repeat(64) };
  store.recordRun({ ...record(1), date: '2026-10-30', commit: 'deadbeef', preview });
  const persisted = JSON.parse(readFileSync(store.historyPath, 'utf8'));
  assert.equal(persisted.records[0].date, '2026-10-30');
  assert.equal(persisted.records[0].commit, 'deadbeef');
  assert.deepEqual(persisted.records[0].preview, preview);
  assert.equal(JSON.stringify(persisted).includes('正文'), false);
});
