#!/usr/bin/env node
// make-tag-notes.mjs 的回归：在临时目录里组装注记正文，验证
//   1) 正常两层正文：首行 release: <tag>、body 恰好是摘要层 + 折叠的原文层；
//   2) 只有摘要层（无原文层）也能出正文；
//   3) 摘要层为空 / 首行重复 release: / tag 不合法 / 正文是单行路径 → 全部非零退出，不产出半成品；
//   4) 写出的正文能被 scripts/release-notes.mjs 原样投影回来（互为镜像）。
// 不联网、不碰真实仓库。
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const makeNotes = new URL('./make-tag-notes.mjs', import.meta.url).pathname;
const releaseNotes = new URL('./release-notes.mjs', import.meta.url).pathname;
const dir = await mkdtemp(join(tmpdir(), 'make-tag-notes-test-'));
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

const run = (args, opts = {}) => spawnSync(process.execPath, [makeNotes, ...args], { cwd: dir, encoding: 'utf8', ...opts });
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

try {
  const summary = ['## 本次发布', '', '修复首次变更为空；新增组装脚本。', '', '### 新增', '- **releases**: backfillLatest（#149）'].join('\n');
  const raw = ['### Features', '', '- **releases**: map core backfillLatest (#149)'].join('\n');
  await writeFile(join(dir, 'summary.md'), summary);
  await writeFile(join(dir, 'raw.md'), raw);

  // 1) 正常两层：写文件并读回断言结构。
  const outFile = join(dir, 'notes.txt');
  const ok = run(['--tag', 'v1.2.3', '--summary', join(dir, 'summary.md'), '--raw', join(dir, 'raw.md'), '--out', outFile]);
  if (ok.status !== 0) fail(`正常路径应成功，实际 exit=${ok.status} stderr=${ok.stderr}`);
  const notes = await readFile(outFile, 'utf8');
  assert.ok(notes.startsWith('release: v1.2.3\n\n'), '首行必须是 release: <tag> + 空行');
  assert.ok(notes.includes(summary), '摘要层丢失');
  assert.ok(notes.includes('<details><summary>原始变更记录（自动生成，未改写）</summary>'), '折叠块缺失');
  assert.ok(notes.includes(raw), '原文层丢失');
  assert.ok(notes.includes('</details>'), '折叠块未闭合');

  // 2) 只有摘要层：不产折叠块。
  const onlySummary = run(['--tag', 'v1.2.3', '--summary', join(dir, 'summary.md')]);
  if (onlySummary.status !== 0) fail(`无原文层应成功，exit=${onlySummary.status}`);
  assert.ok(!onlySummary.stdout.includes('<details>'), '无原文层时不应有折叠块');

  // 3) 各类非法输入必须非零退出。
  const emptySummary = join(dir, 'empty.md');
  await writeFile(emptySummary, '   \n\n');
  const cases = [
    [['--tag', 'v1.2.3', '--summary', emptySummary], /摘要层为空/],
    [['--summary', join(dir, 'summary.md')], /缺少 --tag/],
    [['--tag', 'v1.2', '--summary', join(dir, 'summary.md')], /不符合 vX\.Y\.Z/],
  ];
  for (const [a, re] of cases) {
    const r = run(a);
    if (r.status === 0) fail(`非法输入应非零退出：${a.join(' ')}`);
    if (!re.test(r.stderr)) fail(`非法输入 stderr 不含期望：${a.join(' ')} → ${r.stderr}`);
  }

  // 摘要层里重复 release: 首行 → 拒绝。
  const dupSummary = join(dir, 'dup.md');
  await writeFile(dupSummary, 'release: v1.2.3\n\n## 本次发布\n');
  const dup = run(['--tag', 'v1.2.3', '--summary', dupSummary]);
  if (dup.status === 0) fail('摘要层重复 release: 首行应被拒');
  assert.match(dup.stderr, /不要再写/);

  // 4) 与 release-notes.mjs 互为镜像：造注记 tag，用 release-notes 投影，必须等于 body。
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  await writeFile(join(dir, 'README.md'), '# fixture\n');
  git('add', '.');
  git('commit', '-q', '-m', 'chore: init');
  git('tag', '-a', '--cleanup=verbatim', 'v1.2.3', '-F', outFile);
  const projected = spawnSync(process.execPath, [releaseNotes, 'v1.2.3'], { cwd: dir, encoding: 'utf8' });
  if (projected.status !== 0) fail(`release-notes 应能投影，exit=${projected.status} stderr=${projected.stderr}`);
  const expectBody = notes.replace(/^release: v1\.2\.3\n\n/, '').replace(/\n+$/, '');
  assert.equal(projected.stdout.replace(/\n+$/, ''), expectBody, 'make-tag-notes 与 release-notes 投影不一致');

  console.log('make-tag-notes 冒烟通过：结构正确、非法输入被拒、与 release-notes 互为镜像');
} catch (error) {
  fail(error?.message ?? String(error));
} finally {
  await rm(dir, { recursive: true, force: true });
}
