import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PluginUpdateError } from '@morehao/dsh-plugin-kit/update';

import { routes, runner as runnerModule, schedule as scheduleModule, state as stateModule } from '../lib/internal.js';

const VIEW = {
  packageName: '@demo/plugin',
  currentVersion: '0.3.0',
  latestVersion: '0.4.0',
  updateAvailable: true,
  checkFailed: false,
  canApply: true,
  installKind: 'registry',
  manualCommand: 'dsh plugin --profile desktop add @demo/plugin@latest',
  applying: false,
};

function fakeUpdater(overrides = {}) {
  const calls = [];
  return {
    calls,
    async check(options = {}) {
      calls.push(['check', options]);
      return overrides.view ?? VIEW;
    },
    async apply(options = {}) {
      calls.push(['apply', options]);
      if (overrides.error !== undefined) throw overrides.error;
      return { application: 'restart-required', restartRequired: true, updatedVersion: '0.4.0', installKind: 'registry', steps: [] };
    },
    view: () => overrides.view ?? VIEW,
    async latestVersion() {
      return '0.4.0';
    },
    isApplying: () => false,
  };
}

const servers = [];
after(() => {
  for (const server of servers) server.close();
});

async function start(update) {
  const store = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-update-')) });
  const runner = new runnerModule.Runner({ store, get: () => undefined, env: { PATH: process.env.PATH } });
  const scheduler = new scheduleModule.Scheduler({ store, isRunning: () => false, getTimer: () => undefined, run: async () => undefined });
  const server = http.createServer(
    routes.createRoutes({
      store,
      runner,
      scheduler,
      get: () => undefined,
      env: { PATH: process.env.PATH },
      version: '0.3.0',
      ...(update === undefined ? {} : { update }),
    }),
  );
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}${routes.ROUTE_PREFIX}`;
}

const HEADER = { 'x-dsh-github-trending': '1', 'content-type': 'application/json' };

test('GET /update：默认用缓存，fresh=1 强制查', async () => {
  const updater = fakeUpdater();
  const base = await start(updater);
  const first = await fetch(`${base}/update`, { headers: HEADER });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).update.latestVersion, '0.4.0');
  assert.deepEqual(updater.calls[0], ['check', { fresh: false }]);

  await fetch(`${base}/update?fresh=1`, { headers: HEADER });
  assert.deepEqual(updater.calls[1], ['check', { fresh: true }]);
});

test('POST /update：透传版本并返回安装结果', async () => {
  const updater = fakeUpdater();
  const base = await start(updater);
  const response = await fetch(`${base}/update`, { method: 'POST', headers: HEADER, body: JSON.stringify({ version: '0.4.0' }) });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.result.application, 'restart-required');
  assert.deepEqual(updater.calls[0], ['apply', { version: '0.4.0' }]);
});

test('POST /update：link 安装等业务失败 → 409 + UPDATE_FAILED，保留 updateCode', async () => {
  const updater = fakeUpdater({ error: new PluginUpdateError('LINKED_INSTALL', '当前是本地 link 安装') });
  const base = await start(updater);
  const response = await fetch(`${base}/update`, { method: 'POST', headers: HEADER, body: '{}' });
  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'UPDATE_FAILED');
  assert.equal(payload.updateCode, 'LINKED_INSTALL');
  assert.match(payload.message, /link/);
});

test('没有自更新服务：/update 返回 404；缺少自定义头 403', async () => {
  const base = await start(undefined);
  const missing = await fetch(`${base}/update`, { headers: HEADER });
  assert.equal(missing.status, 404);
  const forbidden = await fetch(`${base}/update`);
  assert.equal(forbidden.status, 403);
});
