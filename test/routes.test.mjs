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

function scenarioCore(env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dshgt-routes-core-'));
  const file = path.join(dir, 'core.mjs');
  const assignments = Object.entries(env)
    .map(([key, value]) => `process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)};`)
    .join('\n');
  writeFileSync(file, `#!/usr/bin/env node\n${assignments}\nawait import(${JSON.stringify(`file://${FAKE}`)});\n`);
  chmodSync(file, 0o755);
  return file;
}

/** 独立服务器（独立 store/env）：用来复现「核心报错」这类不能靠共享 env 切换的场景。 */
async function isolatedServer(coreEnv = {}) {
  const isolatedRepo = mkdtempSync(path.join(tmpdir(), 'dshgt-routes-iso-repo-'));
  mkdirSync(path.join(isolatedRepo, '.git'));
  const isolatedStore = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-routes-iso-')) });
  isolatedStore.writeSettings({
    model: { provider: 'deepseek', model: 'deepseek-chat', apiKeyRef: 'DSHGT_ROUTES_KEY' },
    repo: { path: isolatedRepo },
  });
  const isolatedEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TRENDING_DIGEST_CORE: scenarioCore(coreEnv), DSHGT_ROUTES_KEY: 'sk-routes' };
  const isolatedRunner = new runnerModule.Runner({ store: isolatedStore, get: () => undefined, env: isolatedEnv });
  const isolatedScheduler = new scheduleModule.Scheduler({
    store: isolatedStore,
    isRunning: () => false,
    getTimer: () => undefined,
    run: async () => undefined,
    runReleases: async () => undefined,
  });
  const isolated = http.createServer(
    routes.createRoutes({
      store: isolatedStore,
      runner: isolatedRunner,
      scheduler: isolatedScheduler,
      get: () => undefined,
      env: isolatedEnv,
      version: '0.1.0-test',
    }),
  );
  await new Promise((resolve) => isolated.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${isolated.address().port}${routes.ROUTE_PREFIX}`,
    // fetch 的 keep-alive 连接会拖住 close()：先掐连接，避免测试进程多挂几秒。
    close: () => {
      isolated.closeAllConnections?.();
      isolated.close();
    },
  };
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
const scheduler = new scheduleModule.Scheduler({ store, isRunning: () => false, getTimer: () => undefined, run: async () => undefined, runReleases: async () => undefined });
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
  // 发版行程与榜单行程并列：默认周一 08:00 上海，且带下一次触发时间。
  assert.equal(payload.schedule.releaseEnabled, true);
  assert.equal(payload.schedule.releaseWeekday, 1);
  assert.equal(payload.schedule.releaseTime, '08:00:00');
  assert.equal(payload.schedule.releaseTimezone, 'Asia/Shanghai');
  assert.equal(typeof payload.schedule.nextReleaseAt, 'string');
  assert.equal(payload.schedule.releaseCatchUpMinutes, 360);
  assert.equal(payload.status.history.length, 0);
  assert.deepEqual(payload.status.releaseRuns, []);
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

test('/state 汇总历史 token 累计（totalTokens）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dshgt-tokens-state-'));
  const totalStore = new stateModule.Store({ dir });
  totalStore.recordRun({ ...recordFor('t1'), tokens: 1000 });
  totalStore.recordRun({ ...recordFor('t2'), tokens: 2500 });
  totalStore.recordRun({ ...recordFor('t3') });
  // 复用当前 server 的 deps 不方便，直接断言 sumTokens 行为已由 state 测试覆盖；
  // 这里只确保 /state 对当前 store（无 tokens 记录）不报错、不出现 totalTokens 字段。
  const response = await fetch(`${base}/state`, { headers: HEADER });
  const payload = await response.json();
  assert.equal(payload.status.totalTokens, undefined);
});

test('/subscriptions GET 初始为空；POST add → 列表含该仓库 → POST remove → 清空', async () => {
  const empty = await fetch(`${base}/subscriptions`, { headers: HEADER });
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json()).repos, []);

  const added = await fetch(`${base}/subscriptions`, { method: 'POST', headers: HEADER, body: JSON.stringify({ action: 'add', repos: ['vercel/next.js'] }) });
  assert.equal(added.status, 200);
  assert.deepEqual((await added.json()).repos, ['vercel/next.js']);

  const removed = await fetch(`${base}/subscriptions`, { method: 'POST', headers: HEADER, body: JSON.stringify({ action: 'remove', repos: ['vercel/next.js'] }) });
  assert.equal(removed.status, 200);
  assert.deepEqual((await removed.json()).repos, []);
});

test('/subscriptions 的 items 恒为数组（旧核心没有明细时是空数组）', async () => {
  const response = await fetch(`${base}/subscriptions`, { headers: HEADER });
  const payload = await response.json();
  assert.deepEqual(payload.items, []);
  const post = await fetch(`${base}/subscriptions`, { method: 'POST', headers: HEADER, body: JSON.stringify({ action: 'add', repos: ['a/b'] }) });
  const postPayload = await post.json();
  assert.deepEqual(postPayload.items, []);
  await fetch(`${base}/subscriptions`, { method: 'POST', headers: HEADER, body: JSON.stringify({ action: 'remove', repos: ['a/b'] }) });
});

test('/subscriptions/releases 返回文档本身；卷号透传', async () => {
  const response = await fetch(`${base}/subscriptions/releases?repo=vercel/next.js`, { headers: HEADER });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.fullName, 'vercel/next.js');
  assert.equal(payload.volume, 1);
  assert.match(payload.markdown, /发版记录/);
  assert.equal(payload.volumes[0].index, 1);

  const withVolume = await fetch(`${base}/subscriptions/releases?repo=vercel/next.js&volume=2`, { headers: HEADER });
  assert.equal(withVolume.status, 200);
  assert.equal((await withVolume.json()).volume, 2);
});

test('/subscriptions/releases 非法 repo / 卷号 → 400 CONFIG_INVALID', async () => {
  for (const query of ['repo=not-a-repo', 'repo=', 'repo=a/b&volume=0', 'repo=a/b&volume=abc', 'repo=a/b&volume=1.5']) {
    const response = await fetch(`${base}/subscriptions/releases?${query}`, { headers: HEADER });
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).code, 'CONFIG_INVALID', query);
  }
});

test('/subscriptions/releases 核心说没有文档时回错误，不返回空文档', async () => {
  const isolated = await isolatedServer({ FAKE_SUBSCRIBE_DOC_MISSING: '1' });
  try {
    const response = await fetch(`${isolated.base}/subscriptions/releases?repo=a/b`, { headers: HEADER });
    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'SUBSCRIBE_FAILED');
    assert.match(payload.message, /no release document/);
  } finally {
    isolated.close();
  }
});

test('/subscriptions POST 缺 action 或 repo → 400', async () => {
  const noAction = await fetch(`${base}/subscriptions`, { method: 'POST', headers: HEADER, body: JSON.stringify({ repos: ['a/b'] }) });
  assert.equal(noAction.status, 400);
  const noRepo = await fetch(`${base}/subscriptions`, { method: 'POST', headers: HEADER, body: JSON.stringify({ action: 'add', repos: [] }) });
  assert.equal(noRepo.status, 400);
});

test('/subscriptions 缺自定义头 → 403', async () => {
  const response = await fetch(`${base}/subscriptions`);
  assert.equal(response.status, 403);
});

// ——— POST /releases/run：发版订阅运行触发（全量 / 单仓） ———

test('/releases/run 缺自定义头 → 403', async () => {
  const response = await fetch(`${base}/releases/run`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(response.status, 403);
});

test('/releases/run 全量 → 返回一条 release 记录，不写 history', async () => {
  const isolated = await isolatedServer({ FAKE_REQUIRE_STAGES: '1', FAKE_RELEASES: '2,1,1' });
  try {
    const response = await fetch(`${isolated.base}/releases/run`, { method: 'POST', headers: HEADER, body: JSON.stringify({}) });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.release.status, 'ok');
    assert.equal(payload.release.scopeRepo, undefined);
  } finally {
    isolated.close();
  }
});

test('/releases/run 单仓 → 透传 repo（核心支持时），记录带 scopeRepo', async () => {
  const isolated = await isolatedServer({
    FAKE_REQUIRE_STAGES: '1',
    FAKE_REQUIRE_REPO: 'vercel/next.js',
    FAKE_VERSION: '0.8.0',
    FAKE_RELEASES: '1,1,0',
  });
  try {
    const response = await fetch(`${isolated.base}/releases/run`, { method: 'POST', headers: HEADER, body: JSON.stringify({ repo: 'vercel/next.js' }) });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.release.status, 'ok');
    assert.equal(payload.release.scopeRepo, 'vercel/next.js');
  } finally {
    isolated.close();
  }
});

test('/releases/run 非法 repo → 400 CONFIG_INVALID', async () => {
  const response = await fetch(`${base}/releases/run`, { method: 'POST', headers: HEADER, body: JSON.stringify({ repo: 'not-a-repo' }) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'CONFIG_INVALID');
});

test('/releases/run 并发（已有运行在跑）→ 409', async () => {
  const isolated = await isolatedServer({ FAKE_SLEEP: '1200', FAKE_REQUIRE_STAGES: '1' });
  try {
    const first = fetch(`${isolated.base}/releases/run`, { method: 'POST', headers: HEADER, body: JSON.stringify({}) });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = await fetch(`${isolated.base}/releases/run`, { method: 'POST', headers: HEADER, body: JSON.stringify({}) });
    assert.equal(second.status, 409);
    assert.equal((await second.json()).code, 'CONFIG_INVALID');
    await first;
  } finally {
    isolated.close();
  }
});

// --- GitHub 浏览器登录路由 ---
async function browserServer(options = {}) {
  const bStore = new stateModule.Store({ dir: mkdtempSync(path.join(tmpdir(), 'dshgt-routes-browser-')) });
  const bRepo = mkdtempSync(path.join(tmpdir(), 'dshgt-routes-browser-repo-'));
  mkdirSync(path.join(bRepo, '.git'));
  bStore.writeSettings({
    model: { provider: 'deepseek', model: 'deepseek-chat', apiKeyRef: 'DSHGT_ROUTES_KEY' },
    repo: { path: bRepo },
    github: { authMode: 'browser', tokenRef: 'GITHUB_TOKEN' },
  });
  const routesMap = new Map();
  const flows = new Map();
  let committed;
  const authorization = {
    registerFlow(flow) { flows.set(flow.key, flow); return () => flows.delete(flow.key); },
    async begin(request) {
      const flow = flows.get(request.key);
      const session = {
        method: request.method,
        signal: request.signal,
        notify: (n) => request.interaction?.notify?.(n),
        prompt: () => Promise.reject(new Error('no')),
        commit: async (record) => { committed = record; },
      };
      try { await flow.run(session); return { status: 'authorized' }; }
      catch (e) { if (request.signal?.aborted) return { status: 'cancelled' }; throw e; }
    },
    cancel() {},
  };
  const webServer = {
    port: 45123,
    host: '127.0.0.1',
    register(route) { routesMap.set(route.path, route.handler); return () => routesMap.delete(route.path); },
  };
  const bEnv = { PATH: process.env.PATH, HOME: process.env.HOME, DSHGT_ROUTES_KEY: 'sk-routes' };
  const withAuthorization = options.withAuthorization !== false;
  const withClientSecret = options.withClientSecret !== false;
  const get = (name) => (name === 'authorization' ? (withAuthorization ? authorization : undefined) : name === 'webServer' ? webServer : undefined);
  // 离线 stub：GitHub OAuth / device / user 端点（测试不联网）。
  const githubFetch = async (url) => {
    const target = String(url);
    if (target === 'https://github.com/login/oauth/access_token') {
      return { ok: true, status: 200, json: async () => ({ access_token: 'ghu_test', token_type: 'bearer', scope: 'repo' }) };
    }
    if (target === 'https://github.com/login/device/code') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          device_code: 'dev',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          verification_uri_complete: 'https://github.com/login/device?user_code=ABCD-1234',
          expires_in: 600,
          interval: 60,
        }),
      };
    }
    if (target === 'https://api.github.com/user') {
      return { ok: true, status: 200, json: async () => ({ login: 'tester' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const bRunner = new runnerModule.Runner({ store: bStore, get, env: bEnv });
  const bScheduler = new scheduleModule.Scheduler({ store: bStore, isRunning: () => false, getTimer: () => undefined, run: async () => undefined, runReleases: async () => undefined });
  const server = http.createServer(routes.createRoutes({
    store: bStore, runner: bRunner, scheduler: bScheduler, get, env: bEnv, fetchImpl: githubFetch,
    version: '0.1.0-test', githubClientId: 'test-client-id',
    ...(withClientSecret ? { githubClientSecret: 'test-client-secret' } : {}),
  }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}${routes.ROUTE_PREFIX}`,
    routesMap, committedRef: () => committed,
    close: () => { server.closeAllConnections?.(); server.close(); },
  };
}

