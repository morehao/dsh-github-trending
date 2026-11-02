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

/**
 * 内置的 GitHub OAuth App 公开 client_id（**非机密**：OAuth 的 client_id 设计上就是公开的，
 * 会出现在授权 URL 里，与 `gh`/VS Code 内置自己的 client_id 同理）。
 *
 * ⚠️ 只有 client_id 不够：GitHub 的 web application flow 在换 token 时**仍然要求
 * client_secret**（PKCE 是叠加保护，不能替代，2025-07 起官方也只说「推荐」而非「可免 secret」）。
 * 因此：
 *   - 内置 client_id → 只能走 **device flow**（`resolveMethod` 自动降级），开箱即用；
 *   - 用户自带 OAuth App（`githubClientId` + `githubClientSecret`）→ 才启用回环 web flow。
 * 且 device flow 需要在 OAuth App 设置里勾选启用（本插件内置的 App 已启用）。
 *
 * OAuth App 侧登记的回调：`http://127.0.0.1/api/morehao/github-trending/oauth/github/callback`
 * （loopback 按 RFC 8252 忽略端口，运行时随机端口可正常回跳）。
 */
export const DEFAULT_GITHUB_CLIENT_ID = 'Ov23li7rhp0EKoqbkJKY';

/** 解析生效的 client_id：显式 config 优先，否则用内置默认。 */
export function resolveClientId(deps: GithubAuthDeps): string | undefined {
  const fromConfig = deps.clientId;
  return fromConfig !== undefined && fromConfig !== '' ? fromConfig : DEFAULT_GITHUB_CLIENT_ID;
}

/** 解析生效的 client_secret（没有就返回 undefined，绝不以空串形式发出去）。 */
export function resolveClientSecret(deps: GithubAuthDeps): string | undefined {
  const secret = deps.clientSecret;
  return secret !== undefined && secret !== '' ? secret : undefined;
}

/**
 * 回环（浏览器 web flow）是否可用：GitHub 换 token 必须带 client_secret，
 * 内置的公开 client_id 没有 secret，只能退到设备码。见文件头的说明。
 */
export function isLoopbackSignInAvailable(deps: GithubAuthDeps): boolean {
  return resolveClientSecret(deps) !== undefined;
}

/**
 * 实际要跑的方法：`browser` 需要 client_secret，缺省时自动降级为 `device`（开箱即用）。
 * 显式选择 `device` 的调用不受影响。
 */
export function resolveMethod(deps: GithubAuthDeps, requested: 'browser' | 'device'): 'browser' | 'device' {
  return requested === 'browser' && !isLoopbackSignInAvailable(deps) ? 'device' : requested;
}

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
  /** 核心 0.2.x 有：按 key 查已注册的 flow；判定「真的注册上了」靠它。 */
  describe?: (key: string) => unknown;
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
  /**
   * GitHub OAuth App 的 client_secret。只有自带 OAuth App 的回环 web flow 才需要；
   * 缺省时 `browser` 方法自动降级为 device flow。不进 `settings.json`、不进日志。
   */
  clientSecret?: string;
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
  /** device flow 预填验证码的地址（GitHub 返回的 `verification_uri_complete`）：打开只需点授权。 */
  verificationUriComplete?: string;
  userCode?: string;
  expiresAt?: number;
  login?: string;
  error?: string;
}

interface Attempt {
  phase: GithubAttemptPhase;
  authorizeUrl?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
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

/** 判断一个未知值是否是可直接打开的 http(s) URL（用于校验 GitHub 返回的验证页地址）。 */
export function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value === '') return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' || url.protocol === 'http:';
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

/** 回调落地页的两种结果（纯展示，无外部资源，离线可测）。 */
type CallbackPageKind = 'success' | 'error';

/**
 * 回环回调的落地页 HTML。自包含、无外链资源（CSP 友好、离线可用），
 * 跟随系统深浅色；成功页会尝试自动关闭本窗口（脚本失败时文字兜底）。
 */
