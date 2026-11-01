/**
 * 插件自身元数据：包名、版本、仓库地址。
 *
 * `/state.plugin` 是界面上「关于」的唯一来源：版本不能硬编码在客户端，仓库地址
 * 也不能从客户端猜。`package.json.repository.url` 常见形态是
 * `git+https://github.com/o/r.git` 或 `git@github.com:o/r.git`，统一规范化成
 * `https://github.com/o/r`；解析不了就返回 undefined，界面隐藏外链而不是猜。
 *
 * 读包与规范化仓库地址都交给 `@morehao/dsh-plugin-kit` 的 `./meta` + `./github`；
 * 这里保留 `readPluginInfo()` / `normalizeRepositoryUrl()` 两个对内部（测试与 index）
 * 的既有导出面，形状不变。
 */
import { normalizeRepositoryUrl } from '@morehao/dsh-plugin-kit/github';
import { createPluginMeta } from '@morehao/dsh-plugin-kit/meta';

export { normalizeRepositoryUrl };

export interface PluginInfo {
  name: string;
  version: string;
  repository?: string;
}

const DEFAULT_NAME = '@morehao/dsh-github-trending';

const PKG_URL = new URL('../package.json', import.meta.url);

export function readPluginInfo(): PluginInfo {
  const meta = createPluginMeta({ pkgUrl: PKG_URL, defaultName: DEFAULT_NAME });
  return {
    name: meta.name,
    version: meta.version,
    ...(meta.repository === undefined ? {} : { repository: meta.repository }),
  };
}
