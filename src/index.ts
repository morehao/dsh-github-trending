/**
 * 插件入口（Host half）。
 *
 * 装配顺序：状态目录 → 设置/运行器/调度 → HTTP 路由 → 工具 → 调度启动。
 * 业务代码全在 host/ 与 core/，这里只做「接线」，并且所有非硬依赖服务都惰性取
 * （`ctx.get`），缺一个不阻塞加载——只有 `webServer` 是硬依赖（`inject`）。
 */
import { createRequire } from 'node:module';

import { Store } from './state.js';
import { Runner } from './host/runner.js';
import { Scheduler } from './host/schedule.js';
import { createRoutes, ROUTE_PREFIX } from './host/routes.js';
import { createTrendingHistoryTool, createTrendingRunTool } from './tools.js';

export const name = 'dsh-github-trending';

/** 唯一硬依赖：没有 HTTP 载体就没有设置页与运行页。 */
export const inject = ['webServer'];

export interface PluginLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  debug?: (message: string) => void;
}

interface TimerService {
  interval?: (fn: () => void, ms: number) => unknown;
  timeout?: (fn: () => void, ms: number) => unknown;
}

export interface PluginContext {
  get?: (name: string) => unknown;
  effect?: (factory: () => unknown, label?: string) => unknown;
  logger?: PluginLogger;
  webServer?: { register: (options: { kind: 'prefix'; path: string; handler: unknown }) => unknown };
  [key: string]: unknown;
}

function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readVersion();

export function apply(ctx: PluginContext, config: { stateDir?: string; corePath?: string } = {}): void {
  const env = process.env;
  const get = (key: string): unknown => (typeof ctx.get === 'function' ? ctx.get(key) : undefined);
  const log = (event: string, data?: Record<string, unknown>): void => {
    const suffix = data === undefined ? '' : ` ${JSON.stringify(data)}`;
    ctx.logger?.info?.(`[dsh-github-trending] ${event}${suffix}`);
  };

  const store = new Store({ env, ...(config.stateDir === undefined ? {} : { dir: config.stateDir }) });
  if (config.corePath !== undefined && config.corePath !== '') {
    const settings = store.readSettings();
    if (settings.corePath === '') store.writeSettings({ ...settings, corePath: config.corePath });
  }

  const runner = new Runner({
    store,
    get,
    env,
    onFinished: (summary) =>
      log('run.finished', { id: summary.id, ok: summary.ok, skipped: summary.skipped, files: summary.files }),
  });

  const scheduler = new Scheduler({
    store,
    isRunning: () => runner.running !== undefined,
    getTimer: () => get('timer') as TimerService | undefined,
    run: async () => {
      const summary = await runner.run({ trigger: 'schedule' });
      log('schedule.run', { ok: summary.ok, skipped: summary.skipped, error: summary.error?.code });
    },
    onError: (error) =>
      ctx.logger?.warn?.(`[dsh-github-trending] 定时运行失败：${error instanceof Error ? error.message : String(error)}`),
  });

  const handler = createRoutes({ store, runner, scheduler, get, env, version: VERSION, logger: log });
  const register = (): unknown => {
    const webServer = ctx.webServer ?? (get('webServer') as PluginContext['webServer']);
    if (webServer === undefined || typeof webServer.register !== 'function') {
      throw new Error('webServer 服务不可用：插件需要它提供设置页与运行页');
    }
    return webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler });
  };
  if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-github-trending:routes');
  else register();

  scheduler.start();
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => scheduler.stop(), 'dsh-github-trending:scheduler');
  }

  void (async () => {
    const tools = get('tools') as { register?: (definition: unknown) => unknown } | undefined;
    if (tools === undefined || typeof tools.register !== 'function') return;
    try {
      const mod = (await import('@deepseek-ai/dsh-tools')) as { defineTool?: (definition: unknown) => unknown };
      if (typeof mod.defineTool !== 'function') return;
      tools.register(mod.defineTool(createTrendingRunTool(runner)));
      tools.register(mod.defineTool(createTrendingHistoryTool(store, scheduler)));
      log('tools.registered', { tools: ['trending_run', 'trending_history'] });
    } catch (error) {
      ctx.logger?.warn?.(
        `[dsh-github-trending] 工具注册跳过：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();

  log('plugin.loaded', { version: VERSION, stateDir: store.dir });
}

export default { name, inject, apply };
