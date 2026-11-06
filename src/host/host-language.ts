/**
 * 宿主语言解析：把「显式设置」与「宿主 locale 偏好」收敛成核心 `language.outputLanguage`。
 *
 * 优先级（见执行计划 §C2 / §E「非中英回落 zh」）：
 *   1. 显式 `settings.outputLanguage`（主标签在支持集内）—— 用户明确指定，最高优先；
 *   2. 宿主 locale 的 `preference`（归一后主标签在支持集内）；
 *   3. 回落 `zh`。**中英之外一律回落 zh**（宿主是 fr/ja/de… 时产出的仍是中文）。
 *
 * 支持集首期 `{zh, en}`，与核心 `i18n` 注册表对齐。这里只做纯函数，不碰 IO，
 * 便于单测覆盖所有回落分支。
 */

/** 首期支持集（主标签）。与 `src/config.ts` 的 `SUPPORTED_OUTPUT_LANGUAGES` 同源语义。 */
export const SUPPORTED_OUTPUT_LANGUAGES: readonly string[] = ['zh', 'en'];

/** 兜底语言：任何解析不出来 / 非中英的情况都落这里。 */
export const FALLBACK_LANGUAGE = 'zh';

/**
 * 取语言标签的主标签并小写：`en-US` → `en`、`zh_CN` → `zh`、`EN` → `en`。
 * 空 / 非字符串 / 非法形态返回 `''`（交给上层回落）。
 */
export function normalizeLang(tag: unknown): string {
  if (typeof tag !== 'string') return '';
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return /^[a-z]{2,3}$/.test(primary) ? primary : '';
}

/** 归一后的主标签是否落在支持集内。 */
function isSupported(primary: string): boolean {
  return primary !== '' && SUPPORTED_OUTPUT_LANGUAGES.includes(primary);
}

/** 解析结果的来源：显式 settings / 宿主 locale / 兜底。 */
export type OutputLanguageSource = 'explicit' | 'host' | 'fallback';

export interface ResolvedOutputLanguage {
  /** 最终下发给核心的语言（始终是支持集内的主标签，如 `zh` / `en`）。 */
  language: string;
  /** 这个值从哪来，供 `/state` 展示。 */
  source: OutputLanguageSource;
  /** 宿主偏好的归一标签（未归一成功时为空串），供设置页「跟随宿主({hostLang})」展示。 */
  hostLanguage: string;
}

/**
 * 解析输出语言。
 * @param explicit  `settings.outputLanguage`（`''` = 跟随宿主）
 * @param hostPref  宿主 locale 的 preference（如 `zh-CN` / `en-US` / `fr` / `undefined`）
 */
export function resolveOutputLanguage(explicit: unknown, hostPref: unknown): ResolvedOutputLanguage {
  const hostLanguage = normalizeLang(hostPref);
  const explicitPrimary = normalizeLang(explicit);
  if (isSupported(explicitPrimary)) {
    return { language: explicitPrimary, source: 'explicit', hostLanguage };
  }
  if (isSupported(hostLanguage)) {
    return { language: hostLanguage, source: 'host', hostLanguage };
  }
  return { language: FALLBACK_LANGUAGE, source: 'fallback', hostLanguage };
}
