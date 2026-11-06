#!/usr/bin/env node
/**
 * 组装并**校验**发版注记正文（tag 注记 + GitHub Release body 的唯一真源）。
 *
 * 背景：注记 tag 一旦推送就不能再改正文，而失败往往是「推完才发现正文是空的/首行不对」
 * ——那时代价只能删 tag 重打。所以在**打 tag 之前**这里先把两层正文拼好并做与
 * scripts/release-notes.mjs 对称的校验，任何不合规都非零退出、不写出文件。
 *
 * 两层结构（见 git-kit release 文档）：
 *   <summary 文件>  你写的中文摘要层（## 本次发布 + 分组）
 *   <raw 文件>      scripts/changelog.sh 产出的原文层（可选；有则折叠进 <details>）
 * 输出：
 *   release: <tag>
 *   <空行>
 *   <摘要层>
 *   <空行><details>…原文层…</details>   （raw 非空时）
 *
 * 用法：
 *   node scripts/make-tag-notes.mjs --tag v0.9.12 --summary <file> [--raw <file>] [--out <file>]
 *   不传 --out 时打印到 stdout。
 *
 * 校验（任一不过即 exit 1，绝不产出半成品）：
 *   - tag 形如 vX.Y.Z（可带 -pre 后缀）；
 *   - 摘要层非空，且不含 `release:` 首行（避免重复首行）；
 *   - 组装后首行严格为 `release: <tag>`，去掉首行与空行后的 body 非空。
 * 这个脚本与 release-notes.mjs 互为镜像：这里写进去的，CI 那边必须能原样投影出来。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(`--${name}`);

const tag = opt('tag') ?? process.env.RELEASE_TAG;
const summaryPath = opt('summary');
const rawPath = opt('raw');
const outPath = opt('out');

const die = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

if (!tag) die('缺少 --tag（或设置 RELEASE_TAG）');
if (!summaryPath) die('缺少 --summary <摘要层文件>');
if (!/^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
  die(`tag 不符合 vX.Y.Z（可带 -pre 后缀）：${tag}`);
}

let summary;
try {
  summary = readFileSync(summaryPath, 'utf8');
} catch {
  die(`读不到摘要层文件：${summaryPath}`);
}
summary = summary.replace(/\n+$/, '');
if (summary.trim() === '') die('摘要层为空：至少要有「## 本次发布」和一句概述');
if (/^release:\s/i.test(summary.trimStart())) {
  die('摘要层里不要再写 `release: <tag>` 首行（本脚本会加）');
}

const raw = rawPath ? readFileSync(rawPath, 'utf8').replace(/\n+$/, '') : '';

let body = summary;
if (raw.trim() !== '') {
  body = `${summary}\n\n<details><summary>原始变更记录（自动生成，未改写）</summary>\n\n${raw}\n\n</details>`;
}

const notes = `release: ${tag}\n\n${body}\n`;

// 与 release-notes.mjs / git-kit TAGGED 读回管道对称的自检：首行对、body 非空。
const lines = notes.replace(/\n+$/, '').split('\n');
if (lines[0] !== `release: ${tag}`) die(`组装后首行不是 release: ${tag}`);
const projected = (() => {
  const l = [...lines];
  l.shift();
  if (l[0] === '') l.shift();
  return l.join('\n');
})();
if (projected.trim() === '') die('组装后正文为空：Go 会拒绝（release-notes.mjs 会报「没有变更说明」）');
if (projected.startsWith('/') && !projected.includes('\n')) {
  die('正文疑似是文件路径而不是内容——检查是否误把变量路径当正文传入');
}

if (outPath) {
  writeFileSync(outPath, notes);
  console.error(`✓ 已写出注记正文：${outPath}（${notes.length} 字节）`);
} else {
  process.stdout.write(notes);
}
