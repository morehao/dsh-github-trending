#!/usr/bin/env node
/**
 * Web Client 构建：`client/index.ts` → 仓库根的 `client.js`。
 *
 * 产物形态固定为 DSH 的 `window.__ModuleLoader__.load({ id, factory(require) {...} })`：
 * banner 打开 factory（`require` 是宿主给的模块解析函数），footer 返回 module.exports。
 * 客户端只允许 require 宿主提供的 `react`（本插件不引入 react-dom），其它外部模块在
 * 构建后校验里直接报错。
 *
 *   node scripts/build-client.mjs            构建并写 client.js
 *   node scripts/build-client.mjs --check    只在内存里重建并与 client.js 逐字节比对
 */
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const entry = path.join(root, 'client', 'index.ts');
const outfile = path.join(root, 'client.js');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const argv = new Set(process.argv.slice(2));
const check = argv.has('--check');

const ALLOWED_EXTERNAL = new Set(['react']);

const banner = [
  '/* AUTO-GENERATED from client/ by scripts/build-client.mjs — do not edit. */',
  '/* eslint-disable */',
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(pkg.name)},`,
  '  factory(require) {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
].join('\n');
const footer = '    return module.exports;\n  },\n});\n';

const result = await build({
  absWorkingDir: root,
  entryPoints: [entry],
  outfile,
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  charset: 'utf8',
  external: [...ALLOWED_EXTERNAL],
  metafile: true,
  legalComments: 'none',
  logLevel: 'silent',
  banner: { js: banner },
  footer: { js: footer },
});

const output = result.outputFiles[0];
if (output === undefined) throw new Error('构建结果为空');
const problems = [];
const meta = result.metafile;
for (const item of Object.values(meta.outputs)) {
  for (const imported of item.imports) {
    if (imported.kind === 'external' && !ALLOWED_EXTERNAL.has(imported.path)) {
      problems.push(`产物引用了非白名单外部模块：${imported.path}`);
    }
  }
}
for (const input of Object.keys(meta.inputs)) {
  if (input.startsWith('client/') || input.startsWith('node_modules/')) continue;
  // 依赖包可能经 symlink 解析到仓库外（如 link: 的共享包 / file: 的本地包）：外部源码允许，
  // 本仓的 src/ 与 lib/ 仍然一律禁止进客户端产物。
  if (path.relative(root, path.resolve(root, input)).startsWith('..')) continue;
  problems.push(`产物包含了本仓 client/ 之外的源码：${input}`);
}
if (problems.length > 0) {
  console.error('client 构建校验失败：');
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}

if (check) {
  const current = await readFile(outfile, 'utf8').catch(() => null);
  if (current !== output.text) {
    console.error('client.js 与源码不同步；跑 npm run build:client 重新生成');
    process.exit(1);
  }
  console.log('client.js 与源码一致');
} else {
  await writeFile(outfile, output.text);
  console.log(`已写 client.js（${(output.text.length / 1024).toFixed(1)} KB）`);
}
