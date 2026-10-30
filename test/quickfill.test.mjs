import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, quickfill } from '../lib/internal.js';

/** 三种认证形态的宿主目录：env 密钥、已存凭据、OAuth（不可导出）。 */
function host({ stored = {}, oauth = [] } = {}) {
  const llm = {
    listProviders: () => [
      { id: 'deepseek', name: 'DeepSeek' },
      { id: 'magpie', name: 'Magpie' },
      { id: 'corp-sso', name: 'Corp SSO' },
    ],
    listConfigurableProviders: () => [
      { provider: 'deepseek', displayName: 'DeepSeek', defaultBaseURL: 'https://api.deepseek.com/v1', nativeAuth: { env: ['DEEPSEEK_API_KEY'], oauth: false } },
      { provider: 'magpie', displayName: 'Magpie', defaultBaseURL: 'http://127.0.0.1:3425/v1', nativeAuth: { env: ['MAGPIE_GATEWAY_KEY'], oauth: true } },
      { provider: 'corp-sso', displayName: 'Corp SSO', defaultBaseURL: 'https://llm.corp.example/v1', nativeAuth: { env: [], oauth: true } },
    ],
    listModels: async (provider) => (provider === 'deepseek' ? [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] : [{ id: `${provider}-model` }]),
  };
  const credentials = {
    describe: async (ref) => ({ configured: ref in stored, source: stored[ref] ? 'store' : undefined, writable: true }),
    resolve: async (ref) => (ref in stored ? { value: stored[ref], source: 'store' } : undefined),
  };
  return { llm, credentials };
}

test('三种形态：env 密钥 / 已存凭据 / OAuth 代理', async () => {
  const { llm, credentials } = host({ stored: { DEEPSEEK_API_KEY: 'sk-stored' } });
  const candidates = await quickfill.listProviderCandidates({ llm, credentials, env: { MAGPIE_GATEWAY_KEY: 'mg-key' } });
  const byId = Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate]));

  assert.equal(byId.deepseek.credential.mode, 'direct');
  assert.equal(byId.deepseek.credential.ref, 'DEEPSEEK_API_KEY');
  assert.equal(byId.deepseek.baseURL, 'https://api.deepseek.com/v1');
  assert.equal(byId.deepseek.coreProvider, 'deepseek');
  assert.deepEqual(byId.deepseek.models.map((model) => model.id), ['deepseek-chat']);

  // 环境变量也算可导出（describe 报未配置时回退 env）
  assert.equal(byId.magpie.credential.mode, 'direct');
  assert.equal(byId.magpie.credential.ref, 'MAGPIE_GATEWAY_KEY');
  assert.equal(byId.magpie.coreProvider, 'openai-compatible');

  // 没有任何可导出密钥 + oauth=true → 回环代理
  assert.equal(byId['corp-sso'].credential.mode, 'proxy');
  assert.equal(byId['corp-sso'].credential.ref, undefined);
});

test('applyCandidate 写入代理模式时清空 baseURL 与 hostProvider', async () => {
  const { llm, credentials } = host();
  const candidates = await quickfill.listProviderCandidates({ llm, credentials, env: {} });
  const sso = candidates.find((candidate) => candidate.id === 'corp-sso');
  const base = config.normalizeSettings({ model: { provider: 'deepseek', model: 'old', baseURL: 'https://old.example/v1' }, repo: { path: '/tmp/x' } });
  const next = quickfill.applyCandidate(base, sso, 'corp-sso-model');
  assert.equal(next.model.mode, 'proxy');
  assert.equal(next.model.hostProvider, 'corp-sso');
  assert.equal(next.model.baseURL, '');
  assert.equal(next.model.provider, 'openai-compatible');
  assert.equal(next.model.model, 'corp-sso-model');
});

test('直接模式解析密钥：先凭据服务，再环境变量，都没有则空', async () => {
  const { credentials } = host({ stored: { K1: 'from-store' } });
  const base = config.normalizeSettings({ model: { provider: 'deepseek', model: 'm', apiKeyRef: 'K1' }, repo: { path: '/tmp/x' } });
  assert.equal((await quickfill.resolveModelKey(base, credentials, {})).apiKey, 'from-store');

  const envRef = config.normalizeSettings({ model: { provider: 'deepseek', model: 'm', apiKeyRef: 'K2' }, repo: { path: '/tmp/x' } });
  assert.equal((await quickfill.resolveModelKey(envRef, credentials, { K2: 'from-env' })).apiKey, 'from-env');

  const missing = config.normalizeSettings({ model: { provider: 'deepseek', model: 'm', apiKeyRef: 'K3' }, repo: { path: '/tmp/x' } });
  assert.equal((await quickfill.resolveModelKey(missing, credentials, {})).apiKey, undefined);

  const proxied = config.normalizeSettings({ model: { provider: 'openai-compatible', mode: 'proxy', hostProvider: 'corp-sso', model: 'm' }, repo: { path: '/tmp/x' } });
  assert.equal((await quickfill.resolveModelKey(proxied, credentials, {})).mode, 'proxy');
});
