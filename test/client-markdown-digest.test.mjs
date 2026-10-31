import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadClientModule(name) {
  const outfile = path.join(mkdtempSync(path.join(tmpdir(), 'dshgt-client-')), `${name}.mjs`);
  await build({
    absWorkingDir: root,
    entryPoints: [path.join(root, 'client', `${name}.ts`)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}

const md = await loadClientModule('markdown-core');
const digest = await loadClientModule('digest-core');

function textOf(nodes) {
  return nodes
    .map((node) => {
      if (node.type === 'text') return node.value;
      if (node.type === 'strong') return textOf(node.children);
      if (node.type === 'link') return textOf(node.children);
      return '';
    })
    .join('');
}

test('frontmatter 拆成 meta，正文从下一行开始', () => {
  const parsed = md.parseMarkdown('---\ndate: 2026-10-30\ncount: 6\n---\n# 标题\n\n正文');
  assert.equal(parsed.meta.date, '2026-10-30');
  assert.equal(parsed.meta.count, '6');
  assert.equal(parsed.blocks[0].type, 'heading');
  assert.equal(parsed.blocks[0].level, 1);
  assert.equal(textOf(parsed.blocks[0].children), '标题');
  assert.equal(parsed.blocks[1].type, 'paragraph');
});

test('块解析：段落 / 无序列表 / 有序列表 / 引用 / 代码块 / 分隔线', () => {
  const parsed = md.parseMarkdown(
    ['段落一', '', '- a', '- b', '', '1. one', '2. two', '', '> 引用', '', '```js', 'const a = 1;', '```', '', '---'].join('\n'),
  );
  assert.deepEqual(parsed.blocks.map((block) => block.type), ['paragraph', 'list', 'list', 'quote', 'code', 'hr']);
  assert.equal(parsed.blocks[1].ordered, false);
  assert.equal(parsed.blocks[2].ordered, true);
  assert.equal(parsed.blocks[4].lang, 'js');
  assert.equal(parsed.blocks[4].value, 'const a = 1;');
});

test('GFM 表格：表头 / 对齐 / 数据行 / 单元格内的链接', () => {
  const parsed = md.parseMarkdown(
    [
      '## python',
      '',
      '| 仓库 | Stars | 今日新增 | 摘要 |',
      '| --- | ---: | :---: | :--- |',
      '| [HKUDS/DeepTutor](https://github.com/HKUDS/DeepTutor) | 51,897 | +2,282 | 面向**终身学习**的辅导系统 |',
      '| [anthropics/skills](https://github.com/anthropics/skills) | 185,423 | +295 | 技能仓库 |',
      '',
      '后记',
    ].join('\n'),
  );
  assert.deepEqual(parsed.blocks.map((block) => block.type), ['heading', 'table', 'paragraph']);
  const table = parsed.blocks[1];
  assert.deepEqual(table.align, [undefined, 'right', 'center', 'left']);
  assert.deepEqual(table.header.map(textOf), ['仓库', 'Stars', '今日新增', '摘要']);
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows[1].map(textOf), ['anthropics/skills', '185,423', '+295', '技能仓库']);
  const firstCell = table.rows[0][0];
  assert.equal(firstCell[0].type, 'link');
  assert.equal(firstCell[0].href, 'https://github.com/HKUDS/DeepTutor');
  const summary = table.rows[0][3];
  assert.equal(summary.some((node) => node.type === 'strong'), true);
  assert.equal(textOf(parsed.blocks[2].children), '后记');
});

test('表格边界：列数不一致 / 缺少分隔行 / 行内代码与转义管道', () => {
  // 分隔行列数与表头不一致：不是表格，退回段落（不丢内容）。
  const mismatch = md.parseMarkdown('| a | b |\n| --- |\n| 1 | 2 |');
  assert.deepEqual(mismatch.blocks.map((block) => block.type), ['paragraph']);
  assert.equal(textOf(mismatch.blocks[0].children).includes('| a | b |'), true);
  // 没有分隔行：仍然是段落。
  const noDelim = md.parseMarkdown('| a | b |\n| 1 | 2 |');
  assert.deepEqual(noDelim.blocks.map((block) => block.type), ['paragraph']);
  // 单元格里的 `|`：反引号内保留，`\|` 还原成字面管道。
  const escaped = md.parseMarkdown(['| cmd | note |', '| --- | --- |', '| `a | b` | x \\| y |'].join('\n'));
  assert.equal(escaped.blocks[0].type, 'table');
  assert.equal(escaped.blocks[0].rows[0][0][0].value, 'a | b');
  assert.equal(textOf(escaped.blocks[0].rows[0][1]), 'x | y');
  // 表体行数不足时补空单元格，多余单元格截断。
  const ragged = md.parseMarkdown(['| a | b | c |', '| --- | --- | --- |', '| 1 |'].join('\n'));
  assert.deepEqual(ragged.blocks[0].rows[0].map(textOf), ['1', '', '']);
});

test('表格可以打断段落，紧跟的下一个块不会被吞进表格', () => {
  const parsed = md.parseMarkdown(['说明文字', '| a | b |', '| --- | --- |', '| 1 | 2 |', '- 列表项'].join('\n'));
  assert.deepEqual(parsed.blocks.map((block) => block.type), ['paragraph', 'table', 'list']);
  assert.equal(parsed.blocks[0].children.map((node) => node.value).join(''), '说明文字');
});

test('行内解析：粗体 / 行内代码 / 安全链接 / 图片只保留 alt', () => {
  const nodes = md.parseInline(
    '**粗** `code` [safe](https://example.com/x) ![alt](https://example.com/a.png) <b>raw</b>',
  );
  const links = nodes.filter((node) => node.type === 'link');
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://example.com/x');
  assert.equal(textOf(nodes).includes('alt'), true);
  assert.equal(textOf(nodes).includes('<b>raw</b>'), true);
  assert.equal(nodes.some((node) => node.type === 'code' && node.value === 'code'), true);
});

test('链接白名单：javascript: / data: / 相对路径都按文本处理', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,x', '/relative', 'mailto:a@b.c']) {
    const nodes = md.parseInline(`[label](${href})`);
    assert.equal(nodes.some((node) => node.type === 'link'), false, href);
    assert.equal(textOf(nodes).includes('label'), true);
  }
});

