import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config, handshake, locate, release } from '../lib/internal.js';

const RELEASE = { repo: 'morehao/trendradar', version: '0.1.0' };
const BINARY = Buffer.from('#!/bin/sh\necho fake-core\n');

function freshEnv() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dshgt-release-'));
  return { TRENDING_DIGEST_HOME: dir, HOME: process.env.HOME, PATH: process.env.PATH };
}

function descriptor(env, platform = process.platform, arch = process.arch) {
  return release.describeRelease(RELEASE, { env, platform, arch });
}

/** 假发布端：checksums.txt + 资产；`corrupt` 时资产内容与 checksums 不一致。 */
function fakeFetch(options = {}) {
  const calls = [];
  const body = options.binary ?? BINARY;
  const impl = async (url) => {
    calls.push(String(url));
    const desc = descriptor(options.env ?? freshEnv(), options.platform, options.arch);
    if (String(url).endsWith('checksums.txt')) {
      if (options.missingRelease === true) return new Response('not found', { status: 404 });
      const sha = options.badChecksum === true ? '0'.repeat(64) : createHash('sha256').update(body).digest('hex');
      return new Response(`${sha}  ${desc.asset}\n`, { status: 200 });
    }
    if (String(url).endsWith(desc.asset)) {
      return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
    }
    return new Response('nope', { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

test('命名映射：Node platform/arch → Release 资产名与缓存路径', () => {
  const env = freshEnv();
  const mac = release.describeRelease(RELEASE, { env, platform: 'darwin', arch: 'arm64' });
  assert.equal(mac.asset, 'trendradar_darwin_arm64');
  assert.equal(mac.tag, 'v0.1.0');
  assert.equal(mac.url, 'https://github.com/morehao/trendradar/releases/download/v0.1.0/trendradar_darwin_arm64');
  assert.ok(mac.binaryPath.endsWith(path.join('core', 'v0.1.0', 'trendradar')));

  const win = release.describeRelease(RELEASE, { env, platform: 'win32', arch: 'x64' });
  // goreleaser 在 Windows 上保留 .exe：资产名与缓存文件名都要带后缀
  assert.equal(win.asset, 'trendradar_windows_amd64.exe');
  assert.ok(win.binaryPath.endsWith('trendradar.exe'));

  const linux = release.describeRelease(RELEASE, { env, platform: 'linux', arch: 'x64' });
  assert.equal(linux.asset, 'trendradar_linux_amd64');
});

test('下载 → 校验 → 0755 → 缓存复用（第二次不联网）', async () => {
  const env = freshEnv();
  const fetchImpl = fakeFetch({ env });
  const first = await release.ensureCore({ release: RELEASE, env, fetchImpl });
  assert.equal(first.source, 'download');
  assert.equal(readFileSync(first.path).equals(BINARY), true);
  if (process.platform !== 'win32') assert.equal(statSync(first.path).mode & 0o777, 0o755);
  assert.equal(existsSync(`${first.path}.sha256`), true);
  assert.equal(fetchImpl.calls.length, 2);

  const offline = async () => {
    throw new Error('不该联网');
  };
  const second = await release.ensureCore({ release: RELEASE, env, fetchImpl: offline });
  assert.equal(second.source, 'cache');
  assert.equal(second.path, first.path);
});

test('缓存被改动 → 重新下载；禁止下载时如实报错', async () => {
  const env = freshEnv();
  const fetchImpl = fakeFetch({ env });
  const first = await release.ensureCore({ release: RELEASE, env, fetchImpl });
  writeFileSync(first.path, 'tampered');

  await assert.rejects(
    async () => release.ensureCore({ release: RELEASE, env, allowDownload: false }),
    (error) => error.code === 'CORE_UNAVAILABLE',
  );
  writeFileSync(first.path, 'tampered');
  const again = await release.ensureCore({ release: RELEASE, env, fetchImpl });
  assert.equal(again.source, 'download');
  assert.equal(readFileSync(again.path).equals(BINARY), true);
});

test('未下载且禁止联网 → CORE_NOT_DOWNLOADED（界面据此给下载按钮）', async () => {
  const env = freshEnv();
  await assert.rejects(
    async () => release.ensureCore({ release: RELEASE, env, allowDownload: false }),
    (error) => error.code === 'CORE_NOT_DOWNLOADED' && /尚未下载/.test(error.message),
  );
});

test('校验不一致 → CORE_CHECKSUM_MISMATCH，且不留半个文件', async () => {
  const env = freshEnv();
  const fetchImpl = fakeFetch({ env, badChecksum: true });
  await assert.rejects(
    async () => release.ensureCore({ release: RELEASE, env, fetchImpl }),
    (error) => error.code === 'CORE_CHECKSUM_MISMATCH',
  );
  const desc = descriptor(env);
  assert.equal(existsSync(desc.binaryPath), false);
  const leftovers = readdirSync(desc.cacheDir).filter((name) => name.includes('.part'));
  assert.deepEqual(leftovers, []);
});

test('核心还没发布（404）→ 明确提示发布顺序', async () => {
  const env = freshEnv();
  await assert.rejects(
    async () => release.ensureCore({ release: RELEASE, env, fetchImpl: fakeFetch({ env, missingRelease: true }) }),
    (error) => error.code === 'CORE_UNAVAILABLE' && /还没有发布/.test(error.message) && /发布顺序/.test(error.message),
  );
});

test('force 忽略缓存重新下载', async () => {
  const env = freshEnv();
  const fetchImpl = fakeFetch({ env });
  await release.ensureCore({ release: RELEASE, env, fetchImpl });
  const forced = await release.ensureCore({ release: RELEASE, env, fetchImpl, force: true });
  assert.equal(forced.source, 'download');
  assert.equal(fetchImpl.calls.length, 4);
});

test('下载 → 可执行 → 真的能握手（整条 B 路径串起来）', async () => {
  const env = freshEnv();
  const script = '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({version:"0.1.0",commit:"dl",ipcSchema:1,digestSchema:1,commit2:1})+"\\n")\n';
  const fetchImpl = fakeFetch({ env, binary: Buffer.from(script) });
  const settings = config.normalizeSettings({
    model: { provider: 'deepseek', model: 'm' },
    repo: { path: '/tmp/x' },
    coreAutoDownload: true,
  });
  const core = await locate.locateCore({ settings, env, release: RELEASE, fetchImpl });
  assert.equal(core.source, 'download');
  assert.equal(core.downloaded, true);
  const result = await handshake.handshake(core);
  assert.equal(result.version.version, '0.1.0');
  assert.equal(result.version.commit, 'dl');
  // 第二次定位走缓存，且不再联网
  const offline = async () => {
    throw new Error('不该联网');
  };
  const again = await locate.locateCore({ settings, env, release: RELEASE, fetchImpl: offline });
  assert.equal(again.source, 'cache');
  assert.equal(again.path, core.path);
});

test('dsh.core 缺失时给出可执行的错误，而不是静默用错版本', () => {
  assert.throws(() => release.readCoreRelease({ dsh: {} }), (error) => error.code === 'CORE_UNAVAILABLE');
  assert.throws(() => release.readCoreRelease({ dsh: { core: { repo: 'a/b' } } }), (error) => /dsh.core.version/.test(error.message));
  const good = release.readCoreRelease({ dsh: { core: { repo: 'a/b', version: '1.2.3' } } });
  assert.deepEqual(good, { repo: 'a/b', version: '1.2.3' });
});

test('真实 package.json 的 dsh.core 形状正确', () => {
  const real = release.readCoreRelease();
  assert.match(real.repo, /^[\w.-]+\/[\w.-]+$/);
  assert.match(real.version, /^\d+\.\d+\.\d+/);
});
