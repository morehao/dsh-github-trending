/**
 * Markdown 子集的纯解析层（不依赖 React，可在 Node 测试里直接跑）。
 *
 * 只覆盖核心日报实际会产出的结构：frontmatter、标题、段落、列表、引用、代码块、
 * 分隔线、GFM 表格、粗体、行内代码与链接。解析结果只包含文本与结构化节点，
 * **没有 HTML**；链接在解析阶段就做白名单（仅 http/https），渲染层不需要再判断一次。
 */
export interface InlineText {
  type: 'text';
  value: string;
}
export interface InlineStrong {
  type: 'strong';
  children: Inline[];
}
export interface InlineCode {
  type: 'code';
  value: string;
}
export interface InlineLink {
  type: 'link';
  href: string;
  children: Inline[];
}
export type Inline = InlineText | InlineStrong | InlineCode | InlineLink;

/** 表格列对齐：`---` 默认（左）、`:---` 左、`:---:` 居中、`---:` 右；缺省表示不指定。 */
export type Align = 'left' | 'center' | 'right';

export interface TableBlock {
  type: 'table';
  align: (Align | undefined)[];
  header: Inline[][];
  rows: Inline[][][];
}

export type Block =
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'quote'; children: Inline[] }
  | { type: 'code'; value: string; lang?: string }
  | { type: 'hr' }
  | TableBlock;

export interface ParsedMarkdown {
  meta: Record<string, string>;
  blocks: Block[];
}

/** 只放行 http(s)：`javascript:`、`data:`、相对路径全部按纯文本处理。 */
export function isSafeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 拆出 `---` 包裹的 frontmatter；不是 frontmatter 就原样返回。 */
export function splitFrontmatter(markdown: string): { meta: Record<string, string>; body: string } {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if ((lines[0] ?? '').trim() !== '---') return { meta: {}, body: normalized };
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() === '---') {
      end = index;
      break;
    }
  }
  if (end < 0) return { meta: {}, body: normalized };
  const meta: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key !== '') meta[key] = value;
  }
  return { meta, body: lines.slice(end + 1).join('\n') };
}

function pushText(nodes: Inline[], value: string): void {
  if (value === '') return;
  const last = nodes[nodes.length - 1];
  if (last !== undefined && last.type === 'text') {
    last.value += value;
    return;
  }
  nodes.push({ type: 'text', value });
}

const INLINE_PATTERN = /(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(`[^`\n]+`)|(!?\[[^\]\n]*\]\([^)\s]+\))/g;

/** 行内解析：粗体 / 行内代码 / 链接 / 图片（图片只保留 alt 文本）。 */
export function parseInline(text: string): Inline[] {
  const nodes: Inline[] = [];
  let cursor = 0;
  const pattern = new RegExp(INLINE_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) pushText(nodes, text.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push({ type: 'strong', children: parseInline(token.slice(2, -2)) });
    } else if (token.startsWith('`')) {
      nodes.push({ type: 'code', value: token.slice(1, -1) });
    } else {
      const image = token.startsWith('!');
      const link = /^!?\[([^\]]*)\]\(([^)]*)\)$/.exec(token);
      if (link !== null) {
        const label = link[1] ?? '';
        const href = (link[2] ?? '').trim();
        if (image) pushText(nodes, label);
        else if (isSafeUrl(href)) nodes.push({ type: 'link', href, children: parseInline(label) });
        else pushText(nodes, label);
      } else {
        pushText(nodes, token);
      }
    }
    cursor = pattern.lastIndex;
  }
  if (cursor < text.length) pushText(nodes, text.slice(cursor));
  return nodes;
}

const FENCE = /^\s*```\s*([^\s`]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const TABLE_DELIM_CELL = /^:?-+:?$/;

function isBlockStart(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || BULLET.test(line) || ORDERED.test(line);
}

/**
 * 拆一行 GFM 表格：跳过反引号里的 `|`，`\|` 还原成字面管道，首尾管道可有可无。
 * 只做切分，不做行内解析。
 */
export function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inCode = false;
  const text = line.trim();
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    const char = text[cursor] ?? '';
    if (char === '\\' && text[cursor + 1] === '|') {
      current += '|';
      cursor += 1;
      continue;
    }
    if (char === '`') {
      inCode = !inCode;
      current += char;
      continue;
    }
    if (char === '|' && !inCode) {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  if (cells.length > 1 && (cells[0] ?? '').trim() === '') cells.shift();
  if (cells.length > 1 && (cells[cells.length - 1] ?? '').trim() === '') cells.pop();
  return cells.map((cell) => cell.trim());
}

