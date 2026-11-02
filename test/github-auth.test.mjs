import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubAuth, credentials, config } from '../lib/internal.js';

const EP = {
  authorize: 'https://github.test/login/oauth/authorize',
  accessToken: 'https://github.test/login/oauth/access_token',
  deviceCode: 'https://github.test/login/device/code',
  user: 'https://api.github.test/user',
};

// --- 桩：webServer（捕获 exact 路由 handler）+ 可注入 fetch ---
function makeWebServer() {
  const routes = new Map();
  return {
    port: 41234,
    host: '127.0.0.1',
    register(route) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
    routes,
  };
}

function makeAuthorization() {
  const registered = new Map();
  return {
    registered,
    registerFlow(flow) {
      registered.set(flow.key, flow);
      return () => registered.delete(flow.key);
    },
    async begin(request) {
      const flow = registered.get(request.key);
      const session = {
        method: request.method,
        signal: request.signal,
        notify: (n) => request.interaction?.notify?.(n),
        prompt: (p) => request.interaction?.prompt?.(p),
        commit: async (record) => {
          // 记录提交，供断言
          request._committed = record;
        },
      };
      try {
        await flow.run(session);
        request._committed = request._committed; // keep
        return { status: 'authorized' };
      } catch (error) {
        // 真实核心：非“人拒绝”的错误会 re-throw 给 begin 调用方（这里 fake 也 re-throw）。
        if (request.signal?.aborted === true) return { status: 'cancelled' };
        throw error;
      }
    },
    cancel() {},
  };
}

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

test('credentials.resolveGithubToken：browser 模式读到 grant 记录 → 返回 token/source', async () => {
  const services = {
    resolve: async () => undefined,
    readRecord: async (key) =>
      key === 'github/default' ? { kind: 'grant', payload: { version: 1, token: 'ghu_abc' } } : undefined,
  };
  const resolved = await credentials.resolveGithubToken(services, 'browser', 'GITHUB_TOKEN', { env: {} });
  assert.equal(resolved.token, 'ghu_abc');
  assert.equal(resolved.source, 'github-browser');
});

test('credentials.resolveGithubToken：browser 无记录 → 降级 ref/env', async () => {
  const services = {
    resolve: async () => undefined,
    readRecord: async () => undefined,
  };
  const resolved = await credentials.resolveGithubToken(services, 'browser', 'GITHUB_TOKEN', {
    env: { GITHUB_TOKEN: 'ghp_env' },
  });
  assert.equal(resolved.token, 'ghp_env');
  assert.equal(resolved.source, 'env');
});

test('credentials.resolveGithubToken：browser 但服务无 readRecord → 不崩，降级', async () => {
  const resolved = await credentials.resolveGithubToken(
    { resolve: async () => undefined },
    'browser',
    'GITHUB_TOKEN',
    { env: {} },
  );
  assert.equal(resolved.token, undefined);
  assert.equal(resolved.source, 'none');
});

test('config.normalizeSettings：authMode=browser 不被吞成 gh', () => {
  const normalized = config.normalizeSettings({ github: { authMode: 'browser', tokenRef: 'GITHUB_TOKEN' } });
  assert.equal(normalized.github.authMode, 'browser');
  // 旧值 device 仍迁移为 gh
  const legacy = config.normalizeSettings({ github: { authMode: 'device' } });
  assert.equal(legacy.github.authMode, 'gh');
});

test('githubAuth：PKCE 生成合法 verifier/challenge', () => {
  const { verifier, challenge } = githubAuth.createPkce();
  assert.ok(verifier.length >= 43);
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(verifier, challenge);
});

test('githubAuth：verifyState 常量时间比较', () => {
  assert.equal(githubAuth.verifyState('abc', 'abc'), true);
  assert.equal(githubAuth.verifyState('abc', 'abd'), false);
  assert.equal(githubAuth.verifyState('abc', 'abcd'), false);
});

test('githubAuth：buildAuthorizeUrl 带齐 PKCE 参数', () => {
  const url = new URL(
    githubAuth.buildAuthorizeUrl({
      authorizeEndpoint: EP.authorize,
      clientId: 'cid',
      redirectUri: 'http://127.0.0.1:1/cb',
      scope: 'repo',
      state: 'st',
      challenge: 'ch',
    }),
  );
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'ch');
  assert.equal(url.searchParams.get('state'), 'st');
  assert.equal(url.searchParams.get('scope'), 'repo');
});

