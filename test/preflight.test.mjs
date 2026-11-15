import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, preflight } from '../lib/internal.js';

/** 构造一份带备选链的设置；fallbacks 逐项给出，缺省字段由 normalize 补齐。 */
function settingsWith(fallbacks, model = {}) {
  return config.normalizeSettings({
    model: { provider: 'deepseek', model: 'deepseek-chat', apiKeyRef: 'MAIN_KEY', ...model, fallbacks },
    repo: { path: '/tmp/x' },
  });
}

/** 凭据服务桩：只认 stored 里的引用名，其余解析成 undefined。 */
function credentials(stored = {}) {
  return {
    describe: async (ref) => ({ configured: ref in stored, source: stored[ref] ? 'store' : undefined, writable: true }),
    resolve: async (ref) => (ref in stored ? { value: stored[ref], source: 'store' } : undefined),
  };
}

/** 记录每个请求的 fetch 桩，返回可控响应。 */
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return handler(url, init);
  };
  impl.calls = calls;
  return impl;
}

test('备选预检：direct 项用自己的 apiKeyRef 打对端点、返回成功', async () => {
  const settings = settingsWith([
    { provider: 'openai-compatible', model: 'gpt-x', baseURL: 'https://api.example.com/v1', apiKeyRef: 'FB1' },
  ]);
  const fetchImpl = fakeFetch(() => new Response('{}', { status: 200 }));
  const result = await preflight.preflightFallback({
    settings,
    index: 0,
    credentials: credentials({ FB1: 'sk-fb1' }),
    llm: undefined,
    env: {},
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.index, 0);
  assert.equal(result.mode, 'direct');
  assert.equal(result.endpoint, 'https://api.example.com/v1/chat/completions');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].body.model, 'gpt-x');
});

test('备选预检：缺密钥报 MODEL_KEY_MISSING，且不发起请求', async () => {
  const settings = settingsWith([
    { provider: 'openai-compatible', model: 'gpt-x', baseURL: 'https://api.example.com/v1', apiKeyRef: 'FB1' },
  ]);
  const fetchImpl = fakeFetch(() => new Response('{}', { status: 200 }));
  const result = await preflight.preflightFallback({
    settings,
    index: 0,
    credentials: credentials({}),
    llm: undefined,
    env: {},
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MODEL_KEY_MISSING');
  assert.equal(fetchImpl.calls.length, 0);
});

test('备选预检：401 报 MODEL_UNAUTHORIZED', async () => {
  const settings = settingsWith([
    { provider: 'openai-compatible', model: 'gpt-x', baseURL: 'https://api.example.com/v1', apiKeyRef: 'FB1' },
  ]);
  const fetchImpl = fakeFetch(() => new Response('nope', { status: 401 }));
  const result = await preflight.preflightFallback({
    settings,
    index: 0,
    credentials: credentials({ FB1: 'sk-fb1' }),
    llm: undefined,
    env: {},
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MODEL_UNAUTHORIZED');
});

test('备选预检：proxy 项走 ctx.llm.stream，provider 取 hostProvider', async () => {
  const settings = settingsWith([
    { provider: 'openai-compatible', mode: 'proxy', hostProvider: 'magpie', model: 'mp-model', apiKeyRef: '' },
  ]);
  const seen = [];
  const llm = {
    stream: (input) => {
      seen.push(input);
      return (async function* () {
        yield { type: 'text', text: 'pong' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  const result = await preflight.preflightFallback({ settings, index: 0, credentials: credentials({}), llm, env: {} });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'proxy');
  assert.equal(seen[0].provider, 'magpie');
  assert.equal(seen[0].model, 'mp-model');
});

test('备选预检：越界下标返回失败而不抛错', async () => {
  const settings = settingsWith([{ provider: 'openai-compatible', model: 'm', baseURL: 'https://a.b/v1', apiKeyRef: 'FB1' }]);
  const result = await preflight.preflightFallback({
    settings,
    index: 5,
    credentials: credentials({ FB1: 'k' }),
    llm: undefined,
    env: {},
    fetchImpl: fakeFetch(() => new Response('{}', { status: 200 })),
  });
  assert.equal(result.ok, false);
  assert.equal(result.index, 5);
});

test('主模型预检与备选互不影响：主 key 缺失但仍能单独预检备选', async () => {
  const settings = settingsWith(
    [{ provider: 'openai-compatible', model: 'gpt-x', baseURL: 'https://api.example.com/v1', apiKeyRef: 'FB1' }],
    { apiKeyRef: 'MAIN_KEY' },
  );
  // 主模型密钥缺失 → 主预检失败
  const mainResult = await preflight.preflightModel({
    settings,
    credentials: credentials({ FB1: 'sk-fb1' }),
    llm: undefined,
    env: {},
    fetchImpl: fakeFetch(() => new Response('{}', { status: 200 })),
  });
  assert.equal(mainResult.ok, false);
  assert.equal(mainResult.code, 'MODEL_KEY_MISSING');
  // 备选仍可成功（自己的 key 在）
  const fbResult = await preflight.preflightFallback({
    settings,
    index: 0,
    credentials: credentials({ FB1: 'sk-fb1' }),
    llm: undefined,
    env: {},
    fetchImpl: fakeFetch(() => new Response('{}', { status: 200 })),
  });
  assert.equal(fbResult.ok, true);
});