test('CRLF 与未闭合 frontmatter 不会抛错', () => {
  const parsed = md.parseMarkdown('---\r\ndate: x\r\n# 标题\r\n正文');
  assert.deepEqual(parsed.meta, {});
  assert.equal(parsed.blocks.some((block) => block.type === 'heading'), true);
});

test('日期分组：同一天优先成功且有预览的记录，否则最近一条', () => {
  const records = [
    { ...baseRecord('a'), at: '2026-10-30T01:00:00Z', preview: { file: 'x.md', bytes: 1, sha256: 'a' } },
    { ...baseRecord('b'), at: '2026-10-30T02:00:00Z', ok: false, errorCode: 'MODEL_RATE_LIMITED' },
    { ...baseRecord('c'), at: '2026-10-29T02:00:00Z' },
  ];
  const days = digest.buildDigestDates(records, { timeZone: 'Asia/Shanghai', now: new Date('2026-10-31T04:00:00+08:00') });
  assert.deepEqual(days.map((day) => day.date), ['2026-10-30', '2026-10-29']);
  assert.equal(days[0].record.id, 'a');
  assert.equal(days[0].status, 'preview');
  assert.equal(days[1].record.id, 'c');
  assert.equal(days[1].status, 'missing');
});

test('30 天窗口：31 天前与未来日期不出现；没有 date 的旧记录按 at 换算并标 legacy', () => {
  const records = [
    { ...baseRecord('old'), at: '2026-09-30T01:00:00Z' },
    { ...baseRecord('legacy'), at: '2026-10-29T01:00:00Z' },
    { ...baseRecord('future'), at: '2026-11-02T01:00:00Z' },
    { ...baseRecord('today'), at: '2026-10-30T20:00:00Z' },
  ];
  const days = digest.buildDigestDates(records, { timeZone: 'Asia/Shanghai', now: new Date('2026-10-31T04:00:00+08:00') });
  assert.deepEqual(days.map((day) => day.date), ['2026-10-31', '2026-10-29']);
  assert.equal(days[0].record.id, 'today');
  assert.equal(days[1].legacy, true);
});