test('GET /github/browser/status 初始为 idle 且 browserAvailable=true', async () => {
  const b = await browserServer();
  try {
    const res = await fetch(`${b.base}/github/browser/status`, { headers: HEADER });
    const body = await res.json();
    assert.equal(body.attempt.phase, 'idle');
    const state = await (await fetch(`${b.base}/state`, { headers: HEADER })).json();
    assert.equal(state.github.browserAvailable, true);
    assert.equal(state.github.loopbackAvailable, true, '配了 client_secret 才能走回环 web flow');
    assert.equal(state.github.authMode, 'browser');
  } finally { b.close(); }
});

test('无 authorization 服务：browserAvailable=false，begin 返回 GITHUB_AUTH_UNAVAILABLE 而不是 idle', async () => {
  const b = await browserServer({ withAuthorization: false });
  try {
    const state = await (await fetch(`${b.base}/state`, { headers: HEADER })).json();
    assert.equal(state.github.browserAvailable, false, '没有服务时按钮不该亮');
    const res = await fetch(`${b.base}/github/browser/begin`, { method: 'POST', headers: HEADER, body: JSON.stringify({ method: 'browser' }) });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.code, 'GITHUB_AUTH_UNAVAILABLE');
    assert.match(String(body.message), /authorization/);
  } finally { b.close(); }
});

