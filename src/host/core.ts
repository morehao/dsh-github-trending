/**
 * 核心的「当前状态」：能不能用、什么版本、PATH 上有没有另一份（FR-P-06/07、FR-P-15）。
 *
 * 这里的探测都会 spawn 子进程（`version --json`），因此结果带 30 s 缓存：
 * 设置页每次打开都重新握手会让界面发木，也会白白多起进程。
 */
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

import type { Settings } from '../config.js';
import { IpcError, IPC_SCHEMA_VERSION, SUPPORTED_DIGEST_SCHEMA } from '../ipc.js';
import { execCapture } from '../core/exec.js';
import { inspectRelease, locateCore, type CoreLocation } from '../core/locate.js';
import { readCoreRelease, type ReleaseDescriptor } from '../core/release.js';
import { handshake } from '../core/handshake.js';

/** `owner/repo`（可选带前后 `v`）→ `https://github.com/owner/repo`；非 GitHub 形态返回 undefined。 */
export function coreRepoFromSource(repo: string | undefined): string | undefined {
  let ownerRepo = repo;
  if (ownerRepo === undefined) {
    try {
      ownerRepo = readCoreRelease().repo;
    } catch {
      return undefined;
    }
  }
  if (typeof ownerRepo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(ownerRepo)) return undefined;
  return `https://github.com/${ownerRepo}`;
}

/** Release 分发下的核心视图：用户一眼能看出「版本、下没下、从哪来」。 */
export interface ReleaseStatus {
  repo: string;
  tag: string;
  asset: string;
  url: string;
  checksumsUrl: string;
  cacheDir: string;
  binaryPath: string;
  cached: boolean;
}

export interface CoreStatus {
  state: 'ready' | 'unavailable' | 'incompatible';
  path?: string;
  source?: CoreLocation['source'];
  /** Release 分发状态（有覆盖路径时只有 override，没有 release）。 */
  release?: ReleaseStatus;
  override?: { path: string; source: 'settings' | 'env' };
  download: { state: 'cached' | 'missing' | 'override'; reason?: string };
  version?: string;
  commit?: string;
  ipcSchema?: number;
  digestSchema?: number;
  supportedProviders: string[];
  /** 核心开源仓库（`https://github.com/<owner>/<repo>`），来自 package.json 的 `dsh.core.repo`。 */
  repository?: string;
  code?: string;
  message?: string;
  hint?: string;
  checkedAt: string;
  durationMs?: number;
}

export interface CoexistenceStatus {
  found: boolean;
  path?: string;
  version?: string;
  ipcSchema?: number;
  digestSchema?: number;
  compatible?: boolean;
  message?: string;
}

const CACHE_TTL_MS = 30_000;

function executable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 在 PATH 里找同名 CLI（只用于共存提示，绝不用于运行）。 */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.PATH ?? '';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of raw.split(path.delimiter)) {
    if (dir.trim() === '') continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `${command}${ext}`);
      if (executable(candidate)) return candidate;
    }
  }
  return undefined;
}

let cached: { key: string; at: number; status: CoreStatus } | undefined;

