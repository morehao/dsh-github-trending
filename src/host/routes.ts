/**
 * Host HTTP 面：`/api/morehao/github-trending/*`。
 *
 * 只有客户端 bundle 会调它。安全基线沿用宿主插件的通行做法：
 *   - 一律要求自定义头 `x-dsh-github-trending: 1`（跨源请求会先触发预检，等于顺带挡 CSRF）；
 *   - 响应 `no-store`；
 *   - 没有任何路由返回密钥明文：只返回「已配置/来源」。
 */
import type http from 'node:http';

import {
  normalizeSettings,
  validateSettings,
  mergeSettingsSection,
  sectionOfField,
  SETTINGS_SECTIONS,
  type Settings,
  type SettingsSection,
} from '../config.js';
import { redact } from '../errors.js';
import { IpcError } from '../ipc.js';
import type { Store } from '../state.js';
import { detectCoexistence, inspectCore } from './core.js';
import { locateCore } from '../core/locate.js';
import { credentialServices, describeRef, resolveGithubToken } from './credentials.js';
import { probeGithubAuth } from './github.js';
import { importFirstAvailable } from './import-cli.js';
import { checkPendingPr } from './pending-pr.js';
import { preflightModel } from './preflight.js';
import { applyCandidate, applyDefaultSelection, listProviderCandidates, llmServices, readDefaultSelection } from './quickfill.js';
import { readDefaultBranch } from './repo.js';
import type { Runner } from './runner.js';
import type { Scheduler } from './schedule.js';

export const ROUTE_PREFIX = '/api/morehao/github-trending';
export const HEADER = 'x-dsh-github-trending';
const MAX_BODY = 512 * 1024;

