/**
 * 核心二进制的获取：**GitHub Release 资产 + sha256 校验 + 本地缓存**（ADR D-08 修订版）。
 *
 * 为什么不是 npm 平台包：一份二进制 22 MB，六个平台就是六个 npm 包与六次版本锁步；
 * 而 Release 资产本来就要出（直装、审计、checksums），再发一遍 npm 只是把成本翻倍。
 * 代价是首次运行要联网——因此这里把「下载」做成一件事，而不是散在运行路径里：
 *
 *   1. 缓存命中且哈希对得上 → 直接用（离线可跑）；
 *   2. 未命中 → 拉 `checksums.txt`，按 `trendradar_<goos>_<goarch>` 取期望哈希；
 *   3. 流式下载到同目录临时文件，边写边算 sha256，匹配后 chmod 0755 + 原子 rename；
 *   4. 失败一律带 URL、版本与缓存目录，且**不留下半个文件**。
 *
 * 版本来源是 `package.json` 的 `dsh.core`（由 `sync-contract.mjs --ref vX.Y.Z` 自动写入），
 * 所以「插件用的核心版本」与「契约快照的来源 tag」是同一个值。
 */
import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

import { IpcError } from '../ipc.js';
import { dataDir } from '../paths.js';

export interface CoreRelease {
  /** `owner/repo`（GitHub）。 */
  repo: string;
  /** 不带 `v` 的版本号，例如 `0.1.0`；对应 tag `v0.1.0`。 */
  version: string;
}

export interface ReleaseDescriptor extends CoreRelease {
  tag: string;
  goos: string;
  goarch: string;
  asset: string;
  url: string;
  checksumsUrl: string;
  cacheDir: string;
  binaryPath: string;
  cached: boolean;
}

const DOWNLOAD_TIMEOUT_MS = 180_000;

function requireJson(): { dsh?: { core?: { repo?: unknown; version?: unknown } } } {
  const require = createRequire(import.meta.url);
  return require('../package.json') as { dsh?: { core?: { repo?: unknown; version?: unknown } } };
}

/** 从本包的 package.json 读核心版本（`sync-contract --ref vX` 会同时更新它）。 */
export function readCoreRelease(pkg?: { dsh?: { core?: { repo?: unknown; version?: unknown } } }): CoreRelease {
  const source = pkg ?? requireJson();
  const repo = source.dsh?.core?.repo;
  const version = source.dsh?.core?.version;
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new IpcError('CORE_UNAVAILABLE', 'package.json 缺少 dsh.core.repo（owner/repo），无法定位核心 Release');
  }
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
    throw new IpcError('CORE_UNAVAILABLE', 'package.json 缺少 dsh.core.version（形如 0.1.0），无法定位核心 Release');
  }
  return { repo, version };
}

/** Node 的 platform/arch → Go 的 GOOS/GOARCH（两个生态词汇不同，映射必须显式）。 */
export function goTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): { goos: string; goarch: string } {
  const goos = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : platform;
  const goarch = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : arch === 'ia32' ? '386' : arch;
  return { goos, goarch };
}

export function assetName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const { goos, goarch } = goTarget(platform, arch);
  return `trendradar_${goos}_${goarch}`;
}

function binaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'trendradar.exe' : 'trendradar';
}

