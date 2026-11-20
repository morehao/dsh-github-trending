/**
 * 模型连通性预检（FR-P-02 / §13 风险表：保存前预检）。
 *
 * 只做一次最小请求，把「能不能连、密钥对不对、模型在不在」区分开：
 *   - 401/403 → MODEL_UNAUTHORIZED
 *   - 404 / model not found → MODEL_NOT_FOUND
 *   - 429 → MODEL_RATE_LIMITED（算连通）
 *   - 超时 / 网络错误 → MODEL_FAILED
 *
 * 代理模式不走 HTTP，直接用 `ctx.llm.stream` 发一个 1 token 的请求。
 *
 * 预检**同一个函数**覆盖主模型与备选链上任意一环：入参是一个「接口条目」
 * （provider / mode / hostProvider / baseURL / model / apiKeyRef），主模型由
 * `settings.model` 折算成该形状，备选直接取链上那一项。这样两条路径共用同一套
 * 判定逻辑、同一套错误码，不会出现「主模型能预检、备选不能」的割裂。
 * 每环的密钥**各自独立解析**（沿用 `resolveFallbackKeys` 的独立性约束：主 key 失效
 * 不连累备选），代理项按各自 `hostProvider || provider` 起宿主路由。
 */
import { randomUUID } from 'node:crypto';
import { effectiveBaseURL, type ModelEntryView, type Settings } from '../config.js';
import { hintOf, areaOf } from '../errors.js';
import type { LlmServices } from './quickfill.js';
import { resolveModelKey } from './quickfill.js';
import type { CredentialServices } from './credentials.js';
import { resolveRef } from './credentials.js';

export interface PreflightResult {
  ok: boolean;
  code?: string;
  message?: string;
  hint?: string;
  area?: string;
  durationMs: number;
  endpoint?: string;
  mode: 'direct' | 'proxy';
}

const TIMEOUT_MS = 15_000;

/**
 * 预检的通用条目形状：主模型 `ModelSettings` 与备选 `ModelEntryView` 都满足它
 * （两者都有 provider/baseURL/model/apiKeyRef 与 mode/hostProvider）。
 */
interface PreflightEntry {
  provider: string;
  mode: 'direct' | 'proxy';
  hostProvider: string;
  baseURL: string;
  model: string;
  apiKeyRef: string;
}

function entryFromMainModel(settings: Settings): PreflightEntry {
  return {
    provider: settings.model.provider,
    mode: settings.model.mode,
    hostProvider: settings.model.hostProvider,
    baseURL: settings.model.baseURL,
    model: settings.model.model,
    apiKeyRef: settings.model.apiKeyRef,
  };
}

/**
 * 解析一条预检条目对应的密钥与模式。
 *
 * 主模型走 `resolveModelKey`（它已处理好代理模式与备选链的整体解析）；备选只解析
 * **它自己这一环**的密钥：代理项不需要明文密钥，direct 项按各自 `apiKeyRef` 独立解析，
 * 解析失败只影响该项（与运行时 `resolveFallbackKeys` 的语义一致）。
 */
async function resolveEntryKey(
  entry: PreflightEntry,
  options: {
    settings: Settings;
    credentials: CredentialServices | undefined;
    env: NodeJS.ProcessEnv;
    isMainModel: boolean;
  },
): Promise<{ apiKey?: string; mode: 'direct' | 'proxy' }> {
  if (options.isMainModel) {
    const resolved = await resolveModelKey(options.settings, options.credentials, options.env);
    return { ...(resolved.apiKey === undefined ? {} : { apiKey: resolved.apiKey }), mode: resolved.mode };
  }
  if (entry.mode === 'proxy') return { mode: 'proxy' };
  const resolved = await resolveRef(options.credentials, entry.apiKeyRef, options.env);
  return { ...(resolved.value === undefined ? {} : { apiKey: resolved.value }), mode: 'direct' };
}

/**
 * 预检一条模型条目。主模型与备选链任一环都走这里。
 */
