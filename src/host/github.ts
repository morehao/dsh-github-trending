/**
 * GitHub 认证探测：供设置页「测试认证」按钮调用。
 *
 * 只做一次 `GET https://api.github.com/user`，把「有没有 token、token 是否有效」
 * 一次性验证清楚并回显登录账号；token 不进日志、不进响应明文。
 */
import type { CredentialServices } from './credentials.js';
import { resolveGithubToken } from './credentials.js';

/**
 * 失败类别：仅用于界面区分「该去修哪」，对外错误码仍是 `GITHUB_AUTH`。
 * - auth    token 无效 / 权限不足（HTTP 4xx）或没取到凭据；
 * - tls     连 GitHub 的 TLS 证书校验失败（常见于系统级加速器/代理做 TLS 中间人）；
 * - network DNS / 连接 / 其它出站失败；
 * - timeout 请求超时。
 */
export type GithubProbeCategory = 'auth' | 'network' | 'tls' | 'timeout';

export interface GithubProbeResult {
  ok: boolean;
  login?: string;
  /** token 来源（gh / env / credentials）。 */
  source?: string;
  code?: string;
  category?: GithubProbeCategory;
  message?: string;
}

/** TLS 证书校验失败相关的 Node/undici 错误码。 */
const TLS_CODES = new Set<string>([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

/** 取一个错误对象及其 `cause` 链上的所有 `code` / 消息片段，用于分类。 */
function collectErrorSignals(error: unknown): { codes: string[]; text: string } {
  const codes: string[] = [];
  const texts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object') {
      const record = current as { code?: unknown; message?: unknown; cause?: unknown };
      if (typeof record.code === 'string') codes.push(record.code);
      if (typeof record.message === 'string') texts.push(record.message);
      current = record.cause;
    } else if (typeof current === 'string') {
      texts.push(current);
      break;
    } else {
      break;
    }
  }
  return { codes, text: texts.join(' ').toLowerCase() };
}

/** 把一个出站异常归类为 tls / network / timeout。 */
function classifyFetchError(error: unknown, aborted: boolean): Exclude<GithubProbeCategory, 'auth'> {
  if (aborted) return 'timeout';
  const { codes, text } = collectErrorSignals(error);
  if (codes.some((code) => TLS_CODES.has(code)) || /certificate|unable to verify|cert_|\bssl\b|\btls\b|x509/.test(text)) {
    return 'tls';
  }
  // 除 TLS / 超时外，其余出站失败（含 undici 笼统的 "fetch failed" 与各类 DNS/连接码）都归到 network。
  return 'network';
}

const CATEGORY_MESSAGE: Record<Exclude<GithubProbeCategory, 'auth'>, string> = {
  tls: '连 GitHub 的 TLS 证书校验失败：多半是系统级加速器/代理做了 TLS 中间人。关掉它或改用 TUN 模式，或在启动 DSH 前 export NODE_EXTRA_CA_CERTS=<CA 包>。',
  network: '连不上 GitHub（DNS / 连接失败）：检查网络或代理设置。',
  timeout: '请求 GitHub 超时：检查网络或代理。',
};

export async function probeGithubAuth(options: {
  credentials: CredentialServices | undefined;
  authMode: 'pat' | 'gh' | 'browser';
  tokenRef: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<GithubProbeResult> {
  const env = options.env ?? process.env;
  const resolved = await resolveGithubToken(options.credentials, options.authMode, options.tokenRef, {
    env,
    freshGh: true,
  });
  if (resolved.token === undefined || resolved.token === '') {
    return {
      ok: false,
      code: 'GITHUB_AUTH',
      category: 'auth',
      source: resolved.source,
      message:
        options.authMode === 'gh'
          ? '没有取到本机 gh 的登录态：先在终端执行 `gh auth login`。'
          : options.authMode === 'browser'
            ? '还没有通过浏览器登录 GitHub：在设置页点「用 GitHub 登录」完成授权。'
            : `没有取到凭据「${options.tokenRef}」：请在环境变量或凭据里配置一个 Personal Access Token。`,
    };
  }
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await doFetch('https://api.github.com/user', {
      method: 'GET',
      headers: {
        authorization: `Bearer ${resolved.token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-github-trending',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        code: 'GITHUB_AUTH',
        category: 'auth',
        source: resolved.source,
        message: `GitHub 返回 HTTP ${response.status}（token 无效或权限不足）`,
      };
    }
    const body = (await response.json()) as { login?: unknown };
    return {
      ok: true,
      source: resolved.source,
      ...(typeof body.login === 'string' ? { login: body.login } : {}),
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    const category = classifyFetchError(error, aborted);
    return {
      ok: false,
      code: 'GITHUB_AUTH',
      category,
      source: resolved.source,
      // 分类文案优先；仍附上原始 message 便于排查（不含 token 明文）。
      message: CATEGORY_MESSAGE[category],
    };
  } finally {
    clearTimeout(timer);
  }
}