export function renderCallbackPage(kind: CallbackPageKind): string {
  const ok = kind === 'success';
  const title = ok ? '登录完成' : '登录未完成';
  const heading = ok ? 'GitHub 授权成功' : 'GitHub 授权失败';
  const body = ok ? '已完成登录，可以关闭此页面。' : '授权校验未通过，请回到 DSH 重新发起登录。';
  const accent = ok ? '#1f883d' : '#cf222e';
  const icon = ok
    ? '<path d="M20 6 9 17l-5-5"/>'
    : '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>';
  const autoClose = ok
    ? '<script>(function(){try{setTimeout(function(){window.close()},1200)}catch(e){}})()</script>'
    : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>
  :root{--bg:#f6f8fa;--card:#ffffff;--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;--accent:${accent}}
  @media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#151b23;--fg:#e6edf3;--muted:#9198a1;--border:#3d444d}}
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;display:flex;align-items:center;justify-content:center;padding:24px;
    background:var(--bg);color:var(--fg);
    font:400 15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
  main{width:100%;max-width:400px;background:var(--card);border:1px solid var(--border);
    border-radius:14px;padding:40px 32px;text-align:center;
    box-shadow:0 8px 24px rgba(0,0,0,.06)}
  .mark{width:64px;height:64px;margin:0 auto 20px;border-radius:50%;display:flex;
    align-items:center;justify-content:center;background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent)}
  .mark svg{width:30px;height:30px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
  h1{margin:0 0 8px;font-size:19px;font-weight:600;letter-spacing:.2px}
  p{margin:0;color:var(--muted);font-size:14px}
</style></head>
<body><main role="status">
  <div class="mark"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></div>
  <h1>${heading}</h1>
  <p>${body}</p>
</main>${autoClose}</body></html>`;
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
  params: { clientId: string; clientSecret?: string; code: string; verifier: string; redirectUri: string },
  signal: AbortSignal | undefined,
): Promise<{ token: string; tokenType?: string; scope?: string }> {
  // GitHub 的 web flow 换 token 必须带 client_secret（PKCE 只是叠加保护）。
  // 没有 secret 的调用会拿到 incorrect_client_credentials，调用方应先 resolveMethod 降级。
  const form = new URLSearchParams({
    client_id: params.clientId,
    code: params.code,
    code_verifier: params.verifier,
    redirect_uri: params.redirectUri,
  });
  if (params.clientSecret !== undefined) form.set('client_secret', params.clientSecret);
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal,
  });
  if (!response.ok) throw new Error(`GitHub access_token HTTP ${response.status}`);
  const body = (await response.json()) as { access_token?: unknown; token_type?: unknown; scope?: unknown; error?: unknown };
  if (typeof body.access_token !== 'string' || body.access_token === '') {
    const error = typeof body.error === 'string' ? body.error : undefined;
    if (error === 'incorrect_client_credentials') {
      // 用户可见文案：直接告诉他下一步该点什么，而不是把 GitHub 的错误码原样抛出去。
      throw new Error(
        params.clientSecret === undefined
          ? 'GitHub 网页授权需要 client_secret（incorrect_client_credentials），内置的公开 client_id 无法完成这一步：请改用设备码登录，或配置自己的 OAuth App client_id + client_secret。'
          : 'GitHub 认为这个 OAuth App 的 client_id / client_secret 不正确（incorrect_client_credentials）：请检查插件配置，或改用设备码登录。',
      );
    }
    throw new Error(`GitHub access_token 未返回 token${error === undefined ? '' : `（${error}）`}`);
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
  const clientId = resolveClientId(deps);
  if (clientId === undefined || clientId === '') throw new Error('缺少 GitHub OAuth client_id');
  const clientSecret = resolveClientSecret(deps);
  if (clientSecret === undefined) {
    // 防御：正常路径已在 resolveMethod 里降到 device；真走到这里说明调用方绕过了。
    throw new Error('回环登录不可用：没有配置 GitHub OAuth App 的 client_secret，请改用设备码登录');
  }
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
        res
          .writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          .end(renderCallbackPage('error'));
        return;
      }
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        .end(renderCallbackPage('success'));
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
    const exchanged = await exchangeCode(
      fetchImpl,
      endpoints.accessToken,
      { clientId, clientSecret, code, verifier, redirectUri },
      session.signal,
    );
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
  const clientId = resolveClientId(deps);
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
    verification_uri_complete?: unknown;
    expires_in?: unknown;
    interval?: unknown;
    error?: unknown;
  };
  if (typeof start.device_code !== 'string' || typeof start.user_code !== 'string' || typeof start.verification_uri !== 'string') {
    const error = typeof start.error === 'string' ? start.error : undefined;
    throw new Error(
      error === 'device_flow_disabled'
        ? 'GitHub 没有为这个 OAuth App 启用设备码登录：请到 OAuth App 设置勾选 Device flow，或改用「本机 gh」/ PAT。'
        : `GitHub device/code 返回不完整${error === undefined ? '' : `（${error}）`}`,
    );
  }
  const deviceCode = start.device_code;
  const intervalSec = typeof start.interval === 'number' && start.interval > 0 ? start.interval : 5;
  const expiresInSec = typeof start.expires_in === 'number' && start.expires_in > 0 ? start.expires_in : 900;
  const deadline = Date.now() + expiresInSec * 1000;

  // 预填验证码的地址：存在且是 http(s) 才采用，否则回退到裸 verification_uri。
  const verificationUriComplete = isHttpUrl(start.verification_uri_complete)
    ? (start.verification_uri_complete as string)
    : undefined;

  updateCurrent({
    phase: 'waiting-device',
    verificationUri: start.verification_uri,
    ...(verificationUriComplete === undefined ? {} : { verificationUriComplete }),
    userCode: start.user_code,
    expiresAt: deadline,
  });
  session.notify?.({
    message: 'Enter this code on the verification page to finish signing in.',
    url: verificationUriComplete ?? start.verification_uri,
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

/** flow 的静态定义（deps 只进 run，注册本身与 deps 无关）。 */
function flowDefinition(deps: GithubAuthDeps): AuthorizationFlow {
  return {
    key: GITHUB_RECORD_KEY,
    label: 'GitHub',
    methods: [
      { id: 'browser', label: 'Sign in with GitHub' },
      { id: 'device', label: 'Use a device code' },
    ],
    run: (session) => (session.method === 'device' ? runDevice(deps, session) : runBrowser(deps, session)),
  };
}

/**
 * 核心没有 `describe()` 时的兜底：按 authorization 实例记「本进程注册过」。
 * 用 WeakSet 而不是布尔值，避免测试/热重载换实例后残留旧结论。
 */
const registeredOn = new WeakSet<object>();
/** 已经明确失败过的实例：registerFlow 只会因 DUPLICATE_FLOW 抛，重试没有意义且会刷日志。 */
const failedOn = new WeakSet<object>();

/** 这个 key 现在是否**真的**有 flow 在注册表里。 */
export function isGithubFlowRegistered(deps: GithubAuthDeps): boolean {
  const authorization = deps.get('authorization') as AuthorizationLike | undefined;
  if (authorization === undefined) return false;
  if (typeof authorization.describe === 'function') {
    try {
      return authorization.describe(GITHUB_RECORD_KEY) !== undefined;
    } catch {
      return registeredOn.has(authorization);
    }
  }
  return registeredOn.has(authorization);
}

/**
 * 幂等注册 GitHub flow；`authorization` 还没就绪时返回 false，调用方可稍后重试。
 *
 * 为什么不能只在 `apply()` 里试一次：宿主按「服务可用性」激活插件，本插件只
 * `inject: ['webServer']`，apply 完全可能早于 `authorization`——后者要等
 * `credentials` 的异步 `[Service.init]`（启动时读 `.credentials.yaml`）走完才
 * 可见，而 `ctx.get()` 对未 active 的 provider 返回 undefined。那一刻若放弃注册，
 * 就永久没有 flow；而可用性又是按请求现算的，于是出现「按钮亮着、点了必然
 * NO_FLOW、界面毫无反馈」。所以注册做成可重入的自愈入口：apply 用
 * `ctx.inject(['authorization'])` 等服务就绪，HTTP 面每次读状态再兜底一次。
 *
 * @returns 注册后是否可用（服务缺失 / 注册失败时为 false）。
 */
export function ensureGithubFlow(deps: GithubAuthDeps): boolean {
  const authorization = deps.get('authorization') as AuthorizationLike | undefined;
  if (authorization === undefined || typeof authorization.registerFlow !== 'function') return false;
  if (isGithubFlowRegistered(deps)) {
    registeredOn.add(authorization);
    return true;
  }
  if (failedOn.has(authorization)) return false;
  try {
    authorization.registerFlow(flowDefinition(deps));
  } catch (error) {
    // DUPLICATE_FLOW 之类：注册表里其实已经有（例如核心没实现 describe），按可用处理。
    failedOn.add(authorization);
    deps.logger?.('auth.flow.failed', {
      key: GITHUB_RECORD_KEY,
      message: error instanceof Error ? error.message : String(error),
    });
    return isGithubFlowRegistered(deps);
  }
  registeredOn.add(authorization);
  deps.logger?.('auth.flow.registered', { key: GITHUB_RECORD_KEY });
  return true;
}

/**
 * 向 `ctx.authorization` 注册 GitHub flow（若核心没有该服务则降级 no-op）。
 * 等价于 {@link ensureGithubFlow}，保留旧名字给 `apply()` 与测试用。
 */
export function registerGithubFlow(deps: GithubAuthDeps): void {
  if (!ensureGithubFlow(deps)) deps.logger?.('auth.flow.skipped', { reason: 'no-authorization-service' });
}

/** 离开 idle 的最长等待：flow 的 run() 同步写首个状态，这里只是防核心实现改变后抢跑。 */
const START_TIMEOUT_MS = 1500;
const START_POLL_MS = 10;

/**
 * 启动一次浏览器登录 attempt（进程内 `authorization.begin`，不阻塞请求）。
 *
 * 返回的视图保证**不是 `idle`**：要么已经进入 waiting-*，要么已经落成 `error`
 * （供路由转成 HTTP 错误）。`idle` 只可能来自「flow 没注册」这类抢跑，前端拿到
 * 它就会以为什么都没发生——那正是「点了没反应」的形态，所以这里把它堵掉。
 *
 * @throws 服务不可用、flow 未注册、已有 attempt 在飞时抛错。
 */
export async function beginGithubSignIn(deps: GithubAuthDeps, method: 'browser' | 'device' = 'browser'): Promise<GithubAttemptView> {
  const authorization = deps.get('authorization') as AuthorizationLike | undefined;
  if (authorization === undefined || typeof authorization.begin !== 'function') {
    throw new Error('authorization 服务不可用：无法进行浏览器登录');
  }
  if (!ensureGithubFlow(deps)) {
    throw new Error('authorization 服务尚未就绪，GitHub 授权流程没有注册成功：请稍后重试');
  }
  if (current !== undefined && (current.phase === 'waiting-browser' || current.phase === 'waiting-device' || current.phase === 'exchanging')) {
    throw new Error('already-in-flight');
  }
  // GitHub 的 web flow 必须有 client_secret；内置 client_id 没有 secret → 自动走设备码。
  const effectiveMethod = resolveMethod(deps, method);
  if (effectiveMethod !== method) {
    deps.logger?.('auth.method.fallback', { from: method, to: effectiveMethod, reason: 'no-client-secret' });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), attemptTimeout(deps));
  const attempt: Attempt = { phase: 'idle', controller, done: Promise.resolve() };
  current = attempt;
  let started: Promise<{ status: 'authorized' | 'cancelled' }>;
  try {
    started = authorization.begin({
      key: GITHUB_RECORD_KEY,
      method: effectiveMethod,
      signal: controller.signal,
      // 浏览器往返靠 authorizeUrl + 回调；notify 只更新内存视图，prompt 不支持（拒绝）。
      interaction: {
        notify: (notice: { message: string; url?: string; code?: string }) => {
          if (notice.code !== undefined && notice.url !== undefined) {
            // runDevice 已在 updateCurrent 里写全（含 verificationUriComplete）；
            // 这里只补 userCode，避免把 complete 地址覆盖成裸 verification_uri。
            updateCurrent({ phase: 'waiting-device', userCode: notice.code });
          } else if (notice.url !== undefined) {
            updateCurrent({ phase: 'waiting-browser', authorizeUrl: notice.url });
          }
        },
        prompt: () => Promise.reject(new Error('interactive prompt unsupported in this surface')),
      },
    });
  } catch (error) {
    // 同步抛（真正的 NO_FLOW 在核心是 promise reject，这里防实现变化）。
    clearTimeout(timer);
    updateCurrent({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
    return attemptView();
  }
  attempt.done = started
    .then((outcome) => {
      if (outcome.status === 'cancelled') updateCurrent({ phase: 'idle' });
    })
    .catch((error: unknown) => {
      updateCurrent({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => clearTimeout(timer));
  await waitForStart(attempt);
  return attemptView();
}

/** 等 attempt 离开 `idle`（正常路径一次微任务内就完成；异常路径最多等 START_TIMEOUT_MS）。 */
async function waitForStart(attempt: Attempt, timeoutMs = START_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (attempt.phase === 'idle' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
  }
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
