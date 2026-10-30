/**
 * 定位核心二进制（FR-P-06 / AC-P-11，D-08 修订为 Release 分发）。
 *
 * 顺序两条，且都不读 `PATH`：
 *   1. `TRENDING_DIGEST_CORE` / settings.corePath —— 仅开发/排障；
 *   2. Release 资产：本地缓存命中直接用，否则按 `package.json` 的 `dsh.core` 下载并校验。
 *
 * 为什么不读 PATH：PATH 是可被外部环境改写的东西，一旦核心版本来自 PATH，
 * 「同一配置产出同一内容」与幂等都失去确定性（ADR D-14）。PATH 上的同名 CLI
 * 只用于共存提示，不参与运行。
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { IpcError } from '../ipc.js';
import type { Settings } from '../config.js';
import {
  describeRelease,
  ensureCore,
  readCoreRelease,
  type CoreRelease,
  type ReleaseDescriptor,
} from './release.js';

export interface CoreLocation {
  path: string;
  source: 'settings' | 'env' | 'cache' | 'download';
  release?: CoreRelease;
  tag?: string;
  /** 本次调用是否真的下载了（用于日志与状态提示）。 */
  downloaded?: boolean;
  sha256?: string;
}

function executable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface LocateOptions {
  settings: Settings;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  /** 默认 true；false 时只查缓存（设置页探测用）。 */
  allowDownload?: boolean;
  forceDownload?: boolean;
  fetchImpl?: typeof fetch;
  release?: CoreRelease;
}

export function overridePath(
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
): { path: string; source: 'settings' | 'env' } | undefined {
  const fromSettings = settings.corePath.trim();
  if (fromSettings !== '') {
    return { path: path.isAbsolute(fromSettings) ? fromSettings : path.resolve(fromSettings), source: 'settings' };
  }
  const fromEnv = env.TRENDING_DIGEST_CORE?.trim() ?? '';
  if (fromEnv !== '') return { path: path.isAbsolute(fromEnv) ? fromEnv : path.resolve(fromEnv), source: 'env' };
  return undefined;
}

export async function locateCore(options: LocateOptions): Promise<CoreLocation> {
  const env = options.env ?? process.env;
  const override = overridePath(options.settings, env);
  if (override !== undefined) {
    if (!existsSync(override.path)) {
      throw new IpcError(
        'CORE_UNAVAILABLE',
        `${override.source === 'settings' ? '设置里的 corePath' : 'TRENDING_DIGEST_CORE'} 指向的路径不存在：${override.path}。` +
          '该覆盖只用于开发/排障，正常使用请清空它。',
      );
    }
    if (!executable(override.path)) {
      throw new IpcError('CORE_UNAVAILABLE', `${override.path} 不可执行（缺执行位或不是文件）`);
    }
    return { path: override.path, source: override.source };
  }

  const result = await ensureCore({
    ...(options.release === undefined ? {} : { release: options.release }),
    env,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.arch === undefined ? {} : { arch: options.arch }),
    ...(options.allowDownload === undefined ? {} : { allowDownload: options.allowDownload }),
    ...(options.forceDownload === undefined ? {} : { force: options.forceDownload }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  return {
    path: result.path,
    source: result.source,
    release: { repo: result.descriptor.repo, version: result.descriptor.version },
    tag: result.descriptor.tag,
    downloaded: result.source === 'download',
    ...(result.sha256 === undefined ? {} : { sha256: result.sha256 }),
  };
}

/** 只读的 Release 视图：不联网、不创建目录，供设置页展示「有没有、从哪来」。 */
export function inspectRelease(
  settings: Settings,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; arch?: string; release?: CoreRelease } = {},
): { descriptor?: ReleaseDescriptor; override?: { path: string; source: 'settings' | 'env' }; error?: string } {
  const env = options.env ?? process.env;
  const override = overridePath(settings, env);
  if (override !== undefined) return { override };
  try {
    const release = options.release ?? readCoreRelease();
    return {
      descriptor: describeRelease(release, {
        env,
        ...(options.platform === undefined ? {} : { platform: options.platform }),
        ...(options.arch === undefined ? {} : { arch: options.arch }),
      }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