export async function inspectCore(settings: Settings, options: { env?: NodeJS.ProcessEnv; fresh?: boolean } = {}): Promise<CoreStatus> {
  const env = options.env ?? process.env;
  const key = `${settings.corePath}|${env.TRENDING_DIGEST_CORE ?? ''}|${process.platform}|${process.arch}`;
  if (!options.fresh && cached !== undefined && cached.key === key && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.status;
  }
  const view = inspectRelease(settings, { env });
  const release: ReleaseStatus | undefined =
    view.descriptor === undefined
      ? undefined
      : {
          repo: view.descriptor.repo,
          tag: view.descriptor.tag,
          asset: view.descriptor.asset,
          url: view.descriptor.url,
          checksumsUrl: view.descriptor.checksumsUrl,
          cacheDir: view.descriptor.cacheDir,
          binaryPath: view.descriptor.binaryPath,
          cached: view.descriptor.cached,
        };
  // 核心仓库地址：优先取本次定位到的 Release 仓，其次退回 package.json 的 dsh.core.repo。
  // 解析不到就不给，界面据此隐藏外链，而不是拼一个可能 404 的地址。
  const coreRepository = coreRepoFromSource(release?.repo);
  const base: Omit<CoreStatus, 'state' | 'checkedAt' | 'supportedProviders'> = {
    ...(coreRepository === undefined ? {} : { repository: coreRepository }),
    ...(release === undefined ? {} : { release }),
    ...(view.override === undefined ? {} : { override: view.override }),
    download:
      view.override !== undefined
        ? { state: 'override' }
        : release === undefined
          ? { state: 'missing', reason: view.error ?? 'release 未配置' }
          : { state: release.cached ? 'cached' : 'missing' },
  };
  const checkedAt = new Date().toISOString();
  try {
    const core = await locateCore({ settings, env, allowDownload: false });
    const result = await handshake(core, { timeoutMs: 5000 });
    const status: CoreStatus = {
      ...base,
      state: 'ready',
      path: core.path,
      source: core.source,
      version: result.version.version,
      commit: result.version.commit,
      ipcSchema: result.version.ipcSchema,
      digestSchema: result.version.digestSchema,
      supportedProviders: result.supportedProviders,
      checkedAt,
      durationMs: result.durationMs,
    };
    cached = { key, at: Date.now(), status };
    return status;
  } catch (error) {
    const code = error instanceof IpcError ? error.code : 'CORE_UNAVAILABLE';
    const message = error instanceof Error ? error.message : String(error);
    const status: CoreStatus = {
      ...base,
      state: code === 'CORE_INCOMPATIBLE' ? 'incompatible' : 'unavailable',
      code,
      message,
      supportedProviders: [],
      checkedAt,
    };
    cached = { key, at: Date.now(), status };
    return status;
  }
}

let coexistCache: { key: string; at: number; status: CoexistenceStatus } | undefined;

/**
 * 共存检测（FR-P-15 / AC-P-13）：PATH 上有 `trendradar` 就读它的版本，只提示不切换。
 * 若命中的正是本插件平台包里的二进制（比如用户把它加进了 PATH），不算共存。
 */
export async function detectCoexistence(ownPath: string | undefined, options: { env?: NodeJS.ProcessEnv; fresh?: boolean } = {}): Promise<CoexistenceStatus> {
  const env = options.env ?? process.env;
  const found = findOnPath('trendradar', env);
  if (found === undefined) return { found: false };
  if (ownPath !== undefined && path.resolve(found) === path.resolve(ownPath)) return { found: false };
  if (!options.fresh && coexistCache !== undefined && coexistCache.key === found && Date.now() - coexistCache.at < CACHE_TTL_MS) {
    return coexistCache.status;
  }
  let status: CoexistenceStatus;
  try {
    const result = await execCapture(found, ['version', '--json'], { timeoutMs: 3000 });
    if (result.code !== 0) {
      status = {
        found: true,
        path: found,
        message: 'PATH 上的 trendradar 无法执行 version --json；插件仍使用自带核心，不切换。',
      };
    } else {
      const info = JSON.parse(result.stdout) as { version?: string; ipcSchema?: number; digestSchema?: number };
      const compatible = info.ipcSchema === IPC_SCHEMA_VERSION && info.digestSchema === SUPPORTED_DIGEST_SCHEMA;
      status = {
        found: true,
        path: found,
        version: typeof info.version === 'string' ? info.version : undefined,
        ipcSchema: typeof info.ipcSchema === 'number' ? info.ipcSchema : undefined,
        digestSchema: typeof info.digestSchema === 'number' ? info.digestSchema : undefined,
        compatible,
        message: compatible
          ? 'PATH 上另有一份 trendradar（协议兼容）。插件不接管它，也不会从 PATH 解析核心；注意别让两套定时同时开启。'
          : 'PATH 上的 trendradar 协议版本与插件不同。插件仍使用自带核心，不切换；建议只用其中一套。',
      };
    }
  } catch (error) {
    status = {
      found: true,
      path: found,
      message: `PATH 上的 trendradar 探测失败（${error instanceof Error ? error.message : String(error)}）；插件仍使用自带核心。`,
    };
  }
  coexistCache = { key: found, at: Date.now(), status };
  return status;
}
