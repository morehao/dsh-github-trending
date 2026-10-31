/**
 * Markdown 子集 → React 节点。
 *
 * 只消费 `markdown-core` 的结构化结果：文本一律作为 React 文本节点传入（由 React
 * 转义），不拼 HTML、不用 dangerouslySetInnerHTML，不渲染图片。链接已在解析阶段
 * 过滤为 http(s)，这里只负责加 `target` / `rel`。
 */
import { h } from './ui.js';
import { parseMarkdown, type Block, type Inline } from './markdown-core.js';

export interface RenderedMarkdown {
  meta: Record<string, string>;
  nodes: any[];
}

function renderInline(nodes: Inline[], prefix: string): any[] {
  return nodes.map((node, index) => {
    const key = `${prefix}-${index}`;
    switch (node.type) {
      case 'text':
        return node.value;
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

function renderBlock(block: Block, key: string): any {
  switch (block.type) {
    case 'heading': {
      const level = Math.min(Math.max(block.level, 1), 6);
      return h(`h${level}`, { key, className: `dshgt-md-h dshgt-md-h${level}` }, renderInline(block.children, key));
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
  }
}

export function renderMarkdown(markdown: string): RenderedMarkdown {
  const parsed = parseMarkdown(markdown);
  return {
    meta: parsed.meta,
    nodes: parsed.blocks.map((block, index) => renderBlock(block, `b${index}`)),
  };
}
