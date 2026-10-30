/**
 * 从本机 CLI 配置一次性导入（FR-P-14 / AC-P-12）。
 *
 * 只读、只导一次、**密钥永不导入**：`model.apiKey` 与任何 `*token*` 键在读出来之后立刻丢弃，
 * 返回里只报告「跳过了哪些键」，不返回它们的值。
 *
 * 不引入 YAML 依赖：核心配置是固定形状（两层 map + 标量 + flow 数组），
 * 这里实现一个只认这个子集的小解析器；遇到不认识的形状宁可报错，也不猜。
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_SETTINGS, normalizeSettings, PROVIDER_BASE_URLS, type Settings } from '../config.js';

export interface ImportCandidate {
  path: string;
  exists: boolean;
}

export interface ImportResult {
  ok: boolean;
  source?: string;
  settings?: Settings;
  imported: string[];
  skippedSecrets: string[];
  problems: string[];
}

/** 可能的 CLI 配置位置（按顺序取第一个存在的）。 */
export function cliConfigCandidates(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg !== undefined && xdg !== '' ? path.resolve(xdg) : path.join(home, '.config');
  return [
    env.TRENDradar_CONFIG?.trim() ?? '',
    path.join(base, 'trendradar', 'config.yaml'),
    path.join(home, '.trendradar', 'config.yaml'),
  ].filter((item) => item !== '');
}

type YamlValue = string | number | boolean | string[] | YamlMap;
interface YamlMap {
  [key: string]: YamlValue;
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1);
  return value;
}

function scalar(raw: string): YamlValue {
  const value = raw.trim();
  if (value === '') return '';
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((item) => unquote(item));
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return unquote(value);
}

