import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// markdown.ts 依赖 ./ui.js → require('react')（peer）。测试里用最小 react stub 顶替，
// 只验证「标题锚点 / TOC / 行内高亮」这类纯逻辑，不跑真实 React 渲染。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const stubDir = mkdtempSync(path.join(tmpdir(), 'dshgt-react-stub-'));
const reactStub = path.join(stubDir, 'react.js');
writeFileSync(
  reactStub,
  [
    'export function createElement(type, props, ...children){ return { type, props: props || {}, children }; }',
    'export default { createElement };',
    'export function useState(v){ return [v, () => {}]; }',
    'export function useEffect(){}',
    'export function useRef(v){ return { current: v }; }',
    'export function useCallback(fn){ return fn; }',
    'export function useMemo(fn){ return fn(); }',
    'export const Fragment = "Fragment";',
  ].join('\n'),
);

async function loadWithStub(file) {
  const outfile = path.join(mkdtempSync(path.join(tmpdir(), 'dshgt-md-toc-')), 'markdown.mjs');
  await build({
    absWorkingDir: root,
    entryPoints: [path.join(root, 'client', file)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    alias: { react: reactStub },
  });
  return import(pathToFileURL(outfile).href);
}

const markdown = await loadWithStub('markdown.ts');

/** 从 createElement 结果里收集被渲染成元素的 heading 节点。 */
function collectHeadings(nodes) {
  const headings = [];
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const type = node.type;
    if (typeof type === 'string' && /^h[1-6]$/.test(type)) headings.push(node);
    (node.children || []).forEach(walk);
  };
  walk(nodes);
  return headings;
}

test('renderMarkdown：标题生成去重锚点 id，且 TOC 与正文 id 一致', () => {
  const rendered = markdown.renderMarkdown('## 主要变更\n\n正文\n\n## 主要变更\n\n重复标题\n\n### 升级注意');
  assert.deepEqual(
    rendered.headings.map((h) => h.text),
    ['主要变更', '主要变更', '升级注意'],
  );
  // 重名第二个标题获得 -1 后缀。
  assert.deepEqual(
    rendered.headings.map((h) => h.id),
    ['主要变更', '主要变更-1', '升级注意'],
  );
  const headingEls = collectHeadings(rendered.nodes);
  const ids = headingEls.map((el) => el.props.id);
  assert.deepEqual(ids, rendered.headings.map((h) => h.id));
});

test('renderMarkdown：无标题时 headings 为空（不造假目录）', () => {
  const rendered = markdown.renderMarkdown('一段没有标题的散文。\n\n还有一段。');
  assert.equal(rendered.headings.length, 0);
});

test('renderMarkdown：正文里的版本号与 owner/repo 被包成高亮节点，文本不变', () => {
  const rendered = markdown.renderMarkdown('本周 dsh-v0.2.2-alpha.3 与 vercel/next.js 有更新');
  // 找到 paragraph 的 children，拼接所有文本应等于原文。
  const para = rendered.nodes.find((n) => n.type === 'p');
  const flatten = (nodes) => {
    if (typeof nodes === 'string') return nodes;
    if (!Array.isArray(nodes)) {
      if (nodes === null || typeof nodes !== 'object') return '';
      return flatten(nodes.children || []);
    }
    return nodes.map(flatten).join('');
  };
  assert.equal(flatten(para.children), '本周 dsh-v0.2.2-alpha.3 与 vercel/next.js 有更新');
  // 收集所有 span 的高亮 className（嵌套在数组里）。
  const classes = [];
  const walk = (nodes) => {
    if (typeof nodes === 'string' || nodes === null || typeof nodes !== 'object') return;
    if (Array.isArray(nodes)) {
      nodes.forEach(walk);
      return;
    }
    if (nodes.props?.className === 'dshgt-md-ver' || nodes.props?.className === 'dshgt-md-repo') classes.push(nodes.props.className);
    (nodes.children || []).forEach(walk);
  };
  walk(para.children);
  assert.ok(classes.includes('dshgt-md-ver'), 'version 应被高亮');
  assert.ok(classes.includes('dshgt-md-repo'), 'owner/repo 应被高亮');
});
