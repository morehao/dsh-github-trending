#!/usr/bin/env node
/**
 * lockfile 注册表守卫。
 *
 * 为什么需要：本机 `~/.npmrc` 常指向国内镜像，`npm install` 会把镜像 URL 写进
 * `resolved` 字段。到了 CI（npm 11）会直接拒绝——`EALLOWREMOTE: Fetching packages
 * of type "remote" have been disabled`，而且只会在**发版**那一步暴露（tag 已推、不可改）。
 * 所以这里把「lockfile 里所有 resolved 必须指向 npmjs」变成一条可在 PR 阶段跑的检查。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

const problems = [];
for (const [name, entry] of Object.entries(lock.packages ?? {})) {
  const resolved = entry?.resolved;
  if (typeof resolved !== 'string') continue;
  if (resolved.startsWith('https://registry.npmjs.org/')) continue;
  if (resolved.startsWith('file:') || resolved.startsWith('link:')) continue;
  problems.push(`${name || '(root)'} → ${resolved}`);
}

if (problems.length > 0) {
  console.error(`package-lock.json 里有 ${problems.length} 个非 npmjs 的 resolved：`);
  for (const problem of problems.slice(0, 10)) console.error(`  · ${problem}`);
  if (problems.length > 10) console.error(`  · …还有 ${problems.length - 10} 个`);
  console.error(
    '\n修复：把 registry.npmmirror.com 换成 registry.npmjs.org（tarball 路径与 integrity 不变），' +
      '或 `rm package-lock.json && npm install --package-lock-only --registry https://registry.npmjs.org`。',
  );
  process.exit(1);
}
console.log(`lockfile 校验通过：${Object.keys(lock.packages ?? {}).length} 个条目全部指向 npmjs`);