test('registerGithubFlow：无 authorization 服务 → no-op 不抛', () => {
  githubAuth.registerGithubFlow({ get: () => undefined, logger: () => {} });
});

test('githubAuth.beginGithubSignIn：浏览器 flow 成功 → 带 client_secret + PKCE，commit grant', async () => {
  githubAuth.resetAttemptForTest();
  const webServer = makeWebServer();
  const authorization = makeAuthorization();
  let exchangeBody;
  const fetchImpl = async (url, init) => {
    if (url === EP.accessToken) {
      exchangeBody = new URLSearchParams(String(init?.body ?? ''));
      return jsonResponse({ access_token: 'ghu_new', token_type: 'bearer', scope: 'repo' });
    }
    if (url === EP.user) return jsonResponse({ login: 'octocat' });
    throw new Error(`unexpected ${url}`);
  };
  const deps = {
    get: (name) => (name === 'webServer' ? webServer : name === 'authorization' ? authorization : undefined),
    fetchImpl,
    endpoints: EP,
    clientId: 'cid',
    clientSecret: 'csecret',
    logger: () => {},
  };
  githubAuth.registerGithubFlow(deps);

  // 二次构造函数：beginGithubSignIn 走 authorization.begin → flow.run → 注册回调。
  const beginPromise = githubAuth.beginGithubSignIn(deps, 'browser');
  // 让 run 跑到 notify（注册回调 + authorizeUrl 写入视图）
  await new Promise((r) => setImmediate(r));

  // 从 notify 里拿到的 authorizeUrl 提取 state，模拟 GitHub 回调
  const view = githubAuth.attemptView();
  assert.ok(view.authorizeUrl, 'should have authorizeUrl');
  const state = new URL(view.authorizeUrl).searchParams.get('state');
  const handler = [...webServer.routes.values()][0];
  assert.ok(handler, 'callback route registered');
  let statusCode = 0;
  const res = { writeHead(c) { statusCode = c; return this; }, end() { return this; } };
  handler({ method: 'GET', url: `${githubAuth.CALLBACK_PATH}?code=thecode&state=${state}` }, res);

  await beginPromise;
  // 等 flow.run 收尾
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(statusCode, 200);
  // GitHub 换 token 必须带 client_secret；PKCE 的 verifier 也要一起发。
  assert.equal(exchangeBody.get('client_secret'), 'csecret');
  assert.equal(exchangeBody.get('code'), 'thecode');
  assert.ok((exchangeBody.get('code_verifier') ?? '').length >= 43);
});

test('githubAuth：回调 state 不匹配 → 400 且不放行', async () => {
  githubAuth.resetAttemptForTest();
  const webServer = makeWebServer();
  const authorization = makeAuthorization();
  const deps = {
    get: (name) => (name === 'webServer' ? webServer : name === 'authorization' ? authorization : undefined),
    fetchImpl: async () => {
      throw new Error('should not exchange');
    },
    endpoints: EP,
    clientId: 'cid',
    clientSecret: 'csecret',
    logger: () => {},
  };
  githubAuth.registerGithubFlow(deps);
  void githubAuth.beginGithubSignIn(deps, 'browser');
  await new Promise((r) => setImmediate(r));
  const handler = [...webServer.routes.values()][0];
  let statusCode = 0;
  const res = { writeHead(c) { statusCode = c; return this; }, end() { return this; } };
  handler({ method: 'GET', url: `${githubAuth.CALLBACK_PATH}?code=x&state=WRONG` }, res);
  assert.equal(statusCode, 400);
  githubAuth.cancelGithubSignIn(deps);
});

test('githubAuth.resolveMethod：没有 client_secret 时 browser 降级为 device', () => {
  const base = { get: () => undefined };
  assert.equal(githubAuth.resolveMethod(base, 'browser'), 'device');
  assert.equal(githubAuth.resolveMethod({ ...base, clientSecret: 's' }, 'browser'), 'browser');
  assert.equal(githubAuth.resolveMethod(base, 'device'), 'device');
  assert.equal(githubAuth.isLoopbackSignInAvailable({ get: () => undefined, clientSecret: '' }), false);
  assert.equal(githubAuth.isLoopbackSignInAvailable({ get: () => undefined, clientSecret: 's' }), true);
});

