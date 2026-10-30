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
 */
import { effectiveBaseURL, type Settings } from '../config.js';
import { hintOf, areaOf } from '../errors.js';
import type { LlmServices } from './quickfill.js';
import { resolveModelKey } from './quickfill.js';
import type { CredentialServices } from './credentials.js';

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

export async function preflightModel(options: {
  settings: Settings;
  credentials: CredentialServices | undefined;
  llm: LlmServices | undefined;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<PreflightResult> {
  const started = Date.now();
  const settings = options.settings;
  const key = await resolveModelKey(settings, options.credentials, options.env ?? process.env);

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
    const provider = settings.model.hostProvider !== '' ? settings.model.hostProvider : settings.model.provider;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const stream = llm.stream({
        provider,
        model: settings.model.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        maxTokens: 8,
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
      message: `没有解析到模型密钥（引用 ${settings.model.apiKeyRef}）`,
      hint: hintOf('MODEL_KEY_MISSING'),
      area: areaOf('MODEL_KEY_MISSING'),
      durationMs: Date.now() - started,
      mode: 'direct',
    };
  }

  const baseURL = effectiveBaseURL(settings.model).replace(/\/+$/, '');
  const endpoint = `${baseURL}/chat/completions`;
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key.apiKey}` },
      body: JSON.stringify({
        model: settings.model.model,
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
