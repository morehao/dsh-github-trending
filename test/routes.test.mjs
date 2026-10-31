import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routes, runner as runnerModule, schedule as scheduleModule, state as stateModule } from '../lib/internal.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fixtures', 'fake-core.mjs');

function scenarioCore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dshgt-routes-core-'));
  const file = path.join(dir, 'core.mjs');
  writeFileSync(file, `#!/usr/bin/env node\nawait import(${JSON.stringify(`file://${FAKE}`)});\n`);
  chmodSync(file, 0o755);
  return file;
}

const repo = mkdtempSync(path.join(tmpdir(), 'dshgt-routes-repo-'));
mkdirSync(path.join(repo, '.git'));
const store = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-routes-')) });
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TRENDING_DIGEST_CORE: scenarioCore(), DSHGT_ROUTES_KEY: 'sk-routes' };
store.writeSettings({
  model: { provider: 'deepseek', model: 'deepseek-chat', apiKeyRef: 'DSHGT_ROUTES_KEY' },
  repo: { path: repo },
  github: { authMode: 'pat', tokenRef: 'GITHUB_TOKEN' },
});

const runner = new runnerModule.Runner({ store, get: () => undefined, env });
const scheduler = new scheduleModule.Scheduler({ store, isRunning: () => false, getTimer: () => undefined, run: async () => undefined });
const server = http.createServer(
  routes.createRoutes({
    store,
    runner,
    scheduler,
    get: () => undefined,
    env,
    version: '0.1.0-test',
    repository: 'https://github.com/morehao/dsh-github-trending',
  }),
);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}${routes.ROUTE_PREFIX}`;
after(() => server.close());

const HEADER = { 'x-dsh-github-trending': '1', 'content-type': 'application/json' };

test('缺少自定义头一律 403（CSRF 基线）', async () => {
  const response = await fetch(`${base}/state`);
  assert.equal(response.status, 403);
});

test('/state 返回设置、核心状态、调度与历史', async () => {
  const response = await fetch(`${base}/state`, { headers: HEADER });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.settings.repo.path, repo);
  assert.equal(payload.core.state, 'ready');
  assert.equal(payload.core.version, '0.3.0-fake');
  assert.equal(payload.schedule.enabled, true);
  assert.equal(payload.status.history.length, 0);
  assert.equal(payload.github.configured, false);
  assert.equal(payload.plugin.repository, 'https://github.com/morehao/dsh-github-trending');
});

test('/config 校验并保存；非法时 400 且不落盘', async () => {
  const bad = await fetch(`${base}/config`, {
    method: 'POST',
    headers: HEADER,
    body: JSON.stringify({ settings: { model: { provider: 'nope', model: '' }, repo: { path: '/tmp' } } }),
  });
  const badPayload = await bad.json();
  assert.equal(badPayload.ok, true); // 路由成功返回，但是 saved:false
  assert.equal(badPayload.saved, false);
  assert.ok(badPayload.problems.length > 0);

  const good = await fetch(`${base}/config`, {
    method: 'POST',
    headers: HEADER,
    body: JSON.stringify({ settings: { model: { provider: 'deepseek', model: 'deepseek-chat', apiKeyRef: 'DSHGT_ROUTES_KEY' }, repo: { path: repo }, trending: { topN: 12 } } }),
  });
  const goodPayload = await good.json();
  assert.equal(goodPayload.saved, true);
  assert.equal(store.readSettings().trending.topN, 12);
});

test('POST /run 省略 period 默认跑日/周/月三榜；GET /log 能取到日志', async () => {
  const response = await fetch(`${base}/run`, { method: 'POST', headers: HEADER, body: JSON.stringify({ dryRun: true }) });
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(Array.isArray(payload.summaries), true);
  assert.equal(payload.summaries.length, 3);
  assert.deepEqual(payload.summaries.map((s) => s.period), ['daily', 'weekly', 'monthly']);
  assert.equal(payload.summary.ok, true);
  assert.equal(payload.summary.dryRun, true);
  assert.equal(store.readHistory().length, 3);

  const log = await fetch(`${base}/log?id=${payload.summary.id}`, { headers: HEADER });
  const logPayload = await log.json();
  assert.equal(logPayload.id, payload.summary.id);
});

test('POST /run 显式 period 只跑单个周期', async () => {
  const before = store.readHistory().length;
  const response = await fetch(`${base}/run`, { method: 'POST', headers: HEADER, body: JSON.stringify({ dryRun: true, period: 'weekly' }) });
  const payload = await response.json();
  assert.equal(payload.summary.period, 'weekly');
  assert.equal(store.readHistory().length, before + 1);
});

test('GET /log 拒绝非法 id（避免路径穿越）', async () => {
  const response = await fetch(`${base}/log?id=../../etc/passwd`, { headers: HEADER });
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'CONFIG_INVALID');
});

test('GET /repo/branch 读取默认分支（读不到时安全返回 none）', async () => {
  const response = await fetch(`${base}/repo/branch?path=${encodeURIComponent(repo)}`, { headers: HEADER });
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.repo.source, 'none');
  assert.equal(typeof payload.repo.message, 'string');
});

test('POST /github/test 没配 token 时返回可操作的失败，不抛错', async () => {
  const response = await fetch(`${base}/github/test`, {
    method: 'POST',
    headers: HEADER,
    body: JSON.stringify({ settings: { github: { authMode: 'pat', tokenRef: 'GITHUB_TOKEN' } } }),
  });
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.github.ok, false);
  assert.equal(payload.github.code, 'GITHUB_AUTH');
});

test('/quickfill 在没有 llm 服务时返回空列表而不是报错', async () => {
  const response = await fetch(`${base}/quickfill`, { headers: HEADER });
  const payload = await response.json();
  assert.deepEqual(payload.providers, []);
});

test('/config 分段保存：代理模式空 baseURL 的模型分区可保存', async () => {
  const response = await fetch(`${base}/config`, {
    method: 'POST',
    headers: HEADER,
    body: JSON.stringify({
      section: 'model',
      settings: {
        model: { provider: 'openai-compatible', mode: 'proxy', hostProvider: 'some-oauth', baseURL: '', model: 'gpt-x', apiKeyRef: 'DSHGT_ROUTES_KEY' },
        repo: { path: repo },
      },
    }),
  });
  const payload = await response.json();
  assert.equal(payload.saved, true);
  assert.equal(store.readSettings().model.mode, 'proxy');
  assert.equal(store.readSettings().model.baseURL, '');
});

test('/config 分段保存只校验并写入当前分区（不被其它分区阻塞）', async () => {
  const before = store.readSettings();
  const response = await fetch(`${base}/config`, {
    method: 'POST',
    headers: HEADER,
    body: JSON.stringify({
      section: 'repo',
      settings: {
        // 同时带一个非法的 model（model.model 为空）；仓库分区保存不应被它阻塞。
        model: { provider: 'openai-compatible', mode: 'proxy', model: '', baseURL: '' },
        repo: { path: repo },
        trending: { topN: 7 },
      },
    }),
  });
  const payload = await response.json();
  assert.equal(payload.saved, true);
  const after = store.readSettings();
  assert.equal(after.repo.path, repo);
  assert.equal(after.model.model, before.model.model); // 非目标分区不被覆盖
  assert.equal(after.trending.topN, before.trending.topN);
});

// ——— 预览与 30 条历史 ———

function recordFor(id, extra = {}) {
  return {
    id,
    at: new Date().toISOString(),
    kind: 'run',
    ok: true,
    skipped: false,
    durationMs: 1000,
    files: 1,
    coreVersion: '0.3.0',
    model: { provider: 'deepseek', model: 'deepseek-chat' },
    languages: ['all'],
    warnings: [],
    ...extra,
  };
}

test('GET /preview 返回预览正文；非法 id / 未知 id / 无副本 / 文件缺失都能区分', async () => {
  store.writePreview('preview-run', '# 预览正文');
  store.recordRun(recordFor('preview-run', { preview: { file: 'trending/2026-10-30.md', bytes: 16, sha256: 'a'.repeat(64) } }));
  store.recordRun(recordFor('legacy-run'));
  store.recordRun(recordFor('orphan-run', { preview: { file: 'trending/2026-10-29.md', bytes: 1, sha256: 'b'.repeat(64) } }));

  const okResponse = await fetch(`${base}/preview?id=preview-run`, { headers: HEADER });
  assert.equal(okResponse.status, 200);
  const okPayload = await okResponse.json();
  assert.equal(okPayload.ok, true);
  assert.equal(okPayload.id, 'preview-run');
  assert.deepEqual(okPayload.preview, { text: '# 预览正文', truncated: false });

  const invalid = await fetch(`${base}/preview?id=../../etc/passwd`, { headers: HEADER });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, 'CONFIG_INVALID');

  const unknown = await fetch(`${base}/preview?id=no-such-run`, { headers: HEADER });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, 'NOT_FOUND');

  const noMeta = await fetch(`${base}/preview?id=legacy-run`, { headers: HEADER });
  assert.equal(noMeta.status, 404);

  const orphan = await fetch(`${base}/preview?id=orphan-run`, { headers: HEADER });
  assert.equal(orphan.status, 404);

  const noHeader = await fetch(`${base}/preview?id=preview-run`);
  assert.equal(noHeader.status, 403);
});

test('/state 返回完整历史（不再截到 10 条）', async () => {
  for (let index = 0; index < 35; index += 1) store.recordRun(recordFor(`history-${index}`));
  const response = await fetch(`${base}/state`, { headers: HEADER });
  const payload = await response.json();
  // 该用例复用同一 store，前面用例已写入若干记录；只断言「不截断到 10」且最新在首位。
  assert.ok(payload.status.history.length >= 35);
  assert.equal(payload.status.history[0].id, 'history-34');
  const ids = new Set(payload.status.history.map((record) => record.id));
  for (let index = 0; index < 35; index += 1) assert.ok(ids.has(`history-${index}`));
});
