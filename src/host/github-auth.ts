/**
 * GitHub 浏览器登录（薄 adapter）。
 *
 * 设计原则：**只补核心缺的那一层，其余全用核心轮子**（见
 * `.dsh/docs/plans/2026-11-01-github-browser-auth-plan.md`）。
 *   - 协议生命周期 / attempt 单飞 / 取消 / 结算 → `ctx.authorization`（核心）
 *   - 回环回调 HTTP 载体 → `ctx.webServer.register({ kind:'exact' })`（核心）
 *   - token 落盘 / 原子写 / 0600 / record 事件 → `ctx.credentials`（核心）
 *   - 交互词汇 notify/prompt → `AuthorizationSession`（核心）
 *
 * 本文件只写 GitHub provider 专有的：client_id、端点、PKCE 三行、state 校验、exchange、
 * grant payload，以及「进程内 begin + 内存 attempt 视图」这点胶水（核心没有给第三方 key
 * 的 authorization HTTP 投影，见阶段 0 核实 R4）。
 *
 * 不 import 任何 `@deepseek-ai/*` 运行时模块：全部走 `get(...)` 的鸭子类型，故不需要新增
 * peerDependency。record 键用字符串 `'github/default'`（与核心包提案同名同构，便于迁移）。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CredentialServices } from './credentials.js';

/** 与核心 `@deepseek-ai/dsh-github-auth` 提案保持同 key；迁移时消费端无需改。 */
export const GITHUB_RECORD_KEY = 'github/default';

/** 本地回调路径（带集成前缀，避免多 provider 撞 webServer 的 `(kind,path)` 唯一约束）。 */
export const CALLBACK_PATH = '/api/morehao/github-trending/oauth/github/callback';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_USER_URL = 'https://api.github.com/user';
/** 本插件运行需要 push / 建 PR，`read:user` 不够；一次授权到 `repo`。 */
export const DEFAULT_SCOPE = 'repo';
/** 单次 attempt 上限（对齐 account-platform 默认量级）。 */
const DEFAULT_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// 核心缝隙的最小鸭子类型（只声明用到的成员）
// ---------------------------------------------------------------------------

export interface AuthorizationFlow {
  key: string;
  label: string;
  methods: Array<{ id: string; label: string }>;
  run: (session: AuthorizationSessionLike) => Promise<void> | void;
}

export interface AuthorizationSessionLike {
  method?: string;
  signal?: AbortSignal;
  notify?: (notice: { message: string; url?: string; code?: string }) => void;
  prompt?: (prompt: unknown) => Promise<unknown>;
  commit?: (record: { kind: 'grant'; payload: unknown }) => Promise<unknown>;
}

export interface AuthorizationLike {
  registerFlow?: (flow: AuthorizationFlow) => unknown;
  begin?: (request: unknown) => Promise<{ status: 'authorized' | 'cancelled' }>;
  cancel?: (key: string) => void;
}

export interface WebServerLike {
  register?: (route: { kind: 'exact'; path: string; handler: (req: any, res: any) => void }) => () => void;
  port?: number;
  host?: string;
}

type FetchLike = typeof fetch;

