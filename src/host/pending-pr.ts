/**
 * 未合并 PR 的「对账」：把 `state.pendingPr` 和 GitHub 上的真实状态对齐。
 *
 * 背景：插件把「上次成功创建的 PR」记在 `pendingPr`，但它不会感知这个 PR 之后
 * 在 GitHub 上被**合并或关闭**——于是界面/工具会一直显示「未合并」，而且在同日
 * 重跑时给出误导性的判断。这里做一次只读核对（GET /pulls/{n}）：
 *
 *   - open    → 仍是未合并 PR，保留；
 *   - merged  → 已完成，清掉陈旧记录；
 *   - closed  → 已放弃，清掉陈旧记录；
 *   - unknown → 无 token / 解析失败 / 网络异常，先不动（下次再试）。
 *
 * 只读、可注入 `fetchImpl`，并对同一 URL 做 60 s 缓存，避免 `/state` 5 s 轮询
 * 每次都打 GitHub。任何失败都降级为 `unknown`，绝不让对账影响主流程。
 */

export type PullState = 'open' | 'closed' | 'merged' | 'unknown';

export interface PendingPrStatus {
  state: PullState;
  url: string;
  number?: number;
  title?: string;
  reason?: string;
}

export interface ParsedPullUrl {
  owner: string;
  repo: string;
  number: number;
}

/** 只认标准的 `https://github.com/<owner>/<repo>/pull/<n>` 形态。 */
export function parsePullUrl(url: string): ParsedPullUrl | undefined {
  const match = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(url.trim());
  if (match === null) return undefined;
  const owner = match[1];
  const repo = match[2];
  const number = Number(match[3]);
  if (owner === undefined || repo === undefined || !Number.isInteger(number) || number <= 0) return undefined;
  return { owner, repo, number };
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; status: PendingPrStatus }>();

/** 清空缓存（测试与「强制刷新」用）。 */
export function clearPendingPrCache(): void {
  cache.clear();
}

export interface CheckPendingPrOptions {
  url: string;
  token?: string;
  fetchImpl?: typeof fetch;
  now?: number;
  /** false = 跳过缓存，强制请求。 */
  cache?: boolean;
}

export async function checkPendingPr(options: CheckPendingPrOptions): Promise<PendingPrStatus> {
  const { url } = options;
  const parsed = parsePullUrl(url);
  if (parsed === undefined) {
    return { state: 'unknown', url, reason: 'PR 链接无法解析，跳过对账' };
  }

  const now = options.now ?? Date.now();
  if (options.cache !== false) {
    const hit = cache.get(url);
    if (hit !== undefined && now - hit.at < CACHE_TTL_MS) return hit.status;
  }

  if (options.token === undefined || options.token === '') {
    // 没有 token 就不发请求：/state 是高频轮询，不能在这里卡网络。
    return { state: 'unknown', url, number: parsed.number, reason: '没有可用的 GitHub token，无法核对 PR 状态' };
  }

  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await doFetch(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'dsh-github-trending',
        },
        signal: controller.signal,
      },
    );
    if (response.status === 404) {
      const status: PendingPrStatus = { state: 'unknown', url, number: parsed.number, reason: 'PR 不存在或无权访问' };
      cache.set(url, { at: now, status });
      return status;
    }
    if (!response.ok) {
      const status: PendingPrStatus = { state: 'unknown', url, number: parsed.number, reason: `GitHub 返回 HTTP ${response.status}` };
      cache.set(url, { at: now, status });
      return status;
    }
    const body = (await response.json()) as {
      state?: unknown;
      merged?: unknown;
      merged_at?: unknown;
      title?: unknown;
    };
    const merged = body.merged === true || (typeof body.merged_at === 'string' && body.merged_at !== '');
    const state: PullState = merged
      ? 'merged'
      : body.state === 'open'
        ? 'open'
        : body.state === 'closed'
          ? 'closed'
          : 'unknown';
    const status: PendingPrStatus = {
      state,
      url,
      number: parsed.number,
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
    };
    cache.set(url, { at: now, status });
    return status;
  } catch (error) {
    // 网络异常也缓存一小段时间，避免 /state 轮询反复卡在超时上。
    const status: PendingPrStatus = {
      state: 'unknown',
      url,
      number: parsed.number,
      reason: error instanceof Error ? error.message : String(error),
    };
    cache.set(url, { at: now, status });
    return status;
  } finally {
    clearTimeout(timer);
  }
}
