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
// 某些 npm 版本（如 npm 10）在 `npm pack` 时仍会执行 prepack，构建日志混进 stdout，
// 直接 JSON.parse 会报 "Unexpected token"。只截取第一段 `[` 到最后一段 `]`，兼容 npm 10/11/12；
// 本机（npm 11）与 CI（Node 22 自带 npm 10）都会走到这段兼容逻辑。
function parsePackJson(stdout) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end < start) {
    throw new Error(`npm pack 未输出 JSON 清单：\n${stdout}`);
  }
  return JSON.parse(stdout.slice(start, end + 1));
}

let files;
try {
  const { stdout } = await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, npm_config_cache: cacheDir },
  });
  files = parsePackJson(stdout)[0].files.map((f) => f.path);
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
