import { test } from 'node:test';
import assert from 'node:assert/strict';
import { github, repo } from '../lib/internal.js';

function credentialsWith(token) {
  return {
    describe: async () => ({ configured: token !== undefined, source: token === undefined ? undefined : 'store', writable: true }),
    resolve: async () => (token === undefined ? undefined : { value: token, source: 'store' }),
  };
}

test('probeGithubAuth：pat 模式下有效 token → ok 且回显登录名', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return { ok: true, status: 200, json: async () => ({ login: 'octocat' }) };
  };
  const result = await github.probeGithubAuth({
    credentials: credentialsWith('ghp_test'),
    authMode: 'pat',
    tokenRef: 'GITHUB_TOKEN',
    env: {},
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.login, 'octocat');
  assert.equal(result.source, 'store');
  assert.equal(calls[0].url, 'https://api.github.com/user');
  assert.equal(calls[0].headers.authorization, 'Bearer ghp_test');
});

test('probeGithubAuth：没有 token → 失败且提示可操作', async () => {
  const result = await github.probeGithubAuth({
    credentials: credentialsWith(undefined),
    authMode: 'pat',
    tokenRef: 'GITHUB_TOKEN',
    env: {},
    fetchImpl: async () => {
      throw new Error('should not be called');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GITHUB_AUTH');
  assert.match(result.message ?? '', /Personal Access Token/);
});

test('probeGithubAuth：401 → 失败，不泄漏 token 明文', async () => {
  const result = await github.probeGithubAuth({
    credentials: credentialsWith('ghp_secret_value'),
    authMode: 'pat',
    tokenRef: 'GITHUB_TOKEN',
    env: {},
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GITHUB_AUTH');
  assert.doesNotMatch(result.message ?? '', /ghp_secret_value/);
});

test('readDefaultBranch：空路径 / 相对路径 / 不存在目录都返回 none 且不抛', async () => {
  assert.equal((await repo.readDefaultBranch('', { env: {} })).source, 'none');
  assert.equal((await repo.readDefaultBranch('relative/path', { env: {} })).source, 'none');
  assert.equal((await repo.readDefaultBranch('/definitely/not/here/xyz', { env: {} })).source, 'none');
});