test('githubAuth：没有 client_secret 时 browser 自动走设备码（不开回环回调）', async () => {
  githubAuth.resetAttemptForTest();
  const webServer = makeWebServer();
  const authorization = makeAuthorization();
  let deviceRequests = 0;
  const fetchImpl = async (url) => {
    if (url === EP.deviceCode) {
      deviceRequests += 1;
      return jsonResponse({ device_code: 'dev', user_code: 'ABCD-1234', verification_uri: 'https://github.test/device', verification_uri_complete: 'https://github.test/device?user_code=ABCD-1234', expires_in: 30, interval: 60 });
    }
    throw new Error(`unexpected ${url}`);
  };
  const deps = {
    get: (name) => (name === 'webServer' ? webServer : name === 'authorization' ? authorization : undefined),
    fetchImpl,
    endpoints: EP,
    clientId: 'cid',
    logger: () => {},
  };
  githubAuth.registerGithubFlow(deps);
  const view = await githubAuth.beginGithubSignIn(deps, 'browser');
  assert.equal(view.phase, 'waiting-device');
  assert.equal(view.userCode, 'ABCD-1234');
  assert.equal(view.verificationUri, 'https://github.test/device');
  assert.equal(view.verificationUriComplete, 'https://github.test/device?user_code=ABCD-1234', '优先透出预填验证码的 complete 地址');
  assert.equal(view.authorizeUrl, undefined, '不该再给 web flow 的授权链接');
  assert.equal(deviceRequests, 1);
  assert.equal(webServer.routes.size, 0, '设备码流程不注册回环回调');
  githubAuth.cancelGithubSignIn(deps);
  await new Promise((r) => setTimeout(r, 10));
});

test('githubAuth：device 缺 verification_uri_complete 时回退到裸 verification_uri', async () => {
  githubAuth.resetAttemptForTest();
  const webServer = makeWebServer();
  const authorization = makeAuthorization();
  const fetchImpl = async (url) => {
    if (url === EP.deviceCode) {
      return jsonResponse({ device_code: 'dev', user_code: 'ZZZZ-0000', verification_uri: 'https://github.test/device', expires_in: 30, interval: 60 });
    }
    throw new Error(`unexpected ${url}`);
  };
  const deps = {
    get: (name) => (name === 'webServer' ? webServer : name === 'authorization' ? authorization : undefined),
    fetchImpl,
    endpoints: EP,
    clientId: 'cid',
    logger: () => {},
  };
  githubAuth.registerGithubFlow(deps);
  const view = await githubAuth.beginGithubSignIn(deps, 'browser');
  assert.equal(view.phase, 'waiting-device');
  assert.equal(view.verificationUri, 'https://github.test/device');
  assert.equal(view.verificationUriComplete, undefined, '没有 complete 时不透出该字段');
  githubAuth.cancelGithubSignIn(deps);
  await new Promise((r) => setTimeout(r, 10));
});

test('githubAuth：非 http(s) 的 verification_uri_complete 被丢弃', async () => {
  githubAuth.resetAttemptForTest();
  const webServer = makeWebServer();
  const authorization = makeAuthorization();
  const fetchImpl = async (url) => {
    if (url === EP.deviceCode) {
      return jsonResponse({ device_code: 'dev', user_code: 'ZZZZ-0000', verification_uri: 'https://github.test/device', verification_uri_complete: 'javascript:alert(1)', expires_in: 30, interval: 60 });
    }
    throw new Error(`unexpected ${url}`);
  };
  const deps = {
    get: (name) => (name === 'webServer' ? webServer : name === 'authorization' ? authorization : undefined),
    fetchImpl,
    endpoints: EP,
    clientId: 'cid',
    logger: () => {},
  };
  githubAuth.registerGithubFlow(deps);
  const view = await githubAuth.beginGithubSignIn(deps, 'browser');
  assert.equal(view.verificationUriComplete, undefined);
  githubAuth.cancelGithubSignIn(deps);
  await new Promise((r) => setTimeout(r, 10));
});