export interface RouteDeps {
  store: Store;
  runner: Runner;
  scheduler: Scheduler;
  get: (name: string) => unknown;
  env?: NodeJS.ProcessEnv;
  /** 注入用：pendingPr 对账的 fetch 实现（测试不联网）。 */
  fetchImpl?: typeof fetch;
  version: string;
  logger?: (event: string, data?: Record<string, unknown>) => void;
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

async function readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new IpcError('PAYLOAD_TOO_LARGE', '请求体过大');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('body must be a JSON object');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new IpcError('CONFIG_INVALID', `请求体不是 JSON 对象：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function createRoutes(deps: RouteDeps) {
  return async function handler(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (request.headers[HEADER] !== '1') {
      sendJson(response, 403, { ok: false, code: 'FORBIDDEN', message: `缺少 ${HEADER}: 1 头` });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname.startsWith(ROUTE_PREFIX)
      ? url.pathname.slice(ROUTE_PREFIX.length) || '/'
      : url.pathname;
    const method = (request.method ?? 'GET').toUpperCase();
    try {
      const result = await dispatch(method, pathname, url, request, deps);
      if (!response.writableEnded) sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      if (response.writableEnded) return;
      const code = error instanceof IpcError ? error.code : 'INTERNAL';
      const message = redact(error instanceof Error ? error.message : String(error));
      deps.logger?.('route.error', { pathname, method, code, message });
      const status = code === 'CONFIG_INVALID' ? 400 : 500;
      sendJson(response, status, { ok: false, code, message });
    }
  };
}

async function dispatch(
  method: string,
  pathname: string,
  url: URL,
  request: http.IncomingMessage,
  deps: RouteDeps,
): Promise<Record<string, unknown>> {
  const env = deps.env ?? process.env;
  const settings = deps.store.readSettings();

  if (method === 'GET' && pathname === '/state') return statePayload(deps, settings);

  if (method === 'GET' && pathname === '/core') {
    const core = await inspectCore(settings, { env, fresh: url.searchParams.get('fresh') === '1' });
    const coexistence = await detectCoexistence(core.path, { env });
    return { core, coexistence };
  }

  if (method === 'POST' && pathname === '/core/download') {
    // 显式下载（设置页按钮）：强制重下并重新握手。失败把错误码原样回给界面。
    const core = await locateCore({ settings, env, forceDownload: true });
    const status = await inspectCore(settings, { env, fresh: true });
    return { downloaded: true, path: core.path, tag: core.tag ?? null, core: status };
  }

  if (method === 'POST' && pathname === '/config') {
    const body = await readBody(request);
    const incoming = normalizeSettings(body.settings ?? body);
    const section =
      typeof body.section === 'string' && (SETTINGS_SECTIONS as readonly string[]).includes(body.section)
        ? (body.section as SettingsSection)
        : undefined;
    // 分段保存：只把本分区字段合并进已保存设置，其它分区保持原值（不静默提交别处草稿）。
    let next = section === undefined ? incoming : mergeSettingsSection(settings, incoming, section);
    // 目标分支以仓库默认分支为准，忽略客户端传值（设置页只读展示，不允许手改）。
    if (next.repo.path.trim() !== '' && (section === undefined || section === 'repo')) {
      const branch = await readDefaultBranch(next.repo.path, { env });
      if (branch.branch !== undefined) next.repo.baseBranch = branch.branch;
    }
    const core = await inspectCore({ ...next, corePath: settings.corePath }, { env });
    const providers = core.supportedProviders.length > 0 ? core.supportedProviders : undefined;
    const allProblems = validateSettings(next, providers);
    // 分段保存只回本分区的问题：其它分区沿用已保存值，不该阻塞这次保存。
    const problems = section === undefined ? allProblems : allProblems.filter((problem) => sectionOfField(problem.field) === section);
    if (problems.length > 0) {
      return { saved: false, problems, settings: next };
    }
    deps.store.writeSettings(next);
    return { saved: true, settings: next, problems: [] };
  }

  if (method === 'POST' && pathname === '/preflight') {
    const body = await readBody(request);
    const candidate = body.settings === undefined ? settings : normalizeSettings(body.settings);
    const result = await preflightModel({
      settings: candidate,
      credentials: credentialServices(deps.get),
      llm: llmServices(deps.get),
      env,
    });
    return { preflight: result };
  }

  if (method === 'POST' && pathname === '/run') {
    const body = await readBody(request);
    const summary = await deps.runner.run({
      dryRun: body.dryRun === true,
      ...(typeof body.date === 'string' && body.date !== '' ? { date: body.date } : {}),
      trigger: 'manual',
    });
    return { summary };
  }

  if (method === 'POST' && pathname === '/run/cancel') {
    return { cancelled: deps.runner.cancel() };
  }

  if (method === 'GET' && pathname === '/repo/branch') {
    const repoPath = url.searchParams.get('path') ?? settings.repo.path;
    return { repo: await readDefaultBranch(repoPath, { env }) };
  }

  if (method === 'POST' && pathname === '/github/test') {
    const body = await readBody(request);
    const candidate = body.settings === undefined ? settings : normalizeSettings(body.settings);
    const probe = await probeGithubAuth({
      credentials: credentialServices(deps.get),
      authMode: candidate.github.authMode,
      tokenRef: candidate.github.tokenRef,
      env,
    });
    return { github: probe };
  }

  if (method === 'GET' && pathname === '/quickfill') {
    const candidates = await listProviderCandidates({
      llm: llmServices(deps.get),
      credentials: credentialServices(deps.get),
      env,
    });
    return { providers: candidates, defaultSelection: readDefaultSelection(deps.get) ?? null };
  }

  if (method === 'POST' && pathname === '/quickfill') {
    const body = await readBody(request);
    const candidates = await listProviderCandidates({
      llm: llmServices(deps.get),
      credentials: credentialServices(deps.get),
      env,
    });
    if (body.useDefault === true) {
      const selection = readDefaultSelection(deps.get);
      if (selection === undefined) throw new IpcError('CONFIG_INVALID', '宿主没有可沿用的默认模型');
      const candidate = candidates.find((item) => item.id === selection.provider);
      const next = applyDefaultSelection(settings, selection, candidate);
      deps.store.writeSettings(next);
      return {
        saved: true,
        settings: next,
        applied: { provider: selection.provider, model: selection.model, mode: next.model.mode },
      };
    }
    const providerId = typeof body.providerId === 'string' ? body.providerId : '';
    const modelId = typeof body.modelId === 'string' ? body.modelId : '';
    const candidate = candidates.find((item) => item.id === providerId);
    if (candidate === undefined) throw new IpcError('CONFIG_INVALID', `宿主没有这个已配置的 provider：${providerId}`);
    if (modelId === '') throw new IpcError('CONFIG_INVALID', '必须选择一个模型');
    const next = applyCandidate(settings, candidate, modelId);
    deps.store.writeSettings(next);
    return { saved: true, settings: next, applied: { provider: candidate.id, model: modelId, mode: candidate.credential.mode } };
  }

  if (method === 'POST' && pathname === '/import') {
    const result = importFirstAvailable(env, settings);
    if (result.ok && result.settings !== undefined) deps.store.writeSettings(result.settings);
    return { import: { ...result, settings: result.settings === undefined ? undefined : result.settings } };
  }

  if (method === 'GET' && pathname === '/log') {
    const id = url.searchParams.get('id') ?? '';
    if (!/^[A-Za-z0-9-]+$/.test(id)) throw new IpcError('CONFIG_INVALID', '非法的运行 id');
    const file = deps.store.newLogPath(id);
    const text = deps.store.readLog(file);
    return { id, exists: text !== '', text };
  }

  throw new IpcError('NOT_FOUND', `未处理的路由：${method} ${pathname}`);
}

async function statePayload(deps: RouteDeps, settings: Settings): Promise<Record<string, unknown>> {
  const env = deps.env ?? process.env;
  const credentials = credentialServices(deps.get);
  const state = deps.store.readState();
  const history = deps.store.readHistory().slice(0, 10);
  const core = await inspectCore(settings, { env });
  const coexistence = await detectCoexistence(core.path, { env });
  const modelCredential = await describeRef(credentials, settings.model.apiKeyRef, env);
  const github = await resolveGithubToken(credentials, settings.github.authMode, settings.github.tokenRef, { env });

  // 对账 pendingPr：外部已合并/关闭的 PR 不该继续以「未合并」示人；清掉陈旧记录。
  let pendingPr = state.pendingPr ?? null;
  let pendingPrState: string | undefined;
  if (pendingPr !== null) {
    const status = await checkPendingPr({
      url: pendingPr.url,
      token: github.token,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    });
    pendingPrState = status.state;
    if (status.state === 'merged' || status.state === 'closed') {
      const next = { ...state };
      delete next.pendingPr;
      deps.store.writeState(next);
      pendingPr = null;
    }
  }

  return {
    plugin: { name: '@morehao/dsh-github-trending', version: deps.version },
    settings,
    core,
    coexistence,
    schedule: deps.scheduler.describe(state),
    status: {
      running: deps.runner.running ?? null,
      lastRunAt: state.lastRunAt ?? null,
      lastDigest: state.lastDigest ?? null,
      lastResult: state.lastResult ?? null,
      pendingPr,
      ...(pendingPrState === undefined ? {} : { pendingPrState }),
      history,
    },
    model: {
      mode: settings.model.mode,
      credential: {
        ref: settings.model.apiKeyRef,
        configured: modelCredential.configured,
        source: modelCredential.source ?? null,
        writable: modelCredential.writable,
      },
      effectiveBaseURL: settings.model.baseURL,
    },
    github: {
      authMode: settings.github.authMode,
      configured: github.token !== undefined,
      source: github.source,
    },
  };
}
