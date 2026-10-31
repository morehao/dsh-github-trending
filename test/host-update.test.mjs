import { test } from 'node:test';
import assert from 'node:assert/strict';

import { updateService } from '../lib/internal.js';

const META = { name: '@demo/plugin', version: '0.3.0' };
const PROFILE = { name: 'desktop', dir: '/profiles/desktop', packageManager: { command: 'pnpm', args: ['--silent'] } };

function registryFetch(version) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, async json() { return { version }; } };
  };
  impl.calls = calls;
  return impl;
}

function fakeManager(result = { application: 'applied' }) {
  const calls = [];
  return {
    calls,
    async installBundle(spec) {
      calls.push(['install', spec]);
      return result;
    },
    async removeBundle(name) {
      calls.push(['remove', name]);
      return { application: 'applied' };
    },
  };
}

function makeService(overrides = {}) {
  const execCalls = [];
  const env = { PATH: '/usr/bin', HOME: '/tmp/home', DSHGT_SECRET: 'sk-should-not-leak' };
  const service = updateService.createUpdateService({
    get: (key) => {
      if (key === 'profileContext') return overrides.profile === undefined ? PROFILE : overrides.profile;
      if (key === 'pluginManager') return overrides.manager;
      return undefined;
    },
    env,
    meta: META,
    exec: async (file, args, options) => {
      execCalls.push({ file, args, options });
      if (overrides.exec === undefined) return { code: 1, stdout: '', stderr: 'no pnpm', signal: null, timedOut: false, aborted: false, durationMs: 1 };
      return overrides.exec(file, args, options);
    },
    readFile: async () => JSON.stringify({ dependencies: { '@demo/plugin': overrides.spec ?? '^0.3.0' } }),
    ...(overrides.fetchImpl === undefined ? {} : { fetchImpl: overrides.fetchImpl }),
  });
  return { service, execCalls, env };
}

test('pnpm view：走 profile 的包管理器，环境变量按白名单清洗', async () => {
  const { service, execCalls } = makeService({ exec: async () => ({ code: 0, stdout: '"9.9.9"\n', stderr: '', signal: null, timedOut: false, aborted: false, durationMs: 1 }) });
  const view = await service.check();
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].file, 'pnpm');
  assert.deepEqual(execCalls[0].args, ['--silent', 'view', '@demo/plugin@latest', 'version', '--json']);
  assert.equal(execCalls[0].options.cwd, '/profiles/desktop');
  assert.equal(execCalls[0].options.env.PATH, '/usr/bin');
  assert.equal(execCalls[0].options.env.DSHGT_SECRET, undefined, '环境白名单不能让插件密钥进子进程');
  assert.equal(view.latestVersion, '9.9.9');
  assert.equal(view.updateAvailable, true);
});

test('pnpm 不可用：回退 registry；profile 没有 dir 时直接走 registry', async () => {
  const fetchImpl = registryFetch('0.4.0');
  const { service } = makeService({ fetchImpl });
  const view = await service.check();
  assert.equal(view.latestVersion, '0.4.0');
  assert.equal(fetchImpl.calls[0], 'https://registry.npmjs.org/@demo%2Fplugin/latest');

  const noDir = makeService({ profile: { name: 'headless' }, fetchImpl: registryFetch('0.4.1') });
  const view2 = await noDir.service.check();
  assert.equal(view2.latestVersion, '0.4.1');
  assert.equal(noDir.execCalls.length, 0);
});

test('link 安装：可以检查，但不能一键更新', async () => {
  const manager = fakeManager();
  const { service } = makeService({ spec: 'link:../dsh-plugin-kit', manager, fetchImpl: registryFetch('0.4.0') });
  const view = await service.check();
  assert.equal(view.installKind, 'link');
  assert.equal(view.canApply, false);
  assert.match(view.manualCommand, /dsh plugin --profile desktop add @demo\/plugin@latest/);
  await assert.rejects(service.apply(), (error) => error.code === 'LINKED_INSTALL');
  assert.deepEqual(manager.calls, []);
});

test('registry 安装：apply 经 pluginManager 重装', async () => {
  const manager = fakeManager({ application: 'restart-required' });
  const { service } = makeService({ manager, fetchImpl: registryFetch('0.4.0') });
  await service.check();
  const result = await service.apply();
  assert.equal(result.updatedVersion, '0.4.0');
  assert.equal(result.restartRequired, true);
  assert.deepEqual(manager.calls, [['install', '@demo/plugin@0.4.0']]);
});

test('查不到最新版：checkFailed 但不抛，apply 被拒绝', async () => {
  const { service } = makeService({ fetchImpl: async () => { throw new Error('offline'); } });
  const view = await service.check();
  assert.equal(view.checkFailed, true);
  assert.equal(view.latestVersion, null);
  await assert.rejects(service.apply(), (error) => error.code === 'NOT_CHECKED' || error.code === 'NO_UPDATE');
});