test('githubAuth：client_secret 被 GitHub 拒绝 → 错误文案指向检查配置', async () => {
  githubAuth.resetAttemptForTest();
  const webServer = makeWebServer();
  const authorization = makeAuthorization();
  const fetchImpl = async (url) => {
    if (url === EP.accessToken) return jsonResponse({ error: 'incorrect_client_credentials' });
    throw new Error(`unexpected ${url}`);
  };
  const deps = {
    get: (name) => (name === 'webServer' ? webServer : name === 'authorization' ? authorization : undefined),
    fetchImpl,
    endpoints: EP,
    clientId: 'cid',
    clientSecret: 'wrong',
    logger: () => {},
  };
  githubAuth.registerGithubFlow(deps);
  const beginPromise = githubAuth.beginGithubSignIn(deps, 'browser');
  await new Promise((r) => setImmediate(r));
  const state = new URL(githubAuth.attemptView().authorizeUrl).searchParams.get('state');
  const handler = [...webServer.routes.values()][0];
  const res = { writeHead() { return this; }, end() { return this; } };
  handler({ method: 'GET', url: `${githubAuth.CALLBACK_PATH}?code=thecode&state=${state}` }, res);
  await beginPromise;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(githubAuth.attemptView().phase, 'error');
  assert.match(githubAuth.attemptView().error ?? '', /client_id \/ client_secret/);
});

test('githubAuth device flow：pending → 成功 → commit', async () => {
  githubAuth.resetAttemptForTest();
  const webServer = makeWebServer();
  const authorization = makeAuthorization();
  let polls = 0;
  const fetchImpl = async (url) => {
    if (url === EP.deviceCode) {
      return jsonResponse({ device_code: 'dev', user_code: 'ABCD-1234', verification_uri: 'https://github.test/device', expires_in: 30, interval: 0.005 });
    }
    if (url === EP.accessToken) {
      polls += 1;
      if (polls < 2) return jsonResponse({ error: 'authorization_pending' });
      return jsonResponse({ access_token: 'ghu_dev', token_type: 'bearer', scope: 'repo' });
    }
    if (url === EP.user) return jsonResponse({ login: 'devuser' });
    throw new Error(`unexpected ${url}`);
  };
  const deps = {
    get: (name) => (name === 'webServer' ? webServer : name === 'authorization' ? authorization : undefined),
    fetchImpl,
    endpoints: EP,
    clientId: 'cid',
    logger: () => {},
  };
  githubAuth.registerGithubFlow(deps);
  await githubAuth.beginGithubSignIn(deps, 'device');
  // 等轮询完成
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
    if (githubAuth.attemptView().phase === 'done' || githubAuth.attemptView().phase === 'error') break;
  }
  const view = githubAuth.attemptView();
  assert.equal(view.phase, 'done');
  assert.equal(view.login, 'devuser');
  assert.ok(polls >= 2);
});

test('githubAuth device flow：access_denied → 抛错（核心结算 cancelled）', async () => {
  githubAuth.resetAttemptForTest();
  const webServer = makeWebServer();
  const authorization = makeAuthorization();
  const fetchImpl = async (url) => {
    if (url === EP.deviceCode) {
      return jsonResponse({ device_code: 'dev', user_code: 'ZZZZ', verification_uri: 'https://github.test/device', expires_in: 30, interval: 0.005 });
    }
    if (url === EP.accessToken) return jsonResponse({ error: 'access_denied' });
    throw new Error(`unexpected ${url}`);
  };
  const deps = {
    get: (name) => (name === 'webServer' ? webServer : name === 'authorization' ? authorization : undefined),
    fetchImpl,
    endpoints: EP,
    clientId: 'cid',
    logger: () => {},
  };
  githubAuth.registerGithubFlow(deps);
  await githubAuth.beginGithubSignIn(deps, 'device');
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
    if (githubAuth.attemptView().phase === 'error' || githubAuth.attemptView().phase === 'done') break;
  }
  assert.equal(githubAuth.attemptView().phase, 'error');
});

test('githubAuth.resolveClientId：无 config 时回退内置默认 client_id', () => {
  assert.equal(githubAuth.resolveClientId({ get: () => undefined }), githubAuth.DEFAULT_GITHUB_CLIENT_ID);
  assert.equal(githubAuth.resolveClientId({ get: () => undefined, clientId: 'override-id' }), 'override-id');
  assert.equal(githubAuth.resolveClientId({ get: () => undefined, clientId: '' }), githubAuth.DEFAULT_GITHUB_CLIENT_ID);
  // 内置默认是公开值（非空、非 secret 形态）
  assert.match(githubAuth.DEFAULT_GITHUB_CLIENT_ID, /^Ov23li/);
});