export function describeRelease(
  release: CoreRelease,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; arch?: string } = {},
): ReleaseDescriptor {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const { goos, goarch } = goTarget(platform, arch);
  const asset = assetName(platform, arch);
  const tag = `v${release.version}`;
  const base = `https://github.com/${release.repo}/releases/download/${tag}`;
  const cacheDir = path.join(dataDir(env), 'core', tag);
  const binaryPath = path.join(cacheDir, binaryName(platform));
  return {
    ...release,
    tag,
    goos,
    goarch,
    asset,
    url: `${base}/${asset}`,
    checksumsUrl: `${base}/checksums.txt`,
    cacheDir,
    binaryPath,
    cached: existsSync(binaryPath),
  };
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function markerPath(binaryPath: string): string {
  return `${binaryPath}.sha256`;
}

/** 缓存里的二进制是否可信：可执行 + 与下载时记录的哈希一致。 */
export function verifyCached(binaryPath: string): { ok: boolean; reason?: string } {
  let info;
  try {
    info = statSync(binaryPath);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!info.isFile()) return { ok: false, reason: 'not-a-file' };
  if (process.platform !== 'win32' && (info.mode & 0o111) === 0) return { ok: false, reason: 'not-executable' };
  const marker = markerPath(binaryPath);
  if (!existsSync(marker)) return { ok: true }; // 手工放进去的二进制（TRENDING_DIGEST_CORE 之外的逃生口）
  const expected = readFileSync(marker, 'utf8').trim();
  if (expected === '') return { ok: true };
  try {
    return sha256File(binaryPath) === expected ? { ok: true } : { ok: false, reason: 'checksum-mismatch' };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

export interface EnsureOptions {
  release?: CoreRelease;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  /** false 时只查缓存，不联网（设置页探测、离线诊断用）。 */
  allowDownload?: boolean;
  /** true 时忽略缓存重新下载（「重新下载核心」按钮）。 */
  force?: boolean;
  fetchImpl?: typeof fetch;
  onProgress?: (event: { phase: 'checksums' | 'download' | 'verify'; bytes?: number; total?: number }) => void;
}

export interface EnsureResult {
  path: string;
  source: 'cache' | 'download';
  descriptor: ReleaseDescriptor;
  sha256?: string;
}

function fetchOf(options: EnsureOptions): typeof fetch {
  if (options.fetchImpl !== undefined) return options.fetchImpl;
  if (typeof fetch !== 'function') {
    throw new IpcError('CORE_UNAVAILABLE', '当前 Node 没有全局 fetch（需要 Node ≥ 18），无法下载核心');
  }
  return fetch;
}

async function fetchChecksum(descriptor: ReleaseDescriptor, options: EnsureOptions): Promise<string> {
  options.onProgress?.({ phase: 'checksums' });
  const response = await fetchOf(options)(descriptor.checksumsUrl, { signal: AbortSignal.timeout(30_000) }).catch((error: unknown) => {
    throw new IpcError(
      'CORE_UNAVAILABLE',
      `无法获取核心校验文件：${descriptor.checksumsUrl}（${error instanceof Error ? error.message : String(error)}）。` +
        '若在公司网络内，请确认代理可用；也可用 TRENDING_DIGEST_CORE 指向本地已编译的核心。',
    );
  });
  if (!response.ok) {
    throw new IpcError(
      'CORE_UNAVAILABLE',
      `核心 ${descriptor.tag} 还没有发布（${descriptor.checksumsUrl} 返回 HTTP ${response.status}）。` +
        '发布顺序是先在 trendradar 打 tag 并上传 Release 资产，插件随后才能下载。',
    );
  }
  const text = await response.text();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match !== null && match[2] === descriptor.asset) return match[1] as string;
  }
  throw new IpcError(
    'CORE_UNAVAILABLE',
    `checksums.txt 里没有 ${descriptor.asset}（当前平台 ${descriptor.goos}/${descriptor.goarch} 可能不在发布矩阵内）`,
  );
}

async function download(descriptor: ReleaseDescriptor, options: EnsureOptions): Promise<{ path: string; sha256: string }> {
  const expected = await fetchChecksum(descriptor, options);
  options.onProgress?.({ phase: 'download' });
  const response = await fetchOf(options)(descriptor.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }).catch((error: unknown) => {
    throw new IpcError(
      'CORE_UNAVAILABLE',
      `下载核心失败：${descriptor.url}（${error instanceof Error ? error.message : String(error)}）。` +
        `可手动下载后放到 ${descriptor.binaryPath}，或用 TRENDING_DIGEST_CORE 指定路径。`,
    );
  });
  if (!response.ok || response.body === null) {
    throw new IpcError(
      'CORE_UNAVAILABLE',
      `下载核心失败：${descriptor.url} 返回 HTTP ${response.status}（版本 ${descriptor.tag} / ${descriptor.asset}）`,
    );
  }

  mkdirSync(descriptor.cacheDir, { recursive: true, mode: 0o700 });
  const temp = `${descriptor.binaryPath}.${process.pid}.${Date.now()}.part`;
  const hash = createHash('sha256');
  const total = Number(response.headers.get('content-length') ?? '0') || undefined;
  let bytes = 0;
  try {
    await pipeline(
      Readable.fromWeb(response.body as never),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          hash.update(buf);
          bytes += buf.length;
          yield buf;
        }
      },
      createWriteStream(temp, { mode: 0o600 }),
    );
    const actual = hash.digest('hex');
    options.onProgress?.({ phase: 'verify', bytes, total });
    if (actual !== expected) {
      throw new IpcError(
        'CORE_CHECKSUM_MISMATCH',
        `核心二进制校验失败：期望 ${expected}，实际 ${actual}（${descriptor.url}）。已丢弃下载结果。`,
      );
    }
    chmodSync(temp, 0o755);
    renameSync(temp, descriptor.binaryPath);
    const fs = await import('node:fs');
    fs.writeFileSync(markerPath(descriptor.binaryPath), `${actual}\n`, { mode: 0o600 });
    return { path: descriptor.binaryPath, sha256: actual };
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * 确保本地有一份可用的核心二进制。
 * 缓存命中就不联网；`allowDownload=false` 时缓存缺失直接报错（不带网络副作用）。
 */
export async function ensureCore(options: EnsureOptions = {}): Promise<EnsureResult> {
  const release = options.release ?? readCoreRelease();
  const descriptor = describeRelease(release, options);

  if (!options.force && existsSync(descriptor.binaryPath)) {
    const verified = verifyCached(descriptor.binaryPath);
    if (verified.ok) {
      return { path: descriptor.binaryPath, source: 'cache', descriptor };
    }
    // 缓存坏了：删掉重下（或如实报错）
    if (options.allowDownload === false) {
      throw new IpcError(
        'CORE_UNAVAILABLE',
        `本地核心缓存不可用（${verified.reason ?? 'unknown'}）：${descriptor.binaryPath}。删除该文件后重试，或在设置页点「重新下载核心」。`,
      );
    }
    try {
      unlinkSync(descriptor.binaryPath);
    } catch {
      // 删不掉就覆盖写，rename 仍会成功
    }
  }

  if (options.allowDownload === false) {
    throw new IpcError(
      'CORE_NOT_DOWNLOADED',
      `核心 ${descriptor.tag} 尚未下载（缓存目录 ${descriptor.cacheDir}）。` +
        `下载地址：${descriptor.url}；或在设置页点「下载核心」，或设置 TRENDING_DIGEST_CORE 指向本地核心。`,
    );
  }

  const downloaded = await download(descriptor, options);
  return { path: downloaded.path, source: 'download', descriptor, sha256: downloaded.sha256 };
}