export interface GithubAuthDeps {
  get: (name: string) => unknown;
  fetchImpl?: FetchLike;
  logger?: (event: string, data?: Record<string, unknown>) => void;
  /** 覆盖端点（测试用）；生产留空走 GitHub 官方。 */
  endpoints?: { authorize?: string; accessToken?: string; deviceCode?: string; user?: string };
  /** GitHub OAuth App 的 public client_id（无需 secret）。 */
  clientId?: string;
  scope?: string;
  attemptTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// attempt 视图（给前端轮询）
// ---------------------------------------------------------------------------

export type GithubAttemptPhase = 'idle' | 'waiting-browser' | 'waiting-device' | 'exchanging' | 'done' | 'error';

export interface GithubAttemptView {
  phase: GithubAttemptPhase;
  authorizeUrl?: string;
  verificationUri?: string;
  userCode?: string;
  expiresAt?: number;
  login?: string;
  error?: string;
}

interface Attempt {
  phase: GithubAttemptPhase;
  authorizeUrl?: string;
  verificationUri?: string;
  userCode?: string;
  expiresAt?: number;
  login?: string;
  error?: string;
  controller: AbortController;
  done: Promise<void>;
}

/** 内存里的单次 attempt（核心没有给第三方 key 的 HTTP 投影，这是那点胶水）。 */
let current: Attempt | undefined;

export function attemptView(): GithubAttemptView {
  if (current === undefined) return { phase: 'idle' };
  const { controller: _c, done: _d, ...view } = current;
  return view;
}

// ---------------------------------------------------------------------------
// 纯函数（离线可测）
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE：返回 verifier 与 S256 challenge。 */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** 常量时间比较 state（长度不等直接 false，避免 timingSafeEqual 抛错）。 */
export function verifyState(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 拼授权页 URL。 */
export function buildAuthorizeUrl(params: {
  authorizeEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL(params.authorizeEndpoint);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', params.scope);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export interface GithubGrantPayload {
  version: 1;
  token: string;
  login?: string;
  tokenType?: string;
  scope?: string;
}

// ---------------------------------------------------------------------------
// 网络交互（注入 fetch，离线可 stub）
// ---------------------------------------------------------------------------

async function exchangeCode(
  fetchImpl: FetchLike,
  endpoint: string,
  params: { clientId: string; code: string; verifier: string; redirectUri: string },
  signal: AbortSignal | undefined,
): Promise<{ token: string; tokenType?: string; scope?: string }> {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: params.clientId,
      code: params.code,
      code_verifier: params.verifier,
      redirect_uri: params.redirectUri,
    }).toString(),
    signal,
  });
  if (!response.ok) throw new Error(`GitHub access_token HTTP ${response.status}`);
  const body = (await response.json()) as { access_token?: unknown; token_type?: unknown; scope?: unknown; error?: unknown };
  if (typeof body.access_token !== 'string' || body.access_token === '') {
    throw new Error(`GitHub access_token 未返回 token${typeof body.error === 'string' ? `（${body.error}）` : ''}`);
  }
  return {
    token: body.access_token,
    ...(typeof body.token_type === 'string' ? { tokenType: body.token_type } : {}),
    ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
  };
}