test('状态映射：失败 / 无变更 / 试跑 / 旧记录 / 无预览', () => {
  const record = (extra) => ({ ...baseRecord('x'), ...extra });
  assert.equal(digest.digestStatus(record({ ok: false })), 'failed');
  assert.equal(digest.digestStatus(record({ skipped: true })), 'skipped');
  assert.equal(digest.digestStatus(record({ kind: 'dry-run' })), 'dry');
  assert.equal(digest.digestStatus(record({ legacy: true })), 'legacy');
  assert.equal(digest.digestStatus(record({})), 'missing');
  assert.equal(digest.digestStatus(record({ preview: { file: 'x', bytes: 1, sha256: 'a' } })), 'preview');
});

test('时区日期与最近 7 天序列', () => {
  const instant = new Date('2026-10-30T20:00:00Z');
  assert.equal(digest.zonedDateString(instant, 'Asia/Shanghai'), '2026-10-31');
  assert.equal(digest.zonedDateString(instant, 'America/New_York'), '2026-10-30');
  assert.deepEqual(digest.recentDates('2026-10-31', 3), ['2026-10-29', '2026-10-30', '2026-10-31']);
  assert.equal(digest.addDays('2026-03-01', -1), '2026-02-28');
});

test('formatBytes 输出可读大小', () => {
  assert.equal(digest.formatBytes(12), '12 B');
  assert.equal(digest.formatBytes(1536), '1.5 KB');
  assert.equal(digest.formatBytes(2 * 1024 * 1024), '2.0 MB');
  assert.equal(digest.formatBytes(Number.NaN), '—');
});

test('周期分组：日/周/月各自成组，同一天的日榜与月榜都保留', () => {
  const rec = (id, at, period, extra = {}) => ({ ...baseRecord(id), at, period, ...extra });
  const preview = (file) => ({ file, bytes: 1, sha256: 'a'.repeat(64) });
  const records = [
    rec('d1', '2026-10-31T00:31:00Z', 'daily', { date: '2026-10-31', preview: preview('trending/daily/2026-10-31.md') }),
    rec('m1', '2026-10-31T00:32:00Z', 'monthly', { date: '2026-10-31', preview: preview('trending/monthly/2026-10.md') }),
    rec('d2', '2026-10-30T00:30:00Z', 'daily', { date: '2026-10-30', preview: preview('trending/daily/2026-10-30.md') }),
    rec('w1', '2026-10-25T00:31:00Z', 'weekly', { date: '2026-10-25', preview: preview('trending/weekly/2026-W43.md') }),
  ];
  const now = new Date('2026-10-31T04:00:00+08:00');
  const groups = digest.buildPeriodGroups(records, { timeZone: 'Asia/Shanghai', now });
  const by = Object.fromEntries(groups.map((group) => [group.period, group]));
  assert.deepEqual(by.daily.days.map((day) => day.bucket), ['2026-10-31', '2026-10-30']);
  assert.deepEqual(by.monthly.days.map((day) => day.bucket), ['2026-10']);
  assert.deepEqual(by.weekly.days.map((day) => day.bucket), ['2026-W43']);
  assert.equal(by.daily.previewCount, 2);

  // 日榜日期视图不再被同一天的月榜吞并，也排除周/月记录
  const dates = digest.buildDigestDates(records, { timeZone: 'Asia/Shanghai', now });
  assert.deepEqual(dates.map((day) => day.date), ['2026-10-31', '2026-10-30']);

  assert.deepEqual(digest.digestTarget(records[1], 'Asia/Shanghai'), { period: 'monthly', bucket: '2026-10' });
  assert.deepEqual(digest.digestTarget(records[3], 'Asia/Shanghai'), { period: 'weekly', bucket: '2026-W43' });
});

function baseRecord(id) {
  return {
    id,
    at: '2026-10-30T01:00:00Z',
    kind: 'run',
    ok: true,
    skipped: false,
    durationMs: 1000,
    files: 1,
    coreVersion: '0.3.0',
    model: { provider: 'deepseek', model: 'deepseek-chat' },
    languages: ['all'],
    warnings: [],
  };
}
