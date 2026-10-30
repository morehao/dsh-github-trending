/**
 * GitHub 认证探测：供设置页「测试认证」按钮调用。
 *
 * 只做一次 `GET https://api.github.com/user`，把「有没有 token、token 是否有效」
 * 一次性验证清楚并回显登录账号；token 不进日志、不进响应明文。
 */
import type { CredentialServices } from './credentials.js';
import { resolveGithubToken } from './credentials.js';

export interface GithubProbeResult {
  ok: boolean;
  login?: string;
  /** token 来源（gh / env / credentials）。 */
  source?: string;
  code?: string;
  message?: string;
}

export async function probeGithubAuth(options: {
  credentials: CredentialServices | undefined;
  authMode: 'pat' | 'gh';
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
      source: resolved.source,
      message:
        options.authMode === 'gh'
          ? '没有取到本机 gh 的登录态：先在终端执行 `gh auth login`。'
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
    return {
      ok: false,
      code: 'GITHUB_AUTH',
      source: resolved.source,
      message: aborted ? '请求 GitHub 超时' : error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
