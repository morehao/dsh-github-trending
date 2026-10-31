/**
 * 插件自身元数据：包名、版本、仓库地址。
 *
 * `/state.plugin` 是界面上「关于」的唯一来源：版本不能硬编码在客户端，仓库地址
 * 也不能从客户端猜。`package.json.repository.url` 常见形态是
 * `git+https://github.com/o/r.git` 或 `git@github.com:o/r.git`，这里统一规范化成
 * `https://github.com/o/r`；解析不了就返回 undefined，界面隐藏外链而不是猜。
 */
import { createRequire } from 'node:module';

export interface PluginInfo {
  name: string;
  version: string;
  repository?: string;
}

const DEFAULT_NAME = '@morehao/dsh-github-trending';

/** 只放行 GitHub 的 http(s) 地址；ssh / git+ 前缀先归一化。 */
export function normalizeRepositoryUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let url = value.trim();
  if (url === '') return undefined;
  url = url.replace(/^git\+/i, '');
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i.exec(url);
  if (ssh !== null) url = `https://github.com/${ssh[1]}/${ssh[2]}`;
  url = url.replace(/\.git$/i, '');
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    if (parsed.hostname.toLowerCase() !== 'github.com') return undefined;
    const pathname = parsed.pathname.replace(/\/+$/, '');
    if (pathname === '') return undefined;
    return `https://github.com${pathname}`;
  } catch {
    return undefined;
  }
}

export function readPluginInfo(): PluginInfo {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as {
      name?: unknown;
      version?: unknown;
      repository?: unknown;
    };
    const repository =
      typeof pkg.repository === 'string'
        ? normalizeRepositoryUrl(pkg.repository)
        : typeof pkg.repository === 'object' && pkg.repository !== null
          ? normalizeRepositoryUrl((pkg.repository as { url?: unknown }).url)
          : undefined;
    return {
      name: typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : DEFAULT_NAME,
      version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
      ...(repository === undefined ? {} : { repository }),
    };
  } catch {
    return { name: DEFAULT_NAME, version: '0.0.0' };
  }
}