async function fetchLogin(fetchImpl: FetchLike, endpoint: string, token: string, signal: AbortSignal | undefined): Promise<string | undefined> {
  try {
    const response = await fetchImpl(endpoint, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'dsh-github-trending' },
      signal,
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { login?: unknown };
    return typeof body.login === 'string' ? body.login : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 浏览器 method：PKCE + 回环回调
// ---------------------------------------------------------------------------

async function runBrowser(deps: GithubAuthDeps, session: AuthorizationSessionLike): Promise<void> {
  const webServer = deps.get('webServer') as WebServerLike | undefined;
  if (webServer === undefined || typeof webServer.register !== 'function') {
    throw new Error('webServer 服务不可用：浏览器登录需要它承载 OAuth 回调');
  }
  const clientId = deps.clientId;
  if (clientId === undefined || clientId === '') throw new Error('缺少 GitHub OAuth client_id');
  const fetchImpl = deps.fetchImpl ?? fetch;
  const endpoints = normalizeEndpoints(deps.endpoints);
  const scope = deps.scope ?? DEFAULT_SCOPE;

  const state = base64url(randomBytes(32));
  const { verifier, challenge } = createPkce();

  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  codePromise.catch(() => undefined);

  const dispose = webServer.register({
    kind: 'exact',
    path: CALLBACK_PATH,
    handler: (req: any, res: any) => {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://127.0.0.1');
      } catch {
        res.writeHead(400, { 'cache-control': 'no-store' }).end();
        return;
      }
      const code = url.searchParams.get('code') ?? '';
      const gotState = url.searchParams.get('state') ?? '';
      const single = url.searchParams.getAll('state').length === 1 && url.searchParams.getAll('code').length === 1;
      const bad = req.method !== 'GET' || url.pathname !== CALLBACK_PATH || !single || code === '' || !verifyState(gotState, state);
      if (bad) {
        res.writeHead(400, { 'cache-control': 'no-store' }).end();
        return;
      }
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        .end('<!doctype html><meta charset="utf-8"><title>GitHub</title><p>已完成登录，可以关闭此页面。</p>');
      resolveCode(code);
    },
  });

  try {
    const origin = localOrigin(webServer);
    const redirectUri = `${origin}${CALLBACK_PATH}`;
    const authorizeUrl = buildAuthorizeUrl({
      authorizeEndpoint: endpoints.authorize,
      clientId,
      redirectUri,
      scope,
      state,
      challenge,
    });
    updateCurrent({ phase: 'waiting-browser', authorizeUrl, expiresAt: Date.now() + attemptTimeout(deps) });
    session.notify?.({ message: 'Continue in your browser to sign in to GitHub.', url: authorizeUrl });

    const code = await withAbort(codePromise, session.signal, () => rejectCode(new Error('authorization cancelled')));
    updateCurrent({ phase: 'exchanging' });
    const exchanged = await exchangeCode(fetchImpl, endpoints.accessToken, { clientId, code, verifier, redirectUri }, session.signal);
    const login = await fetchLogin(fetchImpl, endpoints.user, exchanged.token, session.signal);
    const payload: GithubGrantPayload = {
      version: 1,
      token: exchanged.token,
      ...(login === undefined ? {} : { login }),
      tokenType: exchanged.tokenType ?? 'bearer',
      scope: exchanged.scope ?? scope,
    };
    if (typeof session.commit === 'function') await session.commit({ kind: 'grant', payload });
    updateCurrent({ phase: 'done', ...(login === undefined ? {} : { login }) });
  } finally {
    dispose();
  }
}

// ---------------------------------------------------------------------------
// 设备码 method：device flow（远程/无法回环兜底）
// ---------------------------------------------------------------------------

async function runDevice(deps: GithubAuthDeps, session: AuthorizationSessionLike): Promise<void> {
  const clientId = deps.clientId;
  if (clientId === undefined || clientId === '') throw new Error('缺少 GitHub OAuth client_id');
  const fetchImpl = deps.fetchImpl ?? fetch;
  const endpoints = normalizeEndpoints(deps.endpoints);
  const scope = deps.scope ?? DEFAULT_SCOPE;

  const startResponse = await fetchImpl(endpoints.deviceCode, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope }).toString(),
    signal: session.signal,
  });
  if (!startResponse.ok) throw new Error(`GitHub device/code HTTP ${startResponse.status}`);
  const start = (await startResponse.json()) as {
    device_code?: unknown;
    user_code?: unknown;
    verification_uri?: unknown;
    expires_in?: unknown;
    interval?: unknown;
  };
  if (typeof start.device_code !== 'string' || typeof start.user_code !== 'string' || typeof start.verification_uri !== 'string') {
    throw new Error('GitHub device/code 返回不完整');
  }
  const deviceCode = start.device_code;
  const intervalSec = typeof start.interval === 'number' && start.interval > 0 ? start.interval : 5;
  const expiresInSec = typeof start.expires_in === 'number' && start.expires_in > 0 ? start.expires_in : 900;
  const deadline = Date.now() + expiresInSec * 1000;

  updateCurrent({
    phase: 'waiting-device',
    verificationUri: start.verification_uri,
    userCode: start.user_code,
    expiresAt: deadline,
  });
  session.notify?.({
    message: 'Enter this code on the verification page to finish signing in.',
    url: start.verification_uri,
    code: start.user_code,
  });

  let waitMs = intervalSec * 1000;
  while (Date.now() < deadline) {
    await sleep(waitMs, session.signal);
    const pollResponse = await fetchImpl(endpoints.accessToken, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
      signal: session.signal,
    });
    if (!pollResponse.ok) throw new Error(`GitHub access_token HTTP ${pollResponse.status}`);
    const poll = (await pollResponse.json()) as {
      access_token?: unknown;
      token_type?: unknown;
      scope?: unknown;
      error?: unknown;
      interval?: unknown;
    };
    if (typeof poll.access_token === 'string' && poll.access_token !== '') {
      updateCurrent({ phase: 'exchanging' });
      const login = await fetchLogin(fetchImpl, endpoints.user, poll.access_token, session.signal);
      const payload: GithubGrantPayload = {
        version: 1,
        token: poll.access_token,
        ...(login === undefined ? {} : { login }),
        tokenType: typeof poll.token_type === 'string' ? poll.token_type : 'bearer',
        scope: typeof poll.scope === 'string' ? poll.scope : scope,
      };
      if (typeof session.commit === 'function') await session.commit({ kind: 'grant', payload });
      updateCurrent({ phase: 'done', ...(login === undefined ? {} : { login }) });
      return;
    }
    if (poll.error === 'authorization_pending') continue;
    if (poll.error === 'slow_down') {
      waitMs += (typeof poll.interval === 'number' && poll.interval > 0 ? poll.interval : 5) * 1000;
      continue;
    }
    // access_denied / expired_token / 其它：终止 attempt（核心按抛错结算）。
    throw new Error(`GitHub device flow 终止：${typeof poll.error === 'string' ? poll.error : 'unknown'}`);
  }
  throw new Error('GitHub device flow 超时');
}

// ---------------------------------------------------------------------------
// 注册 + 进程内 begin / cancel 胶水
// ---------------------------------------------------------------------------

/**
 * 向 `ctx.authorization` 注册 GitHub flow（若核心没有该服务则降级 no-op）。
 * 在 `apply()` 里调用一次。
 */
