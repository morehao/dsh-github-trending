import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner as runnerModule, state as stateModule } from '../lib/internal.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CORE = path.join(here, 'fixtures', 'fake-core.mjs');
const ENV_KEY = 'DSHGT_TEST_MODEL_KEY';
const HASH_WITH_KEY = `sha256:${'a'.repeat(64)}`;

function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), 'dshgt-repo-'));
  mkdirSync(path.join(repo, '.git'));
  return repo;
}

function fakeCore(scenario = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dshgt-core-'));
  const file = path.join(dir, 'core.mjs');
  const assignments = Object.entries(scenario)
    .map(([key, value]) => `process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)};`)
    .join('\n');
  writeFileSync(file, `#!/usr/bin/env node\n${assignments}\nawait import(${JSON.stringify(`file://${FAKE_CORE}`)});\n`);
  chmodSync(file, 0o755);
  return file;
}

function makeRunner(overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dshgt-run-'));
  const store = new stateModule.Store({ dir });
  const repo = overrides.repo ?? makeRepo();
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
  return { runner, store, repo, env, dir };
}

// force 只有在核心 >= 0.7.1 时才真正传给 core；默认 fake 版本远低于阈值，
// 这里统一用 0.7.1 以上来测「已支持」路径。
const FORCE_CAPABLE = { FAKE_VERSION: '0.7.1' };

test('force 透传：--force 抵达核心（warnings 回显 force=1）', async () => {
  const { runner } = makeRunner({ scenario: { ...FORCE_CAPABLE, FAKE_FORCE_ECHO: '1' } });
  const summary = await runner.run({ trigger: 'tool', force: true });
  assert.equal(summary.ok, true);
  assert.equal(summary.forced, true);
  assert.ok(summary.warnings.includes('force=1'), `warnings=${JSON.stringify(summary.warnings)}`);
});

test('非 force 不透传：warnings 回显 force=0，summary 无 forced', async () => {
  const { runner } = makeRunner({ scenario: { ...FORCE_CAPABLE, FAKE_FORCE_ECHO: '1' } });
  const summary = await runner.run({ trigger: 'tool' });
  assert.equal(summary.ok, true);
  assert.equal(summary.forced, undefined);
  assert.ok(summary.warnings.includes('force=0'), `warnings=${JSON.stringify(summary.warnings)}`);
});

test('force + unchanged：刷新 lastDigest、记录 forced、仍生成预览副本', async () => {
  const repo = makeRepo();
  // 模拟 force 重跑但内容未变：skipped=unchanged，但仍给出 artifact + contentHash。
  const artifacts = JSON.stringify([{ path: 'trending/2026-10-30/all.md', content: '# digest\n' }]);
  const { runner, store } = makeRunner({
    repo,
    scenario: {
      ...FORCE_CAPABLE,
      FAKE_SKIPPED: '1',
      FAKE_SKIP_REASON: 'unchanged',
      FAKE_SKIPPED_WITH_ARTIFACTS: '1',
      FAKE_ARTIFACTS: artifacts,
    },
  });
  const summary = await runner.run({ trigger: 'tool', force: true });
  assert.equal(summary.ok, true);
  assert.equal(summary.skipped, true);
  assert.equal(summary.skipReason, 'unchanged');
  assert.equal(summary.forced, true);

  // force + unchanged 也要有预览副本（从仓库现有文件生成）。
  assert.ok(summary.preview !== undefined, 'force+unchanged 应生成预览');
  const state = store.readState();
  assert.ok(state.lastDigest !== undefined, 'force+unchanged 应刷新 lastDigest');
  assert.equal(state.lastDigest.contentHash, HASH_WITH_KEY);
  const history = store.readHistory();
  assert.equal(history[0].forced, true);
});

test('非 force + unchanged：不刷新 lastDigest、无预览、无 forced', async () => {
  const { runner, store } = makeRunner({ scenario: { ...FORCE_CAPABLE, FAKE_SKIPPED: '1', FAKE_SKIP_REASON: 'unchanged' } });
  const summary = await runner.run({ trigger: 'schedule' });
  assert.equal(summary.ok, true);
  assert.equal(summary.skipped, true);
  assert.equal(summary.forced, undefined);
  assert.equal(summary.preview, undefined);
  assert.equal(store.readState().lastDigest, undefined);
  assert.equal(store.readHistory()[0].forced, undefined);
});

test('版本闸门：核心 < 0.7.1 时 force 被降级为普通重跑（不传 --force）', async () => {
  // 旧核心（0.7.0）仍会成功运行，但不支持 --force：请求 force 也不应传参、不应标 forced。
  const { runner } = makeRunner({ scenario: { FAKE_VERSION: '0.7.0', FAKE_FORCE_ECHO: '1' } });
  const summary = await runner.run({ trigger: 'tool', force: true });
  assert.equal(summary.ok, true);
  assert.equal(summary.forced, undefined);
  assert.ok(summary.warnings.includes('force=0'), `应降级为不传 --force：${JSON.stringify(summary.warnings)}`);
});

test('force + 内容有变：追加提交、刷新 lastDigest、forced 标记', async () => {
  const { runner, store } = makeRunner({ scenario: { ...FORCE_CAPABLE } });
  const summary = await runner.run({ trigger: 'tool', force: true });
  assert.equal(summary.ok, true);
  assert.equal(summary.skipped, false);
  assert.equal(summary.forced, true);
  assert.equal(summary.commit, 'deadbeef');
  const state = store.readState();
  assert.equal(state.lastDigest.contentHash, HASH_WITH_KEY);
});
