import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config, core, release } from '../lib/internal.js';

// 从 package.json 读取当前核心版本，避免每次升核心都要手改测试常量。
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const CORE_VERSION = pkg.dsh.core.version;
const RELEASE = { repo: pkg.dsh.core.repo, version: CORE_VERSION };

function env() {
  return { TRENDING_DIGEST_HOME: mkdtempSync(path.join(tmpdir(), 'dshgt-status-')), HOME: process.env.HOME, PATH: process.env.PATH };
}

const settingsFor = (patch = {}) =>
  config.normalizeSettings({ model: { provider: 'deepseek', model: 'm' }, repo: { path: '/tmp/x' }, coreAutoDownload: false, ...patch });

test('未下载：state=unavailable、download=missing、release 指向确切资产', async () => {
  const status = await core.inspectCore(settingsFor(), { env: env(), fresh: true });
  assert.equal(status.state, 'unavailable');
  assert.equal(status.code, 'CORE_NOT_DOWNLOADED');
  assert.equal(status.download.state, 'missing');
  assert.equal(status.release.asset, release.assetName());
  assert.equal(status.release.tag, `v${CORE_VERSION}`);
  assert.match(status.release.url, new RegExp(`releases/download/v${CORE_VERSION.replace(/\./g, '\\.')}/`));
  assert.equal(status.override, undefined);
});

test('缓存命中：download=cached、source=cache（不联网）', async () => {
  const e = env();
  const desc = release.describeRelease(RELEASE, { env: e });
  const fs = await import('node:fs');
  fs.mkdirSync(desc.cacheDir, { recursive: true });
  writeFileSync(desc.binaryPath, '#!/bin/sh\necho core\n');
  chmodSync(desc.binaryPath, 0o755);
  const status = await core.inspectCore(settingsFor(), { env: e, fresh: true });
  assert.equal(status.download.state, 'cached');
  // 内容不是真核心：握手会失败，但「缓存在」这一事实要如实反映
  assert.notEqual(status.state, 'ready');
  assert.equal(status.release.cached, true);
});

test('覆盖路径：download=override，release 为空', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dshgt-override-'));
  const fake = path.join(dir, 'core');
  writeFileSync(fake, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({version:'9.9.9',ipcSchema:2,digestSchema:2,contractVersion:'0.2.0'})+'\\n')\n`);
  chmodSync(fake, 0o755);
  const status = await core.inspectCore(settingsFor({ corePath: fake }), { env: env(), fresh: true });
  assert.equal(status.state, 'ready');
  assert.equal(status.version, '9.9.9');
  assert.equal(status.download.state, 'override');
  assert.equal(status.release, undefined);
  assert.equal(status.source, 'settings');
});
