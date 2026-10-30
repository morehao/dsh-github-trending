/**
 * 从 `npm pack --dry-run --json` 的输出里取出文件清单。
 *
 * 为什么不能直接 `JSON.parse(stdout)`：
 *   - npm 10 在某些环境（CI 的 10.9.9 实测）会把构建日志 / notice 混进 stdout；
 *   - 已在 release run 41083620340 复现过「两个 JSON 数组以逗号相连」的输出形态
 *     （`[...],\n[...]`），`parse` 会在第一个数组结束后报
 *     `Unexpected non-whitespace character after JSON`。
 * 因此这里扫描出所有**顶层平衡**的 JSON 值，逐个尝试，取第一个含 `files` 的数组。
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
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const first = entries[0];
    if (first && Array.isArray(first.files)) {
      return first.files.map((file) => file.path);
    }
  }
  const head = JSON.stringify(stdout.slice(0, 200));
  const tail = JSON.stringify(stdout.slice(-120));
  const reasons = tried.length === 0 ? '没有找到 JSON 值' : `尝试 ${tried.length} 段均失败：${tried[0]}`;
  throw new Error(`npm pack 未输出可解析的 JSON 清单（${reasons}）\n开头：${head}\n结尾：${tail}`);
}
