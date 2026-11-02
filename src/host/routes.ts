/**
 * Host HTTP 面：`/api/morehao/github-trending/*`。
 *
 * 只有客户端 bundle 会调它。安全基线沿用宿主插件的通行做法：
 *   - 一律要求自定义头 `x-dsh-github-trending: 1`（跨源请求会先触发预检，等于顺带挡 CSRF）；
 *   - 响应 `no-store`；
 *   - 没有任何路由返回密钥明文：只返回「已配置/来源」。
 */
import type http from 'node:http';

import { createRouteHandler, HttpError } from '@morehao/dsh-plugin-kit/http';
import { PluginUpdateError, type Updater } from '@morehao/dsh-plugin-kit/update';

import {
  normalizeSettings,
  validateSettings,
  mergeSettingsSection,
  sectionOfField,
  isPeriod,
  SETTINGS_SECTIONS,
  type Settings,
  type SettingsSection,
} from '../config.js';
import { redact } from '../errors.js';
import { IpcError } from '../ipc.js';
import { sumTokens, type Store } from '../state.js';
import { detectCoexistence, inspectCore } from './core.js';
import { locateCore } from '../core/locate.js';
import { credentialServices, describeRef, resolveGithubToken } from './credentials.js';
import { probeGithubAuth } from './github.js';
import { attemptView, beginGithubSignIn, cancelGithubSignIn, ensureGithubFlow, isLoopbackSignInAvailable } from './github-auth.js';
import { importFirstAvailable } from './import-cli.js';
import { checkPendingPr } from './pending-pr.js';
import { preflightModel } from './preflight.js';
import { applyCandidate, applyDefaultSelection, listProviderCandidates, llmServices, readDefaultSelection } from './quickfill.js';
import { readDefaultBranch } from './repo.js';
import { runSubscribe, isValidRepo } from './subscribe.js';
import type { Runner } from './runner.js';
import type { Scheduler } from './schedule.js';

export const ROUTE_PREFIX = '/api/morehao/github-trending';
export const HEADER = 'x-dsh-github-trending';
const MAX_BODY = 512 * 1024;

/** 核心是否提供 authorization 服务（决定「浏览器登录」这一档是否可能出现）。 */
function isAuthorizationAvailable(get: (name: string) => unknown): boolean {
  const authorization = get('authorization') as { begin?: unknown } | undefined;
  return authorization !== undefined && typeof authorization.begin === 'function';
}

/**
 * 浏览器登录此刻是否**真的**可用：服务在 + flow 真的注册上了。
 * 只判「服务在」会造出「按钮亮着、点了必然 NO_FLOW」的死按钮（见 review）。
 * 顺手兜底 ensure 一次：apply 可能赶在 authorization 就绪之前，而这条读状态的路
 * 是前端每次打开页面都会走的，正好用来自愈。
 */
function browserSignInAvailable(deps: RouteDeps): boolean {
  if (!isAuthorizationAvailable(deps.get)) return false;
  return ensureGithubFlow(githubAuthDeps(deps));
}

/** 组装 GitHub 浏览器登录 adapter 的依赖（get/fetch/clientId/logger）。 */
function githubAuthDeps(deps: RouteDeps): {
  get: (name: string) => unknown;
  fetchImpl?: typeof fetch;
  clientId?: string;
  clientSecret?: string;
  logger?: (event: string, data?: Record<string, unknown>) => void;
} {
  return {
    get: deps.get,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(deps.githubClientId === undefined ? {} : { clientId: deps.githubClientId }),
    ...(deps.githubClientSecret === undefined ? {} : { clientSecret: deps.githubClientSecret }),
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  };
}

export interface RouteDeps {
  store: Store;
  runner: Runner;
  scheduler: Scheduler;
  get: (name: string) => unknown;
  env?: NodeJS.ProcessEnv;
  /** 注入用：pendingPr 对账的 fetch 实现（测试不联网）。 */
  fetchImpl?: typeof fetch;
  version: string;
  /** 自更新服务（共享包引擎）；缺省时 /update 返回 404，不影响其它路由。 */
  update?: Updater;
  /** 包名与仓库地址都来自 package.json，由 src/index.ts 传入。 */
  pluginName?: string;
  repository?: string;
  /** 浏览器 GitHub 登录用的 public client_id（由 apply 的 config 传入；缺省时用内置默认）。 */
  githubClientId?: string;
  /** 自带 OAuth App 时的 client_secret（只用于回环 web flow；缺省时该 method 自动降级为设备码）。 */
  githubClientSecret?: string;
  logger?: (event: string, data?: Record<string, unknown>) => void;
}