export function registerGithubFlow(deps: GithubAuthDeps): void {
  const authorization = deps.get('authorization') as AuthorizationLike | undefined;
  if (authorization === undefined || typeof authorization.registerFlow !== 'function') {
    deps.logger?.('auth.flow.skipped', { reason: 'no-authorization-service' });
    return;
  }
  authorization.registerFlow({
    key: GITHUB_RECORD_KEY,
    label: 'GitHub',
    methods: [
      { id: 'browser', label: 'Sign in with GitHub' },
      { id: 'device', label: 'Use a device code' },
    ],
    run: (session) => (session.method === 'device' ? runDevice(deps, session) : runBrowser(deps, session)),
  });
  deps.logger?.('auth.flow.registered', { key: GITHUB_RECORD_KEY });
}

/**
 * 启动一次浏览器登录 attempt（进程内 `authorization.begin`，不阻塞请求）。
 * @returns 当前 attempt 视图（含 authorizeUrl，供前端打开）。二次调用在已有进行中时抛错。
 */
export async function beginGithubSignIn(deps: GithubAuthDeps, method: 'browser' | 'device' = 'browser'): Promise<GithubAttemptView> {
  const authorization = deps.get('authorization') as AuthorizationLike | undefined;
  if (authorization === undefined || typeof authorization.begin !== 'function') {
    throw new Error('authorization 服务不可用：无法进行浏览器登录');
  }
  if (current !== undefined && (current.phase === 'waiting-browser' || current.phase === 'waiting-device' || current.phase === 'exchanging')) {
    throw new Error('already-in-flight');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), attemptTimeout(deps));
  const attempt: Attempt = { phase: 'idle', controller, done: Promise.resolve() };
  current = attempt;
  attempt.done = authorization
    .begin!({
      key: GITHUB_RECORD_KEY,
      method,
      signal: controller.signal,
      // 浏览器往返靠 authorizeUrl + 回调；notify 只更新内存视图，prompt 不支持（拒绝）。
      interaction: {
        notify: (notice: { message: string; url?: string; code?: string }) => {
          if (notice.code !== undefined && notice.url !== undefined) {
            updateCurrent({ phase: 'waiting-device', verificationUri: notice.url, userCode: notice.code });
          } else if (notice.url !== undefined) {
            updateCurrent({ phase: 'waiting-browser', authorizeUrl: notice.url });
          }
        },
        prompt: () => Promise.reject(new Error('interactive prompt unsupported in this surface')),
      },
    })
    .then((outcome) => {
      if (outcome.status === 'cancelled') updateCurrent({ phase: 'idle' });
    })
    .catch((error: unknown) => {
      updateCurrent({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => clearTimeout(timer));
  // 让 run() 有机会把 authorizeUrl 写进视图（begin 内部先走 run 的同步段）。
  await Promise.resolve();
  return attemptView();
}

/** 取消进行中的 attempt。 */
export function cancelGithubSignIn(deps: GithubAuthDeps): void {
  const authorization = deps.get('authorization') as AuthorizationLike | undefined;
  if (authorization !== undefined && typeof authorization.cancel === 'function') {
    authorization.cancel(GITHUB_RECORD_KEY);
  }
  if (current !== undefined) current.controller.abort();
}

/** 仅测试用：清空内存 attempt。 */
export function resetAttemptForTest(): void {
  current = undefined;
}

// ---------------------------------------------------------------------------
// 内部小工具
// ---------------------------------------------------------------------------

function normalizeEndpoints(endpoints: GithubAuthDeps['endpoints'] = {}): {
  authorize: string;
  accessToken: string;
  deviceCode: string;
  user: string;
} {
  return {
    authorize: endpoints?.authorize ?? AUTHORIZE_URL,
    accessToken: endpoints?.accessToken ?? ACCESS_TOKEN_URL,
    deviceCode: endpoints?.deviceCode ?? DEVICE_CODE_URL,
    user: endpoints?.user ?? GITHUB_USER_URL,
  };
}

function attemptTimeout(deps: GithubAuthDeps): number {
  return typeof deps.attemptTimeoutMs === 'number' && deps.attemptTimeoutMs > 0 ? deps.attemptTimeoutMs : DEFAULT_ATTEMPT_TIMEOUT_MS;
}

/** 本机回环 origin：取自 webServer 实际监听端口，不硬编码。 */
function localOrigin(webServer: WebServerLike): string {
  const port = webServer.port;
  if (typeof port !== 'number' || port <= 0) throw new Error('webServer 尚未监听，无法确定回调地址');
  const host = typeof webServer.host === 'string' && webServer.host !== '' ? webServer.host : '127.0.0.1';
  const loopback = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${loopback}:${port}`;
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    onAbort();
    return Promise.reject(new Error('authorization cancelled'));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      onAbort();
      reject(new Error('authorization cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('authorization cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      reject(new Error('authorization cancelled'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function updateCurrent(patch: Partial<GithubAttemptView>): void {
  if (current === undefined) return;
  Object.assign(current, patch);
}
