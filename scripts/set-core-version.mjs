#!/usr/bin/env node
// 写 package.json 的 `dsh.core.version`（首次运行下载哪个 trendradar Release 的唯一来源）。
//
// 用法：
//   node scripts/set-core-version.mjs 0.3.0
//   npm run set-core-version -- 0.3.0
//
// 只改这一处，不碰 `dsh.core.repo`，也不改插件自身 version。契约包版本与核心版本
// 是两条独立的线（契约包 0.2.0 携带 wire 2，核心 0.3.0 才实现 wire 2），不要互相推导。
import { readFile } from 'node:fs/promises';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const version = process.argv[2];
if (version === undefined || version === '') {
  fail('用法：node scripts/set-core-version.mjs <x.y.z>');
}
if (!SEMVER.test(version)) {
  fail(`版本号不合法：${version}（应形如 0.3.0 或 0.3.0-rc.1）`);
}

const pkgUrl = new URL('../package.json', import.meta.url);
const raw = await readFile(pkgUrl, 'utf8');
const pkg = JSON.parse(raw);
if (pkg.dsh === undefined || typeof pkg.dsh !== 'object') fail('package.json 缺少 dsh 段');
if (pkg.dsh.core === undefined || typeof pkg.dsh.core !== 'object') fail('package.json 缺少 dsh.core 段');

const previous = pkg.dsh.core.version;
pkg.dsh.core.version = version;
// 与仓库既有格式保持一致：两空格缩进 + 末尾换行。
await import('node:fs/promises').then((fs) => fs.writeFile(pkgUrl, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8'));
console.log(`dsh.core.version：${previous ?? '(缺失)'} → ${version}`);