async function preflightEntry(
  entry: PreflightEntry,
  options: {
    settings: Settings;
    credentials: CredentialServices | undefined;
    llm: LlmServices | undefined;
    env: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    isMainModel: boolean;
  },
): Promise<PreflightResult> {
  const started = Date.now();
  const key = await resolveEntryKey(entry, options);

  if (key.mode === 'proxy') {
    const llm = options.llm as unknown as { stream?: (input: Record<string, unknown>) => AsyncIterable<{ type?: string; reason?: { kind?: string; failure?: { code?: string; message?: string } } }> } | undefined;
    if (llm === undefined || typeof llm.stream !== 'function') {
      return {
        ok: false,
        code: 'MODEL_KEY_MISSING',
        message: '该模型需要回环代理，但宿主没有可用的 ctx.llm 服务',
        hint: hintOf('MODEL_KEY_MISSING'),
        area: areaOf('MODEL_KEY_MISSING'),
        durationMs: Date.now() - started,
        mode: 'proxy',
      };
    }
    const provider = entry.hostProvider !== '' ? entry.hostProvider : entry.provider;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const stream = llm.stream({
        provider,
        model: entry.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        maxTokens: 8,
        // 会话标识：opencode-go 等按会话路由的网关靠它补 `x-opencode-session` 头，
        // 缺了会直接 400 MissingSessionID（预检会把主模型误判为不可用）。
        sessionId: `dsh-github-trending-preflight-${randomUUID()}`,
        signal: controller.signal,
      });
      let failure: { code?: string; message?: string } | undefined;
      for await (const chunk of stream) {
        if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
          failure = chunk.reason.failure;
        }
      }
      if (failure !== undefined) {
        const code = failure.code === 'AUTH' ? 'MODEL_UNAUTHORIZED' : failure.code === 'RATE_LIMIT' ? 'MODEL_RATE_LIMITED' : 'MODEL_FAILED';
        return {
          ok: false,
          code,
          message: failure.message ?? failure.code ?? '宿主模型调用失败',
          hint: hintOf(code),
          area: areaOf(code),
          durationMs: Date.now() - started,
          mode: 'proxy',
        };
      }
      return { ok: true, durationMs: Date.now() - started, mode: 'proxy', endpoint: `宿主 provider ${provider}` };
    } catch (error) {
      return {
        ok: false,
        code: 'MODEL_FAILED',
        message: error instanceof Error ? error.message : String(error),
        hint: hintOf('MODEL_FAILED'),
        area: areaOf('MODEL_FAILED'),
        durationMs: Date.now() - started,
        mode: 'proxy',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  if (key.apiKey === undefined || key.apiKey === '') {
    return {
      ok: false,
      code: 'MODEL_KEY_MISSING',
      message: `没有解析到模型密钥（引用 ${entry.apiKeyRef}）`,
      hint: hintOf('MODEL_KEY_MISSING'),
      area: areaOf('MODEL_KEY_MISSING'),
      durationMs: Date.now() - started,
      mode: 'direct',
    };
  }

  const baseURL = effectiveBaseURL(entry).replace(/\/+$/, '');
  const endpoint = `${baseURL}/chat/completions`;
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key.apiKey}` },
      body: JSON.stringify({
        model: entry.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    if (response.ok) return { ok: true, durationMs: Date.now() - started, mode: 'direct', endpoint };
    const text = await response.text().catch(() => '');
    const snippet = text.slice(0, 400);
    const code =
      response.status === 401 || response.status === 403
        ? 'MODEL_UNAUTHORIZED'
        : response.status === 404 || /model[^\n]*not found|not found[^\n]*model/i.test(snippet)
          ? 'MODEL_NOT_FOUND'
          : response.status === 429
            ? 'MODEL_RATE_LIMITED'
            : 'MODEL_FAILED';
    return {
      ok: response.status === 429,
      code,
      message: `HTTP ${response.status}：${snippet === '' ? response.statusText : snippet}`,
      hint: hintOf(code),
      area: areaOf(code),
      durationMs: Date.now() - started,
      mode: 'direct',
      endpoint,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    const code = aborted ? 'MODEL_TIMEOUT' : 'MODEL_FAILED';
    return {
      ok: false,
      code,
      message: aborted ? `预检超时（${TIMEOUT_MS / 1000} s）` : error instanceof Error ? error.message : String(error),
      hint: hintOf(code),
      area: areaOf(code),
      durationMs: Date.now() - started,
      mode: 'direct',
      endpoint,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 预检主模型（默认）。保持既有调用方与语义不变。
 */
export async function preflightModel(options: {
  settings: Settings;
  credentials: CredentialServices | undefined;
  llm: LlmServices | undefined;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<PreflightResult> {
  const env = options.env ?? process.env;
  return preflightEntry(entryFromMainModel(options.settings), {
    settings: options.settings,
    credentials: options.credentials,
    llm: options.llm,
    env,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    isMainModel: true,
  });
}

export interface PreflightFallbackResult extends PreflightResult {
  /** 被预检的备选下标（与 `settings.model.fallbacks` 同序）。 */
  index: number;
}

/**
 * 预检备选链上的第 `index` 项。越界或不存在的下标返回失败结果（不抛错），
 * 界面据此就地显示提示。密钥只解析该项自己的 `apiKeyRef`，与主模型互不影响。
 */
export async function preflightFallback(options: {
  settings: Settings;
  index: number;
  credentials: CredentialServices | undefined;
  llm: LlmServices | undefined;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<PreflightFallbackResult> {
  const env = options.env ?? process.env;
  const fallbacks: ModelEntryView[] = options.settings.model.fallbacks ?? [];
  const entry = fallbacks[options.index];
  if (entry === undefined) {
    return {
      index: options.index,
      ok: false,
      code: 'MODEL_FAILED',
      message: `备选模型 #${options.index + 1} 不存在`,
      hint: hintOf('MODEL_FAILED'),
      area: areaOf('MODEL_FAILED'),
      durationMs: 0,
      mode: 'direct',
    };
  }
  const result = await preflightEntry(entry, {
    settings: options.settings,
    credentials: options.credentials,
    llm: options.llm,
    env,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    isMainModel: false,
  });
  return { ...result, index: options.index };
}
