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
  assert.equal(result.category, 'auth');
  assert.doesNotMatch(result.message ?? '', /ghp_secret_value/);
});

test('probeGithubAuth：TLS 证书校验失败 → category=tls 并提示 CA/代理', async () => {
  const err = Object.assign(new Error('fetch failed'), {
    cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
  });
  const result = await github.probeGithubAuth({
    credentials: credentialsWith('ghp_test'),
    authMode: 'pat',
    tokenRef: 'GITHUB_TOKEN',
    env: {},
    fetchImpl: async () => {
      throw err;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GITHUB_AUTH');
  assert.equal(result.category, 'tls');
  assert.match(result.message ?? '', /证书|CA|TLS/);
});

test('probeGithubAuth：DNS 失败 → category=network', async () => {
  const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  const result = await github.probeGithubAuth({
    credentials: credentialsWith('ghp_test'),
    authMode: 'pat',
    tokenRef: 'GITHUB_TOKEN',
    env: {},
    fetchImpl: async () => {
      throw err;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.category, 'network');
});

test('probeGithubAuth：超时 → category=timeout', async () => {
  const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const result = await github.probeGithubAuth({
    credentials: credentialsWith('ghp_test'),
    authMode: 'pat',
    tokenRef: 'GITHUB_TOKEN',
    env: {},
    fetchImpl: async () => {
      throw err;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.category, 'timeout');
  assert.match(result.message ?? '', /超时/);
});

test('readDefaultBranch：空路径 / 相对路径 / 不存在目录都返回 none 且不抛', async () => {
  assert.equal((await repo.readDefaultBranch('', { env: {} })).source, 'none');
  assert.equal((await repo.readDefaultBranch('relative/path', { env: {} })).source, 'none');
  assert.equal((await repo.readDefaultBranch('/definitely/not/here/xyz', { env: {} })).source, 'none');
});
