/**
 * 从 `npm pack --dry-run --json` 的输出里取出文件清单。
 *
 * 为什么不能直接 `JSON.parse(stdout)`：输出的形状随 npm 版本变。
 *   - npm 10（Node 22 自带）：顶层是**数组** `[{ files: [...] }]`；
 *   - npm 12（release job 里 `npm install -g npm@latest` 之后）：顶层是**对象**
 *     `{ "<包名>": { files: [...] } }`（release run 41083620340 实测）。
 * 旧实现「首个 `[` 到最后一个 `]` 截取 + JSON.parse」在 npm 12 下会把 files 数组和后面的
 * `bundled` 数组连起来，报 `Unexpected non-whitespace character after JSON`。
 *
 * 因此这里扫描出所有**顶层平衡**的 JSON 值，逐个解析，再递归找第一个含 `files` 的对象。
 */

/** 从 `start` 处的 `[`/`{` 扫描到配对的收尾位置（字符串内的括号不计数），失败返回 -1。 */
function scanBalanced(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** 扫描出所有顶层平衡的 JSON 片段（前缀日志、重复输出都能被切开）。 */
export function extractJsonValues(text) {
  const values = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== '[' && ch !== '{') {
      i += 1;
      continue;
    }
    const end = scanBalanced(text, i);
    if (end === -1) break;
    values.push(text.slice(i, end));
    i = end;
  }
  return values;
}

/** 递归找一个带 `files` 数组的对象，返回文件路径列表。 */
function filesOf(value) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const files = filesOf(entry);
      if (files !== null) return files;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value.files)) {
      return value.files.map((file) => file?.path).filter((p) => typeof p === 'string');
    }
    for (const inner of Object.values(value)) {
      const files = filesOf(inner);
      if (files !== null) return files;
    }
  }
  return null;
}

/**
 * 返回 `npm pack` 清单里的文件路径数组。
 * @param {string} stdout
 * @returns {string[]}
 */
export function parsePackOutput(stdout) {
  const tried = [];
  for (const chunk of extractJsonValues(stdout)) {
    let parsed;
    try {
      parsed = JSON.parse(chunk);
    } catch (error) {
      tried.push(error.message);
      continue;
    }
    const files = filesOf(parsed);
    if (files !== null) return files;
  }
  const head = JSON.stringify(stdout.slice(0, 200));
  const tail = JSON.stringify(stdout.slice(-120));
  const reasons = tried.length === 0 ? '没有找到 JSON 值' : `尝试 ${tried.length} 段均失败：${tried[0]}`;
  throw new Error(`npm pack 未输出可解析的 JSON 清单（${reasons}）\n开头：${head}\n结尾：${tail}`);
}