export function createRoutes(deps: RouteDeps) {
  const logger = deps.logger;
  // 记录当前请求的 method/pathname，供 onError 的日志保留原有字段（onError 不带 ctx）。
  let current: { method: string; pathname: string } = { method: 'GET', pathname: '/' };

  const handler = createRouteHandler({
    prefix: ROUTE_PREFIX,
    header: HEADER,
    maxBodyBytes: MAX_BODY,
    dispatch: async ({ method, pathname, url, body }) => {
      current = { method, pathname };
      return dispatch(method, pathname, url, body, deps);
    },
    // 错误码翻译留在插件侧（dispatcher 不做映射）：保持与原实现的响应形状逐字一致。
    onError: (error) => {
      if (error instanceof PluginUpdateError) {
        // 更新失败是可预期的业务结果（link 安装 / 无 pluginManager / 安装失败），用 409 而不是 500。
        logger?.('update.failed', { code: error.code, message: error.message });
        return {
          status: 409,
          code: 'UPDATE_FAILED',
          message: redact(error.message),
          extra: { updateCode: error.code, update: deps.update?.view() ?? null },
        };
      }
      // 请求体解析失败：kit 的 readJsonBody 抛 HttpError（PAYLOAD_TOO_LARGE / INVALID_JSON），
      // 这里翻译回本插件对外原本的码与状态（PAYLOAD_TOO_LARGE→400 同码；INVALID_JSON→400 CONFIG_INVALID）。
      if (error instanceof HttpError) {
        const code = error.code === 'PAYLOAD_TOO_LARGE' ? 'PAYLOAD_TOO_LARGE' : 'CONFIG_INVALID';
        return { status: 400, code, message: redact(error.message) };
      }
      const code = error instanceof IpcError ? error.code : 'INTERNAL';
      const message = redact(error instanceof Error ? error.message : String(error));
      logger?.('route.error', { pathname: current.pathname, method: current.method, code, message });
      const status =
        code === 'CONFIG_INVALID'
          ? // 「已有一次运行在进行中」是并发冲突而非参数错误：用 409，前端据此禁用按钮并提示。
            message.includes('运行在进行中')
            ? 409
            : 400
          : code === 'NOT_FOUND'
            ? 404
            : 500;
      return { status, code, message };
    },
    logger,
  });

  return async function routeHandler(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    await handler(request, response);
  };
}