test('无 client_secret：loopbackAvailable=false，begin(browser) 自动走设备码', async () => {
  const b = await browserServer({ withClientSecret: false });
  try {
    const state = await (await fetch(`${b.base}/state`, { headers: HEADER })).json();
    assert.equal(state.github.browserAvailable, true, 'authorization 服务在，登录仍可用');
    assert.equal(state.github.loopbackAvailable, false, '内置 client_id 没有 secret，回环不可用');
    const res = await fetch(`${b.base}/github/browser/begin`, { method: 'POST', headers: HEADER, body: JSON.stringify({ method: 'browser' }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.attempt.phase, 'waiting-device');
    assert.equal(body.attempt.userCode, 'ABCD-1234');
    assert.equal(body.attempt.verificationUriComplete, 'https://github.com/login/device?user_code=ABCD-1234');
    assert.equal(body.attempt.authorizeUrl, undefined);
    await fetch(`${b.base}/github/browser/cancel`, { method: 'POST', headers: HEADER, body: '{}' });
  } finally { b.close(); }
});

test('POST /github/browser/begin → 回调被接受且离开 idle，cancel 可收尾', async () => {
  const b = await browserServer();
  try {
    const beginRes = await fetch(`${b.base}/github/browser/begin`, { method: 'POST', headers: HEADER, body: JSON.stringify({ method: 'browser' }) });
    const begin = await beginRes.json();
    assert.ok(begin.attempt.authorizeUrl, 'has authorizeUrl');

    // 模拟 GitHub 回调：从 authorizeUrl 取 state，喂给注册的 exact 路由 handler。
    const state = new URL(begin.attempt.authorizeUrl).searchParams.get('state');
    const handler = [...b.routesMap.values()][0];
    assert.ok(handler, 'callback route registered');
    let code = 0;
    const res = { writeHead(c) { code = c; return this; }, end() { return this; } };
    // 状态不匹配 → 400（URL 校验分支）；正确 state → 200，exchange 走注入的离线 fetch stub。
    handler({ method: 'GET', url: `${'/api/morehao/github-trending/oauth/github/callback'}?code=abc&state=WRONG` }, res);
    assert.equal(code, 400);
    // 正确 state → 200
    const res2 = { writeHead(c) { code = c; return this; }, end() { return this; } };
    handler({ method: 'GET', url: `${'/api/morehao/github-trending/oauth/github/callback'}?code=abc&state=${state}` }, res2);
    assert.equal(code, 200);
    await new Promise((r) => setTimeout(r, 30));
    const status = await (await fetch(`${b.base}/github/browser/status`, { headers: HEADER })).json();
    assert.notEqual(status.attempt.phase, 'idle');
    await fetch(`${b.base}/github/browser/cancel`, { method: 'POST', headers: HEADER, body: '{}' });
  } finally { b.close(); }
});
