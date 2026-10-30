#!/usr/bin/env node
// 逐文件语法自检：`tsc` 只覆盖 `src/`，管不到 `scripts/`、`test/` 与 JSON 资产。
//
// 为什么扫目录而不是在 workflow 里列文件名：新增一个 `scripts/xxx.mjs` 忘了往 YAML 里加
// 就会静默漏检（兄弟仓踩过这个坑）。扫描之后，新增文件自动纳入。
//
// 只做语法/可解析性，不执行业务逻辑；行为断言请写 `test/` 或 `scripts/ac/run.mjs`。
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const problems = [];

/** 递归列出目录下的文件（相对 root 的 posix 路径）。 */
function walk(dir, into = []) {
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return into;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, into);
    else into.push(rel);
  }
  return into;
}

// 1) JS 语法：`node --check` 一次只看一个文件。
const jsFiles = [...walk('scripts'), ...walk('test')].filter((file) => /\.(mjs|cjs|js)$/.test(file));
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { cwd: root, stdio: 'pipe' });
  } catch (error) {
    problems.push(`${file}\n${error.stderr?.toString() || error.message}`);
  }
}

// 2) JSON 可解析：locale 文案会被运行时直接读，坏一个字节就报在用户面前。
const jsonFiles = [...walk('locale')].filter((file) => file.endsWith('.json'));
for (const file of jsonFiles) {
  try {
    JSON.parse(readFileSync(path.join(root, file), 'utf8'));
  } catch (error) {
    problems.push(`${file}：${error.message}`);
  }
}

// 3) locale 双语必须在位（缺一个就是设置页整片空白，而不是一句提示）。
for (const name of ['en.json', 'zh.json']) {
  if (!jsonFiles.includes(path.posix.join('locale', name))) problems.push(`缺少 locale/${name}`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  console.error(`语法自检失败：${problems.length} 处`);
  process.exit(1);
}

console.log(
  `语法自检通过：${jsFiles.length} 个 JS 文件、${jsonFiles.length} 个 JSON 可解析`,
);
