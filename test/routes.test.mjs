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
});

const runner = new runnerModule.Runner({ store, get: () => undefined, env });
const scheduler = new scheduleModule.Scheduler({ store, isRunning: () => false, getTimer: () => undefined, run: async () => undefined });
const server = http.createServer(
  routes.createRoutes({ store, runner, scheduler, get: () => undefined, env, version: '0.1.0-test' }),
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
  assert.equal(payload.core.version, '0.1.0-fake');
  assert.equal(payload.schedule.enabled, true);
  assert.equal(payload.status.history.length, 0);
  assert.equal(payload.github.configured, false);
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

test('POST /run 跑通并写历史；GET /log 能取到日志', async () => {
  const response = await fetch(`${base}/run`, { method: 'POST', headers: HEADER, body: JSON.stringify({ dryRun: true }) });
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.summary.ok, true);
  assert.equal(payload.summary.dryRun, true);
  assert.equal(store.readHistory().length, 1);

  const log = await fetch(`${base}/log?id=${payload.summary.id}`, { headers: HEADER });
  const logPayload = await log.json();
  assert.equal(logPayload.id, payload.summary.id);
});

test('GET /log 拒绝非法 id（避免路径穿越）', async () => {
  const response = await fetch(`${base}/log?id=../../etc/passwd`, { headers: HEADER });
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'CONFIG_INVALID');
});

test('/quickfill 在没有 llm 服务时返回空列表而不是报错', async () => {
  const response = await fetch(`${base}/quickfill`, { headers: HEADER });
  const payload = await response.json();
  assert.deepEqual(payload.providers, []);
});
