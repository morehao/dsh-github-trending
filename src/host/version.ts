/**
 * 版本比较：只用于「核心是否足够新到支持某个 CLI flag」这类能力闸门。
 *
 * 核心的 `version --json` 只给 `x.y.z`（偶带预发布后缀），这里按三段数字比较，
 * 后缀忽略。不做完整 semver 区间——项目只需要「>= 阈值」这一种判断，够用且不易错。
 */

/** 解析 `1.2.3` / `v1.2.3` / `1.2.3-rc1` 成三段数字；不可解析返回 undefined。 */
function parseTriplet(value: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * `a >= b` 时返回 true。任一方不可解析时返回 false（保守：当作「不满足」，
 * 让调用方降级为不带新 flag 的行为，避免向旧核心传未知参数）。
 */
export function versionAtLeast(a: string, b: string): boolean {
  const left = parseTriplet(a);
  const right = parseTriplet(b);
  if (left === undefined || right === undefined) return false;
  for (let i = 0; i < 3; i += 1) {
    const l = left[i] as number;
    const r = right[i] as number;
    if (l > r) return true;
    if (l < r) return false;
  }
  return true;
}