async function dispatch(
  method: string,
  pathname: string,
  url: URL,
  body: Record<string, unknown>,
  deps: RouteDeps,
): Promise<Record<string, unknown>> {
  const env = deps.env ?? process.env;
  const settings = deps.store.readSettings();

  if (method === 'GET' && pathname === '/state') return statePayload(deps, settings);

  if (method === 'GET' && pathname === '/update') {
    if (deps.update === undefined) throw new IpcError('NOT_FOUND', '自更新服务不可用');
    const update = await deps.update.check({ fresh: url.searchParams.get('fresh') === '1' });
    return { update };
  }

  if (method === 'POST' && pathname === '/update') {
    if (deps.update === undefined) throw new IpcError('NOT_FOUND', '自更新服务不可用');
    const version = typeof body.version === 'string' && body.version.trim() !== '' ? body.version.trim() : undefined;
    const result = await deps.update.apply(version === undefined ? {} : { version });
    return { result, update: deps.update.view() };
  }

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
    const base = {
      dryRun: body.dryRun === true,
      ...(typeof body.date === 'string' && body.date !== '' ? { date: body.date } : {}),
      ...(body.force === true ? { force: true } : {}),
      trigger: 'manual' as const,
    };
    // 显式指定单周期 → 只跑该周期；省略 → 手动运行默认产出日/周/月三榜。
    if (isPeriod(body.period)) {
      const summary = await deps.runner.run({ ...base, period: body.period });
      return { summary, summaries: [summary] };
    }
    const summaries = await deps.runner.runMany(base);
    return { summary: summaries[summaries.length - 1], summaries };
  }

  if (method === 'POST' && pathname === '/run/cancel') {
    return { cancelled: deps.runner.cancel() };
  }

  // 发版订阅运行触发：全量（无 repo）或单仓（repo=owner/repo）。
  // 复用 Runner.runReleases，与榜单 POST /run 共用同一把 active 锁（并发 → 409）。
  if (method === 'POST' && pathname === '/releases/run') {
    let repo: string | undefined;
    if (body.repo !== undefined) {
      if (typeof body.repo !== 'string' || !isValidRepo(body.repo.trim())) {
        throw new IpcError('CONFIG_INVALID', `repo 必须是 owner/repo 形态：${String(body.repo)}`);
      }
      repo = body.repo.trim();
    }
    const release = await deps.runner.runReleases({ trigger: 'manual', ...(repo === undefined ? {} : { repo }) });
    return { release };
  }

  if (method === 'GET' && pathname === '/repo/branch') {
    const repoPath = url.searchParams.get('path') ?? settings.repo.path;
    return { repo: await readDefaultBranch(repoPath, { env }) };
  }

  // HTTP 镜像：核心 `subscribe list` 信封的 `subscriptions`（IPC 侧见 ipc.parseSubscribeResult）。
  if (method === 'GET' && pathname === '/subscriptions') {
    const result = await runSubscribe({ action: 'list' }, { store: deps.store, env });
    if (!result.ok) {
      throw new IpcError('SUBSCRIBE_FAILED', result.error?.message ?? '读取订阅列表失败');
    }
    // items 恒为数组：旧核心不返回明细时界面拿空表，而不是 undefined。
    return { repos: result.repos, items: result.items ?? [] };
  }

  // HTTP 镜像：核心 `subscribe releases --repo owner/repo [--volume N]` 的 `subscriptionDoc`
  // （IPC 侧见 ipc.SubscriptionDoc）。响应就是这个文档本身（markdown 逐字渲染）。
  if (method === 'GET' && pathname === '/subscriptions/releases') {
    const repo = (url.searchParams.get('repo') ?? '').trim();
    if (!isValidRepo(repo)) {
      throw new IpcError('CONFIG_INVALID', `仓库必须是 owner/repo 形态：${repo || '(空)'}`);
    }
    const volumeRaw = url.searchParams.get('volume');
    let volume: number | undefined;
    if (volumeRaw !== null && volumeRaw !== '') {
      if (!/^\d+$/.test(volumeRaw.trim()) || Number(volumeRaw) < 1) {
        throw new IpcError('CONFIG_INVALID', `卷号必须是正整数：${volumeRaw}`);
      }
      volume = Number(volumeRaw);
    }
    const result = await runSubscribe(
      { action: 'releases', repo, ...(volume === undefined ? {} : { volume }) },
      { store: deps.store, env },
    );
    if (!result.ok) {
      // 「没有文档 / 卷号不存在」是核心的业务错误：原样回错，绝不回一份空文档冒充成功。
      throw new IpcError('SUBSCRIBE_FAILED', result.error?.message ?? `读取 ${repo} 的变更文档失败`);
    }
    if (result.doc === undefined) {
      throw new IpcError('SUBSCRIBE_FAILED', `核心没有返回 ${repo} 的变更文档`);
    }
    return { ...result.doc };
  }

  if (method === 'POST' && pathname === '/subscriptions') {
    const action = body.action === 'add' || body.action === 'remove' ? body.action : undefined;
    if (action === undefined) throw new IpcError('CONFIG_INVALID', 'action 必须是 add 或 remove');
    const repos = Array.isArray(body.repos)
      ? body.repos.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
      : typeof body.repo === 'string' && body.repo.trim() !== ''
        ? [body.repo.trim()]
        : [];
    if (repos.length === 0) throw new IpcError('CONFIG_INVALID', '必须提供要操作的 owner/repo');
    // 逐个执行（列表在核心侧 union pending，一条失败不影响其余，但任一失败都会如实回错）。
    for (const repo of repos) {
      const result = await runSubscribe({ action, repo }, { store: deps.store, env });
      if (!result.ok) {
        throw new IpcError('SUBSCRIBE_FAILED', result.error?.message ?? `${action} ${repo} 失败`);
      }
    }
    // 操作完成后回最新列表（再次 list）；items 与 GET 保持同一形状（恒为数组）。
    const latest = await runSubscribe({ action: 'list' }, { store: deps.store, env });
    return { repos: latest.ok ? latest.repos : [], items: latest.ok ? (latest.items ?? []) : [] };
  }

  if (method === 'POST' && pathname === '/github/test') {
    const candidate = body.settings === undefined ? settings : normalizeSettings(body.settings);
    const probe = await probeGithubAuth({
      credentials: credentialServices(deps.get),
      authMode: candidate.github.authMode,
      tokenRef: candidate.github.tokenRef,
      env,
    });
    return { github: probe };
  }

  // 浏览器 GitHub 登录：begin 启动一次 attempt（进程内 authorization.begin，不阻塞），
  // 返回 attempt 视图（含 authorizeUrl / userCode）；status 供前端轮询；cancel 取消。
  if (method === 'POST' && pathname === '/github/browser/begin') {
    const method = body.method === 'device' ? 'device' : 'browser';
    try {
      const view = await beginGithubSignIn(githubAuthDeps(deps), method);
      // attempt 落成 error 时必须变成 HTTP 错误：客户端只在 catch 里提示，
      // 返回 200 + phase:error 会被 UI 当成「什么都没发生」（旧版的症状）。
      if (view.phase === 'error') throw new IpcError('GITHUB_AUTH_UNAVAILABLE', redact(view.error ?? 'GitHub 登录失败'));
      return { attempt: view };
    } catch (error) {
      if (error instanceof IpcError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'already-in-flight') {
        return { attempt: attemptView(), alreadyInFlight: true };
      }
      throw new IpcError('GITHUB_AUTH_UNAVAILABLE', redact(message));
    }
  }

  if (method === 'GET' && pathname === '/github/browser/status') {
    return { attempt: attemptView() };
  }

  if (method === 'POST' && pathname === '/github/browser/cancel') {
    cancelGithubSignIn(githubAuthDeps(deps));
    return { attempt: attemptView() };
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

  if (method === 'GET' && pathname === '/preview') {
    const id = url.searchParams.get('id') ?? '';
    if (!/^[A-Za-z0-9-]+$/.test(id)) throw new IpcError('CONFIG_INVALID', '非法的运行 id');
    const state = deps.store.readState();
    const history = deps.store.readHistory();
    const record = history.find((item) => item.id === id) ?? (state.lastResult?.id === id ? state.lastResult : undefined);
    if (record === undefined || record.preview === undefined) {
      throw new IpcError('NOT_FOUND', '没有这次运行的预览副本');
    }
    const preview = deps.store.readPreview(id);
    if (preview === undefined) throw new IpcError('NOT_FOUND', '预览副本不存在或已被清理');
    return { id, preview };
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
  // 90 条 = 三周期共用的回看窗口；日期/周期切换不再额外请求历史接口。
  const history = deps.store.readHistory();
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
    plugin: {
      name: deps.pluginName ?? '@morehao/dsh-github-trending',
      version: deps.version,
      ...(deps.repository === undefined ? {} : { repository: deps.repository }),
    },
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
      /** 最近 30 次发版运行（HTTP 镜像：`Store.readReleaseRuns`，IPC 侧无对应命令，纯展示）。 */
      releaseRuns: deps.store.readReleaseRuns(),
      /** 最近一次发版运行结束时间（失败也算）；界面「上次发版」读它。 */
      lastReleaseAt: state.lastReleaseAt ?? null,
      /** 历史里全部运行的 token 累计（读时求和，不落盘）；全无数据则省略。 */
      ...(() => {
        const totalTokens = sumTokens(history);
        return totalTokens === undefined ? {} : { totalTokens };
      })(),
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
      /** 浏览器登录 attempt 视图（idle / waiting-browser / waiting-device / exchanging / done / error）。 */
      attempt: attemptView(),
      /** 浏览器登录是否可用：authorization 服务在、且 GitHub flow 真的注册上了（client_id 有内置默认）。 */
      browserAvailable: browserSignInAvailable(deps),
      /**
       * 回环 web flow 是否可用：GitHub 换 token 必须有 client_secret，内置 client_id 没有 → 只能设备码。
       * 前端据此决定主按钮启动哪个 method（false 时直接用 device，避免点了必然失败的 web flow）。
       */
      loopbackAvailable: isLoopbackSignInAvailable(githubAuthDeps(deps)),
    },
  };
}
