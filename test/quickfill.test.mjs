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

test('只列生效路由，不列能力目录里未配置的供应商', async () => {
  const llm = {
    // 只有 magpie 是 profile 里声明、真正注册的路由
    listProviders: () => [{ id: 'magpie', name: 'Magpie' }],
    listConfigurableProviders: () => [
      { provider: 'magpie', displayName: 'Magpie', defaultBaseURL: 'http://127.0.0.1:3425/v1', nativeAuth: { env: ['MAGPIE_GATEWAY_KEY'], oauth: false } },
      { provider: 'openai', displayName: 'OpenAI', defaultBaseURL: 'https://api.openai.com/v1', nativeAuth: { env: ['OPENAI_API_KEY'], oauth: true } },
      { provider: 'anthropic', displayName: 'Anthropic', defaultBaseURL: 'https://api.anthropic.com', nativeAuth: { env: [], oauth: true } },
    ],
    listModels: async (provider) =>
      provider === 'magpie' ? [{ id: 'yygu/deepseek-flash', name: 'DeepSeek Flash' }, { id: 'workbuddy/deepseek-v4.1-flash' }] : [],
  };
  const credentials = { describe: async () => ({ configured: false, writable: true }) };
  const candidates = await quickfill.listProviderCandidates({ llm, credentials, env: { MAGPIE_GATEWAY_KEY: 'mg' } });
  assert.deepEqual(candidates.map((candidate) => candidate.id), ['magpie']);
  assert.equal(candidates[0].credential.mode, 'direct');
  assert.equal(candidates[0].credential.ref, 'MAGPIE_GATEWAY_KEY');
  assert.deepEqual(candidates[0].models.map((model) => model.id), ['yygu/deepseek-flash', 'workbuddy/deepseek-v4.1-flash']);
});

test('readDefaultSelection 读取宿主默认；applyDefaultSelection 无候选时退回代理', () => {
  const get = (name) =>
    name === 'agentDefaultModel'
      ? { currentSelection: () => ({ provider: 'magpie', model: 'yygu/deepseek-flash' }) }
      : undefined;
  const selection = quickfill.readDefaultSelection(get);
  assert.deepEqual(selection, { provider: 'magpie', model: 'yygu/deepseek-flash' });
  assert.equal(quickfill.readDefaultSelection(() => undefined), undefined);

  const base = config.normalizeSettings({ model: { provider: 'deepseek', model: 'old' }, repo: { path: '/tmp/x' } });
  const next = quickfill.applyDefaultSelection(base, selection);
  assert.equal(next.model.provider, 'openai-compatible');
  assert.equal(next.model.mode, 'proxy');
  assert.equal(next.model.hostProvider, 'magpie');
  assert.equal(next.model.model, 'yygu/deepseek-flash');
  assert.equal(next.model.baseURL, '');
});

test('备选链每项独立解析：主 ref 解析失败、备 ref 成功 → fallbackApiKeys 仍按序拿到备选密钥', async () => {
  // 主 ref（MAIN）解析会抛错（模拟凭据服务故障），备选 UPDATE_OK 与 ENV_OK 仍要各自解析到。
  const credentials = {
    describe: async () => ({ configured: true, writable: true }),
    resolve: async (ref) => {
      if (ref === 'MAIN') throw new Error('credentials backend down');
      if (ref === 'FALLBACK_A') return { value: 'sk-fallback-a', source: 'store' };
      if (ref === 'FALLBACK_B') return { value: 'sk-fallback-b', source: 'store' };
      return undefined;
    },
  };
  const settings = config.normalizeSettings({
    model: {
      provider: 'deepseek',
      model: 'main',
      apiKeyRef: 'MAIN',
      baseURL: 'https://api.deepseek.com/v1',
      fallbacks: [
        { provider: 'deepseek', mode: 'direct', model: 'fb-a', apiKeyRef: 'FALLBACK_A', baseURL: 'https://api.deepseek.com/v1' },
        // 第二项走代理：不需要密钥，占位空串（保持索引对齐）
        { provider: 'openai-compatible', mode: 'proxy', hostProvider: 'magpie', model: 'fb-proxy' },
        { provider: 'deepseek', mode: 'direct', model: 'fb-b', apiKeyRef: 'ENV_ONLY', baseURL: 'https://api.deepseek.com/v1' },
      ],
    },
    repo: { path: '/tmp/x' },
  });

  const resolved = await quickfill.resolveModelKey(settings, credentials, { ENV_ONLY: 'sk-from-env' });
  // 主 key 解析失败不抛、不连累备选：主 apiKey 缺省，但备选密钥全部就位且顺序与 fallbacks 一致。
  assert.equal(resolved.mode, 'direct');
  assert.equal(resolved.apiKey, undefined);
  assert.deepEqual(resolved.fallbackApiKeys, ['sk-fallback-a', '', 'sk-from-env']);
});

test('resolveFallbackKeys：单项 resolve 抛错只影响该项，后续项照常解析', async () => {
  const credentials = {
    resolve: async (ref) => {
      if (ref === 'BOOM') throw new Error('boom');
      return { value: 'sk-ok', source: 'store' };
    },
  };
  const settings = config.normalizeSettings({
    model: {
      provider: 'deepseek',
      model: 'main',
      apiKeyRef: 'M',
      fallbacks: [
        { provider: 'deepseek', model: 'a', apiKeyRef: 'BOOM', baseURL: 'https://api.deepseek.com/v1' },
        { provider: 'deepseek', model: 'b', apiKeyRef: 'OK', baseURL: 'https://api.deepseek.com/v1' },
      ],
    },
    repo: { path: '/tmp/x' },
  });
  const { keys } = await quickfill.resolveFallbackKeys(settings, credentials, {});
  assert.deepEqual(keys, ['', 'sk-ok']);
});
