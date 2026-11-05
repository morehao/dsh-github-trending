/**
 * Markdown 子集 → React 节点。
 *
 * 只消费 `markdown-core` 的结构化结果：文本一律作为 React 文本节点传入（由 React
 * 转义），不拼 HTML、不用 dangerouslySetInnerHTML，不渲染图片。链接已在解析阶段
 * 过滤为 http(s)，这里只负责加 `target` / `rel`。
 */
import { h } from './ui.js';
import { parseMarkdown, type Align, type Block, type Inline } from './markdown-core.js';

/** 标题大纲条目：给抽屉的章节目录（TOC）用。`id` 与正文标题元素上的 `id` 一致，可点击跳转。 */
export interface HeadingToc {
  id: string;
  level: number;
  text: string;
}

export interface RenderedMarkdown {
  meta: Record<string, string>;
  nodes: any[];
  /** 正文里出现的标题大纲，按出现顺序；没有标题时为空数组。 */
  headings: HeadingToc[];
}

/** 从行内节点里抽出纯文本（用于 TOC 标签与锚点 slug）。 */
function inlineText(nodes: Inline[]): string {
  let text = '';
  for (const node of nodes) {
    if (node.type === 'text') text += node.value;
    else if (node.type === 'code') text += node.value;
    else if (node.type === 'strong' || node.type === 'link') text += inlineText(node.children);
  }
  return text;
}

/**
 * 生成锚点 slug：保留字母数字与中文，其余折叠为 `-`；为空时退回 `section`。
 * 重名由调用方加序号去重。
 */
function slugify(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'section' : slug;
}

/** 正文里的版本号 / owner/repo 这类「值得扫读」的 token：仅加等宽样式，不改写文本。 */
const HILITE_PATTERN = /(\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?\b)|(\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b)/g;

/**
 * 把一段纯文本按「版本号 / owner/repo」切成带样式的片段。
 * 只切分、不增删字符——拼起来与原文完全一致，纯表现增强。
 */
function renderTextRun(value: string, key: string): any {
  const parts: any[] = [];
  let cursor = 0;
  let seq = 0;
  const pattern = new RegExp(HILITE_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    if (match.index > cursor) parts.push(value.slice(cursor, match.index));
    parts.push(
      h('span', { key: `${key}-t${seq++}`, className: match[1] !== undefined ? 'dshgt-md-ver' : 'dshgt-md-repo' }, match[0]),
    );
    cursor = pattern.lastIndex;
  }
  if (parts.length === 0) return value;
  if (cursor < value.length) parts.push(value.slice(cursor));
  return parts;
}

function renderInline(nodes: Inline[], prefix: string): any[] {
  return nodes.map((node, index) => {
    const key = `${prefix}-${index}`;
    switch (node.type) {
      case 'text':
        return renderTextRun(node.value, key);
      case 'strong':
        return h('strong', { key }, renderInline(node.children, key));
      case 'code':
        return h('code', { key, className: 'dshgt-md-code' }, node.value);
      case 'link':
        return h(
          'a',
          { key, href: node.href, target: '_blank', rel: 'noreferrer' },
          renderInline(node.children, key),
        );
    }
  });
}

function alignStyle(align: Align | undefined): any {
  return align === undefined ? undefined : { textAlign: align };
}

function renderBlock(block: Block, key: string, headingId?: string): any {
  switch (block.type) {
    case 'heading': {
      const level = Math.min(Math.max(block.level, 1), 6);
      return h(
        `h${level}`,
        { key, className: `dshgt-md-h dshgt-md-h${level}`, ...(headingId === undefined ? {} : { id: headingId }) },
        renderInline(block.children, key),
      );
    }
    case 'paragraph':
      return h('p', { key, className: 'dshgt-md-p' }, renderInline(block.children, key));
    case 'list':
      return h(
        block.ordered ? 'ol' : 'ul',
        { key, className: 'dshgt-md-list' },
        block.items.map((item, index) => h('li', { key: `${key}-${index}` }, renderInline(item, `${key}-${index}`))),
      );
    case 'quote':
      return h('blockquote', { key, className: 'dshgt-md-quote' }, renderInline(block.children, key));
    case 'code':
      return h(
        'pre',
        { key, className: 'dshgt-md-pre', ...(block.lang === undefined ? {} : { 'data-lang': block.lang }) },
        h('code', null, block.value),
      );
    case 'hr':
      return h('hr', { key, className: 'dshgt-md-hr' });
    case 'table':
      return h(
        'div',
        { key, className: 'dshgt-md-tablewrap' },
        h(
          'table',
          { className: 'dshgt-md-table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              block.header.map((cell, index) =>
                h('th', { key: `h${index}`, style: alignStyle(block.align[index]) }, renderInline(cell, `${key}-h${index}`)),
              ),
            ),
          ),
          h(
            'tbody',
            null,
            block.rows.map((row, rowIndex) =>
              h(
                'tr',
                { key: `r${rowIndex}` },
                row.map((cell, cellIndex) =>
                  h(
                    'td',
                    { key: `c${cellIndex}`, style: alignStyle(block.align[cellIndex]) },
                    renderInline(cell, `${key}-r${rowIndex}c${cellIndex}`),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
  }
}

export function renderMarkdown(markdown: string): RenderedMarkdown {
  const parsed = parseMarkdown(markdown);
  // 先给每个标题块分配去重后的锚点 id，同时收集 TOC；再按块渲染，把 id 挂到 heading 元素上。
  const idByBlock = new Map<number, string>();
  const headings: HeadingToc[] = [];
  const used = new Set<string>();
  parsed.blocks.forEach((block, index) => {
    if (block.type !== 'heading') return;
    const text = inlineText(block.children).trim();
    if (text === '') return;
    const base = slugify(text);
    let id = base;
    let seq = 1;
    while (used.has(id)) id = `${base}-${seq++}`;
    used.add(id);
    idByBlock.set(index, id);
    headings.push({ id, level: Math.min(Math.max(block.level, 1), 6), text });
  });
  return {
    meta: parsed.meta,
    nodes: parsed.blocks.map((block, index) => renderBlock(block, `b${index}`, idByBlock.get(index))),
    headings,
  };
}