/** 解析分隔行（`| --- | :---: |`）；不是分隔行返回 null。 */
export function parseAlignRow(line: string): (Align | undefined)[] | null {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const align: (Align | undefined)[] = [];
  for (const cell of cells) {
    const value = cell.trim();
    if (!TABLE_DELIM_CELL.test(value)) return null;
    const left = value.startsWith(':');
    const right = value.endsWith(':');
    // `---`（无冒号）让浏览器用默认对齐，和 GFM 一致；这里保留 undefined 便于渲染层不写 style。
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : undefined);
  }
  return align;
}

interface ParsedTable {
  align: (Align | undefined)[];
  header: Inline[][];
  rows: Inline[][][];
  next: number;
}

/** 从 index 开始尝试解析一张表：首行必须是带 `|` 的表头，第二行是列数一致的分隔行。 */
function tableAt(lines: string[], index: number): ParsedTable | null {
  const headerLine = lines[index] ?? '';
  if (!headerLine.includes('|')) return null;
  const align = parseAlignRow(lines[index + 1] ?? '');
  if (align === null) return null;
  const headerCells = splitTableRow(headerLine);
  if (headerCells.length === 0 || headerCells.length !== align.length) return null;
  const rows: Inline[][][] = [];
  let cursor = index + 2;
  while (cursor < lines.length) {
    const line = lines[cursor] ?? '';
    if (line.trim() === '' || !line.includes('|')) break;
    if (isBlockStart(line)) break;
    const cells = splitTableRow(line).slice(0, headerCells.length);
    while (cells.length < headerCells.length) cells.push('');
    rows.push(cells.map((cell) => parseInline(cell)));
    cursor += 1;
  }
  return { align, header: headerCells.map((cell) => parseInline(cell)), rows, next: cursor };
}

export function parseBlocks(body: string): Block[] {
  const lines = body.split('\n');
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const lang = fence[1] ?? '';
      index += 1;
      const buffer: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        if (/^\s*```\s*$/.test(current)) {
          index += 1;
          break;
        }
        buffer.push(current);
        index += 1;
      }
      blocks.push({ type: 'code', value: buffer.join('\n'), ...(lang === '' ? {} : { lang }) });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({ type: 'heading', level: (heading[1] ?? '#').length, children: parseInline((heading[2] ?? '').trim()) });
      index += 1;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: 'hr' });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const buffer: string[] = [];
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index] ?? '');
        if (match === null) break;
        buffer.push(match[1] ?? '');
        index += 1;
      }
      blocks.push({ type: 'quote', children: parseInline(buffer.join(' ').trim()) });
      continue;
    }

    if (BULLET.test(line)) {
      const items: Inline[][] = [];
      while (index < lines.length) {
        const match = BULLET.exec(lines[index] ?? '');
        if (match === null) break;
        items.push(parseInline((match[1] ?? '').trim()));
        index += 1;
      }
      blocks.push({ type: 'list', ordered: false, items });
      continue;
    }

    if (ORDERED.test(line)) {
      const items: Inline[][] = [];
      while (index < lines.length) {
        const match = ORDERED.exec(lines[index] ?? '');
        if (match === null) break;
        items.push(parseInline((match[1] ?? '').trim()));
        index += 1;
      }
      blocks.push({ type: 'list', ordered: true, items });
      continue;
    }

    const table = tableAt(lines, index);
    if (table !== null) {
      blocks.push({ type: 'table', align: table.align, header: table.header, rows: table.rows });
      index = table.next;
      continue;
    }

    const buffer: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (current.trim() === '') break;
      if (buffer.length > 0 && (isBlockStart(current) || tableAt(lines, index) !== null)) break;
      buffer.push(current.trim());
      index += 1;
    }
    blocks.push({ type: 'paragraph', children: parseInline(buffer.join(' ')) });
  }
  return blocks;
}

export function parseMarkdown(markdown: string): ParsedMarkdown {
  const { meta, body } = splitFrontmatter(markdown);
  return { meta, blocks: parseBlocks(body) };
}
