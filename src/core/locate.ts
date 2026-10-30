/**
 * 定位核心二进制（FR-P-06 / AC-P-11）。
 *
 * 顺序只有两条，且都不读 `PATH`：
 *   1. `TRENDING_DIGEST_CORE`（settings 里的 `corePath` 优先于环境变量）——仅开发/排障；
 *   2. 平台包 `@morehao/trendradar-core-<platform>-<arch>` 的 `bin` 入口。
 *
 * 为什么不读 PATH：PATH 是可被外部环境改写的东西，一旦核心版本来自 PATH，
 * 「同一配置产出同一内容」与幂等都失去确定性（ADR D-14）。PATH 上的同名 CLI
 * 只用于共存提示，不参与运行。
 */
import { createRequire } from 'node:module';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { IpcError } from '../ipc.js';
import type { Settings } from '../config.js';

export const PLATFORM_PACKAGE_PREFIX = '@morehao/trendradar-core';

export interface CoreLocation {
  path: string;
  source: 'settings' | 'env' | 'package';
  packageName?: string;
  /** 解析失败时给用户看的候选清单。 */
  searched?: string[];
}

export function platformPackageName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `${PLATFORM_PACKAGE_PREFIX}-${platform}-${arch}`;
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

/** 从平台包的 package.json 里取 `bin` 入口；取不到就按约定路径兜底。 */
function binCandidates(packageJsonPath: string, packageDir: string): string[] {
  const candidates: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { bin?: unknown };
    const bin = pkg.bin;
    if (typeof bin === 'string') candidates.push(path.join(packageDir, bin));
    else if (typeof bin === 'object' && bin !== null) {
      const entry = (bin as Record<string, unknown>)['trendradar'];
      if (typeof entry === 'string') candidates.push(path.join(packageDir, entry));
    }
  } catch {
    // 读不到 package.json 不算致命：按约定兜底仍然可能命中。
  }
  candidates.push(path.join(packageDir, 'bin', 'trendradar'));
  candidates.push(path.join(packageDir, 'trendradar'));
  return candidates;
}

export interface LocateOptions {
  settings: Settings;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  /** 测试注入：默认 `createRequire(import.meta.url)`。 */
  resolve?: (id: string) => string;
}

export function locateCore(options: LocateOptions): CoreLocation {
  const env = options.env ?? process.env;
  const override = options.settings.corePath !== '' ? options.settings.corePath : env.TRENDING_DIGEST_CORE?.trim() ?? '';
  const searched: string[] = [];
  if (override !== '') {
    const resolved = path.isAbsolute(override) ? override : path.resolve(override);
    searched.push(resolved);
    if (!existsSync(resolved)) {
      throw new IpcError(
        'CORE_UNAVAILABLE',
        `TRENDING_DIGEST_CORE 指向的路径不存在：${resolved}。该变量只用于开发/排障，正常安装请删掉它。`,
      );
    }
    if (!executable(resolved)) {
      throw new IpcError('CORE_UNAVAILABLE', `TRENDING_DIGEST_CORE 指向的文件不可执行：${resolved}`);
    }
    return {
      path: resolved,
      source: options.settings.corePath !== '' ? 'settings' : 'env',
      searched,
    };
  }

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const packageName = platformPackageName(platform, arch);
  const resolve = options.resolve ?? createRequire(import.meta.url);
  try {
    const packageJson = resolve(`${packageName}/package.json`);
    const packageDir = path.dirname(packageJson);
    for (const candidate of binCandidates(packageJson, packageDir)) {
      searched.push(candidate);
      if (executable(candidate)) {
        return { path: candidate, source: 'package', packageName, searched };
      }
    }
    throw new IpcError(
      'CORE_UNAVAILABLE',
      `平台包 ${packageName} 已安装，但找不到可执行的核心（找过：${searched.join('、')}）。重装插件可修复。`,
    );
  } catch (error) {
    if (error instanceof IpcError) throw error;
    throw new IpcError(
      'CORE_UNAVAILABLE',
      `找不到核心二进制：未设置 TRENDING_DIGEST_CORE，平台包 ${packageName} 也未安装。` +
        `请重装插件（会带上对应平台的包）；支持的平台：darwin/linux/win32 × x64/arm64。`,
    );
  }
}

/** 平台包是否已安装（不执行），供设置页提前展示。 */
export function packageInstalled(options: LocateOptions): boolean {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const packageName = platformPackageName(platform, arch);
  const resolve = options.resolve ?? createRequire(import.meta.url);
  try {
    resolve(`${packageName}/package.json`);
    return true;
  } catch {
    return false;
  }
}
