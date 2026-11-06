/**
 * 从宿主的 `settings` 服务读语言偏好（`namespace: 'locale'` 的 `preference` 字段）。
 *
 * 参考本插件对 `authorization` 的懒注册做法：`apply()` 可能早于 settings 服务就绪，
 * 因此用一个「读取器」而不是一次性取值——每次运行/每次读状态时现读。
 *
 * 宿主是 Host 侧强约束服务，这里对它的**形态**保持宽容：不同小版本的 settings 服务
 * 可能暴露 `get` / `read` / `getNamespace` / 直接带 `namespace(...)` 等不同取法。任何一种
 * 能拿到 `preference` 字符串即可；全都拿不到就返回 `undefined`（上层回落 `zh`），
 * 绝不因为「宿主没这个服务」让运行失败——语言只是展示偏好，不是硬依赖。
 */

/** settings 服务的最小可用接口（只管取一个字符串字段）。 */
interface SettingsLike {
  get?: (namespace: string, field?: string) => unknown;
  read?: (namespace: string) => unknown;
  getNamespace?: (namespace: string) => unknown;
  namespace?: (namespace: string) => unknown;
  [key: string]: unknown;
}

const LOCALE_NAMESPACE = 'locale';
const PREFERENCE_FIELD = 'preference';

/** 从任意形态的 namespace 值里挖出 `preference` 字符串。 */
function preferenceOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const pref = record[PREFERENCE_FIELD];
    if (typeof pref === 'string' && pref.trim() !== '') return pref.trim();
    // 有些服务把 preference 包在 value 里（{ field, value }）。
    const inner = record.value;
    if (typeof inner === 'string' && inner.trim() !== '') return inner.trim();
  }
  return undefined;
}

/**
 * 读宿主语言偏好。`settings` 服务不可用 / 取不到值时返回 `undefined`。
 * 任何异常都吞掉（语言偏好不该让调用方炸）。
 */
export function readHostLocalePreference(settingsService: unknown): string | undefined {
  if (settingsService === undefined || settingsService === null) return undefined;
  const svc = settingsService as SettingsLike;
  const attempts: Array<() => unknown> = [
    () => (typeof svc.get === 'function' ? svc.get(LOCALE_NAMESPACE, PREFERENCE_FIELD) : undefined),
    () => (typeof svc.read === 'function' ? svc.read(LOCALE_NAMESPACE) : undefined),
    () => (typeof svc.getNamespace === 'function' ? svc.getNamespace(LOCALE_NAMESPACE) : undefined),
    () => (typeof svc.namespace === 'function' ? svc.namespace(LOCALE_NAMESPACE) : undefined),
    () => svc[LOCALE_NAMESPACE],
  ];
  for (const attempt of attempts) {
    try {
      const found = preferenceOf(attempt());
      if (found !== undefined) return found;
    } catch {
      // 换下一个取法；全都失败就走 undefined。
    }
  }
  return undefined;
}

/** 便于注入 Runner 的读取器类型：拿到当前宿主语言偏好（或 undefined）。 */
export type HostLanguageReader = () => string | undefined;

/** 用固定的 settings 服务值构造一个读取器（测试/无服务时用）。 */
export function hostLocalePreference(settingsService: unknown): HostLanguageReader {
  return () => readHostLocalePreference(settingsService);
}
