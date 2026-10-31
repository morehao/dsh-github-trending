/**
 * 自更新服务的接线层：把 `@morehao/dsh-plugin-kit/update` 接到本插件的上下文与进程策略上。
 *
 * 引擎（查版本、semver、install/remove 路径、link 安装判定）全在共享包里；这里只做两件
 * 本仓特有的事：
 *   - 用 `ctx.get` 懒取 `pluginManager` / `profileContext`，拿不到不阻塞加载；
 *   - 需要 `pnpm view` 时走本仓的 `execCapture`（环境白名单、超时、输出上限），
 *     不让共享包自己 spawn 进程。
 */
import { normalizeProfile } from '@morehao/dsh-plugin-kit';
import { createPluginUpdater, type Logger, type PluginMeta, type Updater } from '@morehao/dsh-plugin-kit/update';

import { execCapture, sanitizedEnv, type ExecOptions, type ExecResult } from '../core/exec.js';

export interface UpdateServiceDeps {
  get: (name: string) => unknown;
  env: NodeJS.ProcessEnv;
  meta: PluginMeta;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  /** 测试注入；默认走本仓的 execCapture。 */
  exec?: (file: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;
  readFile?: (path: string) => Promise<string>;
}

/** `pnpm view <spec> version --json`：继承 profile 的 .npmrc（镜像 / 私源 / token）。 */
function pnpmViewRunner(
  get: (name: string) => unknown,
  env: NodeJS.ProcessEnv,
  exec: NonNullable<UpdateServiceDeps['exec']>,
): (spec: string) => Promise<string | null> {
  return async (spec: string): Promise<string | null> => {
    const profile = normalizeProfile(get('profileContext'));
    if (profile === null || profile.dir === undefined) return null;
    const command = profile.packageManager?.command ?? 'pnpm';
    const prefix = profile.packageManager?.args ?? [];
    let result: ExecResult;
    try {
      result = await exec(command, [...prefix, 'view', spec, 'version', '--json'], {
        cwd: profile.dir,
        env: sanitizedEnv(env),
        timeoutMs: 8_000,
        maxStdout: 64 * 1024,
        maxStderr: 16 * 1024,
      });
    } catch {
      return null;
    }
    if (result.code !== 0) return null;
    const text = result.stdout.trim();
    if (text === '') return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return null;
    }
    const value = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  };
}

export function createUpdateService(deps: UpdateServiceDeps): Updater {
  const exec = deps.exec ?? execCapture;
  return createPluginUpdater({
    meta: deps.meta,
    getPluginManager: () => deps.get('pluginManager'),
    getProfile: () => deps.get('profileContext'),
    runPnpmView: pnpmViewRunner(deps.get, deps.env, exec),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(deps.readFile === undefined ? {} : { readFile: deps.readFile }),
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });
}
