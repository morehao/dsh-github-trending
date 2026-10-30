/**
 * 回环代理（FR-P-04 / ADR D-04 / Q-P-01）。
 *
 * 当宿主 provider 的凭据不可导出（OAuth / `nativeAuth`）时，插件在本机起一个
 * OpenAI 兼容端点，把核心对 `/v1/chat/completions` 的调用转发给 `ctx.llm.stream`。
 *
 * 不变式（AC-P-04 / §10 安全表）：
 *   - 只绑 `127.0.0.1`，端口随机；
 *   - 一次性 token，随运行结束失效；
 *   - 生命周期与**单次运行**绑定：`runner` 在 finally 里 close，并断言端口已释放；
 *   - 只实现核心会用到的最小子集：非流式、单轮文本；其余请求直接 4xx，不静默降级。
 */
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const MAX_BODY = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

interface StreamChunkLike {
  type?: string;
  text?: string;
  reason?: { kind?: string; failure?: { code?: string; message?: string } };
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

export interface LlmLike {
  stream(options: Record<string, unknown>): AsyncIterable<StreamChunkLike>;
}

export interface ProxyOptions {
  llm: LlmLike;
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ProxyHandle {
  url: string;
  token: string;
  port: number;
  requests: number;
  close(): Promise<void>;
}

interface ChatMessage {
  role?: string;
  content?: unknown;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text') {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .filter((part) => part !== '')
      .join('\n');
  }
  return '';
}

/** 把 OpenAI 的 messages 折成「system + 单个 user」。核心只用单轮，超出部分并入 user。 */
export function foldMessages(messages: ChatMessage[]): { system: string; user: string } {
  const systemParts: string[] = [];
  const userParts: string[] = [];
  for (const message of messages) {
    const text = textOf(message.content);
    if (text === '') continue;
    if (message.role === 'system' || message.role === 'developer') systemParts.push(text);
    else userParts.push(text);
  }
  return { system: systemParts.join('\n\n'), user: userParts.join('\n\n') };
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function fail(response: http.ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { message, type: 'invalid_request_error', code } });
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('请求体超过 4 MB');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const token = randomBytes(24).toString('hex');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const handle = { requests: 0 } as ProxyHandle;
  let closed = false;

  const server = http.createServer((request, response) => {
    void (async () => {
      try {
        if (request.method === 'GET' && (request.url === '/healthz' || request.url === '/v1/models')) {
          if (!authorized(request, token)) return fail(response, 401, 'unauthorized', 'missing or bad proxy token');
          if (request.url === '/healthz') return sendJson(response, 200, { ok: true });
          return sendJson(response, 200, { object: 'list', data: [{ id: options.model, object: 'model', owned_by: options.provider }] });
        }
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
          return fail(response, 404, 'not_found', `unsupported route ${request.method ?? ''} ${request.url ?? ''}`);
        }
        if (!authorized(request, token)) return fail(response, 401, 'unauthorized', 'missing or bad proxy token');

        const raw = await readBody(request);
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return fail(response, 400, 'invalid_json', 'request body is not JSON');
        }
        if (body.stream === true) {
          return fail(response, 400, 'stream_unsupported', '回环代理只实现非流式补全；核心不会开启流式');
        }
        const messages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
        if (messages.length === 0) return fail(response, 400, 'invalid_request', 'messages 不能为空');
        const { system, user } = foldMessages(messages);
        if (user === '') return fail(response, 400, 'invalid_request', 'messages 里没有可用的文本内容');

        handle.requests += 1;
        const started = Date.now();
        let text = '';
        let usage: StreamChunkLike['usage'];
        let failure: { code?: string; message?: string } | undefined;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const stream = options.llm.stream({
            provider: options.provider,
            model: options.model,
            system: system === '' ? undefined : system,
            messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
            temperature: typeof body.temperature === 'number' ? body.temperature : options.temperature,
            maxTokens:
              typeof body.max_tokens === 'number'
                ? body.max_tokens
                : typeof body.maxTokens === 'number'
                  ? body.maxTokens
                  : options.maxTokens,
            signal: controller.signal,
          });
          for await (const chunk of stream) {
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
            else if (chunk.type === 'usage') usage = chunk.usage;
            else if (chunk.type === 'finish') {
              const kind = chunk.reason?.kind;
              if (kind === 'error' || kind === 'aborted') failure = chunk.reason?.failure ?? { code: kind };
            }
          }
        } finally {
          clearTimeout(timer);
        }
        if (failure !== undefined) {
          return fail(response, 502, failure.code ?? 'llm_failed', failure.message ?? '宿主模型调用失败');
        }
        return sendJson(response, 200, {
          id: `chatcmpl-proxy-${Date.now().toString(36)}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: options.model,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: usage?.inputTokens ?? 0,
            completion_tokens: usage?.outputTokens ?? 0,
            total_tokens: usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
          },
          proxy: { provider: options.provider, durationMs: Date.now() - started },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!response.headersSent) fail(response, 500, 'proxy_failed', message);
        else response.end();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    server.close();
    throw new Error('回环代理未能拿到端口');
  }

  handle.port = address.port;
  handle.url = `http://127.0.0.1:${address.port}/v1`;
  handle.token = token;
  handle.close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return handle;
}

function authorized(request: http.IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) return false;
  const provided = Buffer.from(match[1] ?? '', 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
