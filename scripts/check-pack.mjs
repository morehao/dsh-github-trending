#!/usr/bin/env node
// 打包内容白名单校验：npm 上已发布的版本不可撤回、不能复用版本号，
// 所以 `.dsh/` 草稿、`src/`、`test/`、`docs/`、`node_modules`、`*.tgz` 之类混进包
// 必须在 PR 阶段就红。
//
// 复用 `npm pack --dry-run --json`（只打印清单、不生成 tgz），用临时 cache 目录避免本机
// `~/.npm` 属主问题（EPERM）。
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { parsePackOutput } from './lib/pack-json.mjs';

const run = promisify(execFile);

const ALLOWED_EXACT = new Set([
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'cordis.patch.yml',
  'icon.svg',
  'client.js',
]);
const ALLOWED_PREFIX = ['lib/', 'locale/', 'contract/'];

// 反向检查：少一个就是「能装但跑不起来」——lib 是宿主入口，client.js 是前端 bundle，
// contract 是核心与 IPC 的契约快照，locale 缺了设置页整片空白。
const REQUIRED = [
  'package.json',
  'README.md',
  'LICENSE',
  'cordis.patch.yml',
  'icon.svg',
  'lib/index.js',
  'lib/index.d.ts',
  'client.js',
  'locale/en.json',
  'locale/zh.json',
  'contract/UPSTREAM.json',
  'contract/CONTRACT.sha256',
  'contract/schema/ipc.v1.json',
];

const cacheDir = await mkdtemp(join(tmpdir(), 'dsh-trending-pack-'));
// 输出解析放在 scripts/lib/pack-json.mjs：输出形状随 npm 版本变（npm 10 是数组，
// npm 12 是按包名索引的对象；release run 41083620340 实测），直接 JSON.parse 会炸。
let files;
try {
  const { stdout } = await run(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts', '--loglevel=silent'],
    { cwd: new URL('..', import.meta.url), env: { ...process.env, npm_config_cache: cacheDir } },
  );
  files = parsePackOutput(stdout);
} finally {
  await rm(cacheDir, { recursive: true, force: true });
}

const unwanted = files.filter(
  (p) => !ALLOWED_EXACT.has(p) && !ALLOWED_PREFIX.some((prefix) => p.startsWith(prefix)),
);
const missing = REQUIRED.filter((p) => !files.includes(p));

for (const p of unwanted) console.error(`✗ 包内出现非白名单文件：${p}`);
for (const p of missing) console.error(`✗ 包内缺少必备文件：${p}`);

console.log(`包内共 ${files.length} 个文件：\n  ${files.sort().join('\n  ')}`);
if (unwanted.length || missing.length) {
  console.error('打包内容校验失败');
  process.exit(1);
}
console.log('打包内容校验通过');
