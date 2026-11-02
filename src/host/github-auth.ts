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
/** 与核心 `@deepseek-ai/dsh-github-auth` 提案保持同 key；迁移时消费端无需改。 */
export const GITHUB_RECORD_KEY = 'github/default';

/**
 * 内置的 GitHub OAuth App 公开 client_id（**非机密**：OAuth 的 client_id 设计上就是公开的，
 * 会出现在授权 URL 里，与 `gh`/VS Code 内置自己的 client_id 同理）。
 *
 * 只走 **device flow**：GitHub 的 web application flow 换 token 必须带 client_secret，
 * 而客户端不能内置机密，故本插件不实现回环 web flow（也不支持自带 OAuth App 的 secret）。
 * device flow 需要在 OAuth App 设置里勾选启用（本插件内置的 App 已启用）。
 */
export const DEFAULT_GITHUB_CLIENT_ID = 'Ov23li7rhp0EKoqbkJKY';

/** 解析生效的 client_id：显式 config 优先，否则用内置默认（device flow 允许自定义 client_id）。 */
export function resolveClientId(deps: GithubAuthDeps): string | undefined {
  const fromConfig = deps.clientId;
  return fromConfig !== undefined && fromConfig !== '' ? fromConfig : DEFAULT_GITHUB_CLIENT_ID;
}

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
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

type FetchLike = typeof fetch;

export interface GithubAuthDeps {
  get: (name: string) => unknown;
  fetchImpl?: FetchLike;
  logger?: (event: string, data?: Record<string, unknown>) => void;
  /** 覆盖端点（测试用）；生产留空走 GitHub 官方。 */
  endpoints?: { accessToken?: string; deviceCode?: string; user?: string };
  /** GitHub OAuth App 的 public client_id（device flow 用；无需 secret）。 */
  clientId?: string;
  scope?: string;
  attemptTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// attempt 视图（给前端轮询）
// ---------------------------------------------------------------------------

export type GithubAttemptPhase = 'idle' | 'waiting-device' | 'exchanging' | 'done' | 'error';

export interface GithubAttemptView {
  phase: GithubAttemptPhase;
  verificationUri?: string;
  userCode?: string;
  expiresAt?: number;
  login?: string;
  error?: string;
}

interface Attempt {
  phase: GithubAttemptPhase;
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
// 网络交互（注入 fetch，离线可 stub）
// ---------------------------------------------------------------------------

interface GithubGrantPayload {
  version: 1;
  token: string;
  login?: string;
  tokenType?: string;
  scope?: string;
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
// 设备码 method：device flow
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

/** flow 的静态定义（deps 只进 run，注册本身与 deps 无关）。 */
function flowDefinition(deps: GithubAuthDeps): AuthorizationFlow {
  return {
    key: GITHUB_RECORD_KEY,
    label: 'GitHub',
    methods: [{ id: 'device', label: 'Use a device code' }],
    run: (session) => runDevice(deps, session),
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
export async function beginGithubSignIn(deps: GithubAuthDeps): Promise<GithubAttemptView> {
  const authorization = deps.get('authorization') as AuthorizationLike | undefined;
  if (authorization === undefined || typeof authorization.begin !== 'function') {
    throw new Error('authorization 服务不可用：无法进行 GitHub 登录');
  }
  if (!ensureGithubFlow(deps)) {
    throw new Error('authorization 服务尚未就绪，GitHub 授权流程没有注册成功：请稍后重试');
  }
  if (current !== undefined && (current.phase === 'waiting-device' || current.phase === 'exchanging')) {
    throw new Error('already-in-flight');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), attemptTimeout(deps));
  const attempt: Attempt = { phase: 'idle', controller, done: Promise.resolve() };
  current = attempt;
  let started: Promise<{ status: 'authorized' | 'cancelled' }>;
  try {
    started = authorization.begin({
      key: GITHUB_RECORD_KEY,
      method: 'device',
      signal: controller.signal,
      // 设备码：notify 只更新内存视图；prompt 不支持（拒绝）。
      interaction: {
        notify: (notice: { message: string; url?: string; code?: string }) => {
          if (notice.code !== undefined) {
            // runDevice 已写全 verificationUri，这里只补 userCode。
            updateCurrent({ phase: 'waiting-device', userCode: notice.code });
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
  accessToken: string;
  deviceCode: string;
  user: string;
} {
  return {
    accessToken: endpoints?.accessToken ?? ACCESS_TOKEN_URL,
    deviceCode: endpoints?.deviceCode ?? DEVICE_CODE_URL,
    user: endpoints?.user ?? GITHUB_USER_URL,
  };
}

function attemptTimeout(deps: GithubAuthDeps): number {
  return typeof deps.attemptTimeoutMs === 'number' && deps.attemptTimeoutMs > 0 ? deps.attemptTimeoutMs : DEFAULT_ATTEMPT_TIMEOUT_MS;
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