/** 只支持两层缩进 map + 标量/flow 数组；其它形状直接抛错。 */
export function parseSimpleYaml(text: string): YamlMap {
  const root: YamlMap = {};
  let current: YamlMap | undefined;
  let currentIndent = -1;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const match = /^([^:#]+):(.*)$/.exec(trimmed);
    if (match === null) throw new Error(`无法解析的 YAML 行：${trimmed}`);
    const key = match[1]?.trim() ?? '';
    const rest = match[2] ?? '';
    if (rest.trim() === '') {
      const child: YamlMap = {};
      root[key] = child;
      current = child;
      currentIndent = indent;
      continue;
    }
    if (indent === 0) {
      root[key] = scalar(rest);
      current = undefined;
      currentIndent = -1;
      continue;
    }
    if (current === undefined || indent <= currentIndent) {
      // 非两层结构：把内容挂到 root（并让调用方看到「没导入」）
      root[key] = scalar(rest);
      continue;
    }
    current[key] = scalar(rest);
  }
  return root;
}

function asRecord(value: YamlValue | undefined): Record<string, YamlValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function asString(value: YamlValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function asNumber(value: YamlValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBool(value: YamlValue | undefined): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStrings(value: YamlValue | undefined): string[] | undefined {
  return Array.isArray(value) && value.length > 0 ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

/** 密钥形状的键：读到也绝不写进设置，只记名字。 */
function isSecretKey(key: string): boolean {
  return /(apikey|api_key|token|secret|password|passwd|credential)/i.test(key);
}

export function importFromCli(filePath: string, base: Settings = DEFAULT_SETTINGS): ImportResult {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      source: filePath,
      imported: [],
      skippedSecrets: [],
      problems: [`读取失败：${error instanceof Error ? error.message : String(error)}`],
    };
  }
  let parsed: YamlMap;
  try {
    parsed = parseSimpleYaml(text);
  } catch (error) {
    return {
      ok: false,
      source: filePath,
      imported: [],
      skippedSecrets: [],
      problems: [`解析失败：${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const imported: string[] = [];
  const skippedSecrets: string[] = [];
  const model = asRecord(parsed.model);
  const repo = asRecord(parsed.repo);
  const pr = asRecord(parsed.pr);
  const trending = asRecord(parsed.trending);
  const output = asRecord(parsed.output);
  const schedule = asRecord(parsed.schedule);

  const patch = JSON.parse(JSON.stringify(base)) as Settings;

  const take = <T>(keys: string[], key: string, value: T | undefined, apply: (next: T) => void): void => {
    if (value === undefined) return;
    apply(value);
    keys.push(key);
  };

  take(imported, 'model.provider', asString(model.provider), (value) => {
    patch.model.provider = value;
  });
  take(imported, 'model.model', asString(model.name), (value) => {
    patch.model.model = value;
  });
  take(imported, 'model.baseURL', asString(model.baseURL), (value) => {
    patch.model.baseURL = value;
  });
  take(imported, 'model.temperature', asNumber(model.temperature), (value) => {
    patch.model.temperature = value;
  });
  take(imported, 'model.maxTokens', asNumber(model.maxTokens), (value) => {
    patch.model.maxTokens = value;
  });
  take(imported, 'model.allowDegraded', asBool(model.allowDegraded), (value) => {
    patch.model.allowDegraded = value;
  });

  take(imported, 'repo.path', asString(repo.path), (value) => {
    patch.repo.path = value;
  });
  take(imported, 'repo.remote', asString(repo.remote), (value) => {
    patch.repo.remote = value;
  });
  take(imported, 'repo.baseBranch', asString(repo.baseBranch), (value) => {
    patch.repo.baseBranch = value;
  });
  take(imported, 'repo.authorName', asString(repo.authorName), (value) => {
    patch.repo.authorName = value;
  });
  take(imported, 'repo.authorEmail', asString(repo.authorEmail), (value) => {
    patch.repo.authorEmail = value;
  });

  take(imported, 'pr.enabled', asBool(pr.enabled), (value) => {
    patch.pr.enabled = value;
  });
  take(imported, 'pr.titleTemplate', asString(pr.titleTemplate), (value) => {
    patch.pr.titleTemplate = value;
  });
  take(imported, 'pr.autoMerge', asBool(pr.autoMerge), (value) => {
    patch.pr.autoMerge = value;
  });
  take(imported, 'pr.labels', asStrings(pr.labels), (value) => {
    patch.pr.labels = value;
  });

  take(imported, 'trending.languages', asStrings(trending.languages), (value) => {
    patch.trending.languages = value;
  });
  take(imported, 'trending.since', asString(trending.since), (value) => {
    patch.trending.since = value === 'weekly' ? 'weekly' : 'daily';
  });
  take(imported, 'trending.perLanguage', asNumber(trending.perLanguage), (value) => {
    patch.trending.topN = Math.round(value);
  });

  take(imported, 'output.dir', asString(output.dir), (value) => {
    patch.output.dir = value;
  });
  for (const [section, values] of Object.entries({ model, repo, pr, trending, output, schedule })) {
    for (const [key, value] of Object.entries(values)) {
      if (isSecretKey(key) && value !== undefined && value !== '') skippedSecrets.push(`${section}.${key}`);
    }
  }
  // 导入后不允许出现「provider 有、baseURL 空且无默认端点」的静默坏配置。
  if (patch.model.baseURL === '') {
    const fallback = PROVIDER_BASE_URLS[patch.model.provider];
    if (fallback !== undefined) patch.model.baseURL = fallback;
  }

  const problems: string[] = [];
  if (asString(schedule.cron) !== undefined) {
    problems.push('CLI 的 schedule.cron 无法映射成插件的每日时间，未导入（请在设置页重设时间）。');
  }
  if (skippedSecrets.length > 0) {
    problems.push(`密钥类字段不导入：${skippedSecrets.join('、')}（请在设置页手动填写或沿用 DSH 凭据）。`);
  }
  return {
    ok: imported.length > 0,
    source: filePath,
    settings: normalizeSettings(patch),
    imported,
    skippedSecrets,
    problems,
  };
}

/** 找到第一个存在的 CLI 配置并导入。 */
export function importFirstAvailable(env: NodeJS.ProcessEnv = process.env, base?: Settings): ImportResult {
  const candidates = cliConfigCandidates(env);
  for (const candidate of candidates) {
    const result = importFromCli(candidate, base);
    if (result.ok || result.problems.some((problem) => problem.startsWith('解析失败'))) return result;
  }
  return {
    ok: false,
    imported: [],
    skippedSecrets: [],
    problems: [`没有找到本机 CLI 配置（找过：${candidates.join('、')}）`],
  };
}
