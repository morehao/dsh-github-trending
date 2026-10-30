import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  pendingPr,
  routes,
  runner as runnerModule,
  schedule as scheduleModule,
  state as stateModule,
} from '../lib/internal.js';

const HEADER = { 'x-dsh-github-trending': '1', 'content-type': 'application/json' };

function tempStore() {
  return new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-pending-')) });
}

function seedSettings(store) {
  const repo = mkdtempSync(path.join(tmpdir(), 'dshgt-pending-repo-'));
  mkdirSync(path.join(repo, '.git'));
  store.writeSettings({
    model: { provider: 'deepseek', model: 'deepseek-chat', apiKeyRef: 'DSHGT_PENDING_KEY' },
    repo: { path: repo },
    github: { authMode: 'pat', tokenRef: 'DSHGT_GH_TOKEN' },
  });
  return repo;
}

async function startServer(store, fetchImpl) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TRENDING_DIGEST_CORE: '/definitely/not/here',
    DSHGT_PENDING_KEY: 'sk-x',
    DSHGT_GH_TOKEN: 'ghp_x',
  };
  const runner = new runnerModule.Runner({ store, get: () => undefined, env, fetchImpl });
  const scheduler = new scheduleModule.Scheduler({
    store,
    isRunning: () => false,
    getTimer: () => undefined,
    run: async () => undefined,
  });
  const server = http.createServer(
    routes.createRoutes({ store, runner, scheduler, get: () => undefined, env, version: '0.1.0-test', fetchImpl }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}${routes.ROUTE_PREFIX}`, close: () => server.close() };
}

test('parsePullUrl 只认标准 PR 链接', () => {
  assert.deepEqual(pendingPr.parsePullUrl('https://github.com/o/r/pull/12'), { owner: 'o', repo: 'r', number: 12 });
  assert.equal(pendingPr.parsePullUrl('https://github.com/o/r'), undefined);
  assert.equal(pendingPr.parsePullUrl('not a url'), undefined);
});

test('checkPendingPr 归一化 open / merged / 404 / 无 token', async () => {
  pendingPr.clearPendingPrCache();
  const open = await pendingPr.checkPendingPr({
    url: 'https://github.com/o/r/pull/1',
    token: 't',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ state: 'open' }) }),
  });
  assert.equal(open.state, 'open');

  pendingPr.clearPendingPrCache();
  const merged = await pendingPr.checkPendingPr({
    url: 'https://github.com/o/r/pull/2',
    token: 't',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ state: 'closed', merged: true, merged_at: '2026-10-30T00:00:00Z' }) }),
  });
  assert.equal(merged.state, 'merged');

  pendingPr.clearPendingPrCache();
  const notFound = await pendingPr.checkPendingPr({
    url: 'https://github.com/o/r/pull/3',
    token: 't',
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  assert.equal(notFound.state, 'unknown');

  const noToken = await pendingPr.checkPendingPr({ url: 'https://github.com/o/r/pull/4' });
  assert.equal(noToken.state, 'unknown');

  // 同一 URL 命中缓存：第二次不再调用 fetch
  pendingPr.clearPendingPrCache();
  let calls = 0;
  const counting = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ state: 'open' }) };
  };
  await pendingPr.checkPendingPr({ url: 'https://github.com/o/r/pull/5', token: 't', fetchImpl: counting });
  await pendingPr.checkPendingPr({ url: 'https://github.com/o/r/pull/5', token: 't', fetchImpl: counting });
  assert.equal(calls, 1);
});

test('/state 对账：已合并的 pendingPr 会被清掉', async () => {
  const store = tempStore();
  seedSettings(store);
  const today = scheduleModule.zonedDateString(new Date(), 'Asia/Shanghai');
  store.writeState({ pendingPr: { url: 'https://github.com/o/r/pull/7', createdAt: new Date().toISOString(), date: today } });
  const server = await startServer(store, async () => ({ ok: true, status: 200, json: async () => ({ state: 'closed', merged: true, merged_at: 'x' }) }));
  try {
    const response = await fetch(`${server.base}/state`, { headers: HEADER });
    const payload = await response.json();
    assert.equal(payload.status.pendingPr, null);
    assert.equal(payload.status.pendingPrState, 'merged');
    assert.equal(store.readState().pendingPr, undefined);
  } finally {
    server.close();
  }
});

test('/state 对账：仍在 open 的 pendingPr 保留并标注状态', async () => {
  const store = tempStore();
  seedSettings(store);
  const today = scheduleModule.zonedDateString(new Date(), 'Asia/Shanghai');
  store.writeState({ pendingPr: { url: 'https://github.com/o/r/pull/8', createdAt: new Date().toISOString(), date: today } });
  const server = await startServer(store, async () => ({ ok: true, status: 200, json: async () => ({ state: 'open' }) }));
  try {
    const response = await fetch(`${server.base}/state`, { headers: HEADER });
    const payload = await response.json();
    assert.equal(payload.status.pendingPrState, 'open');
    assert.equal(payload.status.pendingPr.url, 'https://github.com/o/r/pull/8');
    assert.equal(store.readState().pendingPr.url, 'https://github.com/o/r/pull/8');
  } finally {
    server.close();
  }
});