// --- 回归：apply 时 authorization 还没就绪导致的「按钮亮着、点了没反应」 ---

/** 带 describe 的最小 authorization 桩：能观察「注册了几次」与「begin 抛错」。 */
function makeAuthorizationStub(options = {}) {
  const flows = new Map();
  const stub = {
    flows,
    registrations: 0,
    registerFlow(flow) {
      stub.registrations += 1;
      flows.set(flow.key, flow);
      return () => flows.delete(flow.key);
    },
    async begin(request) {
      if (options.beginError !== undefined) throw new Error(options.beginError);
      if (!flows.has(request.key)) throw new Error(`no authorization flow is registered for "${request.key}"`);
      return { status: 'cancelled' };
    },
    cancel() {},
  };
  if (options.describe !== false) stub.describe = (key) => flows.get(key);
  return stub;
}

test('ensureGithubFlow：服务晚到 → 先 false 后 true，且重复调用只注册一次', () => {
  const stub = makeAuthorizationStub();
  let service;
  const deps = { get: (name) => (name === 'authorization' ? service : undefined), logger: () => {} };
  assert.equal(githubAuth.isGithubFlowRegistered(deps), false);
  assert.equal(githubAuth.ensureGithubFlow(deps), false, '服务未就绪时返回 false，且不抛');
  service = stub;
  assert.equal(githubAuth.ensureGithubFlow(deps), true);
  assert.equal(githubAuth.ensureGithubFlow(deps), true);
  assert.equal(stub.registrations, 1, '重复 ensure 不能再注册一次（核心会 DUPLICATE_FLOW）');
  assert.equal(githubAuth.isGithubFlowRegistered(deps), true);
});

test('ensureGithubFlow：没有 describe 的核心用实例级兜底判定', () => {
  const stub = makeAuthorizationStub({ describe: false });
  const deps = { get: (name) => (name === 'authorization' ? stub : undefined), logger: () => {} };
  assert.equal(githubAuth.isGithubFlowRegistered(deps), false);
  assert.equal(githubAuth.ensureGithubFlow(deps), true);
  assert.equal(githubAuth.isGithubFlowRegistered(deps), true);
});

test('beginGithubSignIn：核心 begin 失败时落成 error（绝不返回 idle）', async () => {
  githubAuth.resetAttemptForTest();
  const stub = makeAuthorizationStub({ beginError: 'no authorization flow is registered for "github/default"' });
  const deps = { get: (name) => (name === 'authorization' ? stub : undefined), logger: () => {} };
  const view = await githubAuth.beginGithubSignIn(deps, 'browser');
  assert.equal(view.phase, 'error');
  assert.match(String(view.error), /no authorization flow/);
  // 再点一次仍然给出 error，而不是回到「什么都没发生」
  const again = await githubAuth.beginGithubSignIn(deps, 'browser');
  assert.equal(again.phase, 'error');
  githubAuth.resetAttemptForTest();
});

test('beginGithubSignIn：没有 authorization 服务 → 抛错而不是静默', async () => {
  githubAuth.resetAttemptForTest();
  await assert.rejects(() => githubAuth.beginGithubSignIn({ get: () => undefined }, 'browser'), /authorization/);
});

test('renderCallbackPage：成功/错误页自包含、无外链、文案正确', () => {
  const ok = githubAuth.renderCallbackPage('success');
  assert.match(ok, /<!doctype html>/i);
  assert.match(ok, /GitHub 授权成功/);
  assert.match(ok, /已完成登录/);
  assert.match(ok, /prefers-color-scheme:dark/);
  assert.match(ok, /window\.close/);
  const bad = githubAuth.renderCallbackPage('error');
  assert.match(bad, /GitHub 授权失败/);
  assert.doesNotMatch(bad, /window\.close/);
  // 无外部资源：不出现 http(s):// 引用（避免离线/CSP 抖动）
  assert.doesNotMatch(ok, /(src|href)\s*=\s*["']?https?:/i);
  assert.doesNotMatch(bad, /(src|href)\s*=\s*["']?https?:/i);
});
