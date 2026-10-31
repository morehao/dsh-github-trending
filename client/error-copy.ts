/**
 * 错误原因 → 本地化文案。
 *
 * 核心在 `error.details.reason` 里给机器可判定的细分原因（stale-lease /
 * non-fast-forward / auth ...）；旧核心没有该字段时，插件侧按 stderr 文本推断。
 * 这里只做「reason → i18n key」的查表，未知 reason 返回 null，调用方回落到
 * 核心给的 hint（工具/模型用中文，界面优先用本地化文案）。
 */
import type { Translate } from './i18n.js';

export function reasonHint(t: Translate, reason: string | undefined): string | null {
  if (reason === undefined || reason === '') return null;
  const key = `err.reason.${reason}`;
  const text = t(key);
  return text === key ? null : text;
}

/** 跳过原因（merged / pr-closed / unchanged）→ 本地化文案；未知时回落到通用文案。 */
export function skipHint(t: Translate, reason: string | undefined, fallback: string): string {
  if (reason === undefined || reason === '') return fallback;
  const key = `skip.${reason}`;
  const text = t(key);
  return text === key ? fallback : text;
}
