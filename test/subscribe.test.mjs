import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { subscribe as subscribeModule, state as stateModule } from '../lib/internal.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CORE = path.join(here, 'fixtures', 'fake-core.mjs');

/** 与 runner.test 一样：把 FAKE_* 写进包装脚本（sanitizedEnv 会剥掉普通 env）。 */
function fakeCore(scenario = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dshgt-sub-core-'));
  const file = path.join(dir, 'core.mjs');
  const assignments = Object.entries(scenario)
    .map(([key, value]) => `process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)};`)
    .join('\n');
  writeFileSync(file, `#!/usr/bin/env node\n${assignments}\nawait import(${JSON.stringify(`file://${FAKE_CORE}`)});\n`);
  chmodSync(file, 0o755);
  return file;
}

function makeStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dshgt-sub-'));
  const repo = mkdtempSync(path.join(tmpdir(), 'dshgt-sub-repo-'));
  mkdirSync(path.join(repo, '.git'));
  const store = new stateModule.Store({ dir });
  store.writeSettings({
    model: { provider: 'deepseek', model: 'deepseek-chat', apiKeyRef: 'K', baseURL: 'https://api.deepseek.com/v1' },
    repo: { path: repo },
    output: { dir: 'trending' },
  });
  return { store, repo };
}

test('subscribe list 初始为空；add 后出现在列表；remove 后消失', async () => {
  const { store, repo } = makeStore();
  const corePath = fakeCore();
  const deps = { store, env: { PATH: process.env.PATH, HOME: process.env.HOME }, corePath };

  const empty = await subscribeModule.runSubscribe({ action: 'list' }, deps);
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.repos, []);

  const added = await subscribeModule.runSubscribe({ action: 'add', repo: 'vercel/next.js' }, deps);
  assert.equal(added.ok, true);

  const listed = await subscribeModule.runSubscribe({ action: 'list' }, deps);
  assert.deepEqual(listed.repos, ['vercel/next.js']);
  // 数据仓里确实落了订阅文件（被核心写），插件自己没有直接写。
  assert.equal(existsSync(path.join(repo, 'trending', 'subscriptions.fake.json')), true);

  const removed = await subscribeModule.runSubscribe({ action: 'remove', repo: 'vercel/next.js' }, deps);
  assert.equal(removed.ok, true);
  const afterRemove = await subscribeModule.runSubscribe({ action: 'list' }, deps);
  assert.deepEqual(afterRemove.repos, []);
});

test('代理模式（baseURL 为空）也能管理订阅：临时配置补回环占位端点', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dshgt-sub-proxy-'));
  const repo = mkdtempSync(path.join(tmpdir(), 'dshgt-sub-proxy-repo-'));
  mkdirSync(path.join(repo, '.git'));
  const store = new stateModule.Store({ dir });
  store.writeSettings({
    model: { provider: 'openai-compatible', mode: 'proxy', hostProvider: 'magpie', baseURL: '', model: 'm', apiKeyRef: 'K' },
    repo: { path: repo },
    output: { dir: 'trending' },
  });
  const deps = { store, env: { PATH: process.env.PATH, HOME: process.env.HOME }, corePath: fakeCore() };

  const listed = await subscribeModule.runSubscribe({ action: 'list' }, deps);
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.repos, []);
});

test('subscribe 非法 owner/repo 形态在插件侧就拦下（CONFIG_INVALID）', async () => {
  const { store } = makeStore();
  const deps = { store, env: { PATH: process.env.PATH, HOME: process.env.HOME }, corePath: fakeCore() };
  await assert.rejects(
    () => subscribeModule.runSubscribe({ action: 'add', repo: 'not a repo' }, deps),
    (error) => error.code === 'CONFIG_INVALID',
  );
});

test('核心返回失败信封 → runSubscribe 如实回 ok:false + error', async () => {
  const { store } = makeStore();
  const deps = { store, env: { PATH: process.env.PATH, HOME: process.env.HOME }, corePath: fakeCore({ FAKE_SUBSCRIBE_FAIL: '1' }) };
  const result = await subscribeModule.runSubscribe({ action: 'remove', repo: 'a/b' }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONFIG_INVALID');
});

test('配置不完整（缺模型/仓库）→ 管理订阅前直接 CONFIG_INVALID', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dshgt-sub-badcfg-'));
  const store = new stateModule.Store({ dir });
  store.writeSettings({});
  const deps = { store, env: { PATH: process.env.PATH, HOME: process.env.HOME }, corePath: fakeCore() };
  await assert.rejects(
    () => subscribeModule.runSubscribe({ action: 'list' }, deps),
    (error) => error.code === 'CONFIG_INVALID',
  );
});

test('isValidRepo 只接受 owner/repo', () => {
  assert.equal(subscribeModule.isValidRepo('vercel/next.js'), true);
  assert.equal(subscribeModule.isValidRepo('a/b'), true);
  assert.equal(subscribeModule.isValidRepo('no-slash'), false);
  assert.equal(subscribeModule.isValidRepo('a/b/c'), false);
  assert.equal(subscribeModule.isValidRepo(''), false);
});
