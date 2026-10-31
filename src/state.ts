/**
 * 状态与运行记录：插件是这两份数据**唯一的写者**（ADR D-12）。
 *
 * - `state.json`：`{ lastRunAt, lastDigest, lastResult, pendingPr }`，界面与工具读它；
 * - `history.json`：最近 30 条记录，超出即裁掉最旧的；
 * - `runs/<id>.log`：单次核心 stderr（已脱敏），排障用。
 *
 * 写入一律「临时文件 + rename」，权限 0600：宿主崩溃时宁可丢最后一条，也不留半个 JSON。
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { normalizeSettings, type Settings } from './config.js';
import { HISTORY_FILE, SETTINGS_FILE, STATE_FILE, dataDir } from './paths.js';

export const HISTORY_LIMIT = 30;

/** 预览副本上限：最多保留 30 份，和 history 的 30 天窗口对齐。 */
export const PREVIEW_LIMIT = 30;

/** 一次预览只读这么多字节；超过的不复制，避免把大文件塞进状态目录。 */
export const PREVIEW_MAX_BYTES = 512 * 1024;

/** 契约 v2 的固定内容哈希算法；旧版状态没有这个字段，据此识别 legacy。 */
export const CONTENT_HASH_ALGO_V2 = 'jcs-sha256-v1';

/** 契约 v2 首次随核心 0.3.0 发布；比它更旧的核心产出的是 legacy 摘要。 */
const V2_CORE_MIN: [number, number, number] = [0, 3, 0];

export interface DigestIdentity {
  date: string;
  contentHash: string;
  /** 产出该 hash 的算法；v2 新写的一律是 jcs-sha256-v1。 */
  contentHashAlgo: string;
  coreVersion: string;
}

/**
 * 预览副本的元数据：只记「哪份文件、多大、内容 sha256」，正文进 previews/。
 * `file` 是仓库内相对路径，不落绝对路径（避免把用户目录写进状态）。
 */
export interface PreviewMeta {
  file: string;
  bytes: number;
  sha256: string;
  /** 只读接口截断时为 true；当前 512 KB 上限下正常不会出现。 */
  truncated?: boolean;
}

export interface RunRecord {
  id: string;
  at: string;
  kind: 'run' | 'dry-run';
  ok: boolean;
  skipped: boolean;
  /** `null` 表示没有错误。 */
  errorCode?: string;
  errorMessage?: string;
  durationMs: number;
  files: number;
  /** 运行所属的调度时区日期（YYYY-MM-DD）；旧记录可能没有。 */
  date?: string;
  contentHash?: string;
  branch?: string;
  commit?: string;
  prUrl?: string;
  preview?: PreviewMeta;
  coreVersion: string;
  model: { provider: string; model: string };
  languages: string[];
  warnings: string[];
  logFile?: string;
  /** true = 契约 v1 时代留下的旧记录（contentHash 算法不同，不可与 v2 比较）。 */
  legacy?: boolean;
}

export interface PendingPr {
  url: string;
  createdAt: string;
  /** 该 PR 对应的 digest 日期（YYYY-MM-DD）；用于判断「同日重跑」是否真的会撞分支。 */
  date?: string;
}

export interface PluginState {
  lastRunAt?: string;
  lastDigest?: DigestIdentity;
  lastResult?: RunRecord;
  pendingPr?: PendingPr;
}

export interface HistoryFile {
  records: RunRecord[];
}

function readJson<T>(file: string, fallback: T): T {
  try {
    const text = readFileSync(file, 'utf8');
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null) return value as T;
    return fallback;
  } catch {
    return fallback;
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** 核心版本是否属于契约 v2（>= 0.3.0）。解析失败一律按 legacy 处理。 */
function coreVersionIsV2(coreVersion: unknown): boolean {
  if (typeof coreVersion !== 'string') return false;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(coreVersion.trim());
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const [minMajor, minMinor, minPatch] = V2_CORE_MIN;
  if (major !== minMajor) return major > minMajor;
  if (minor !== minMinor) return minor > minMinor;
  return patch >= minPatch;
}

function digestIsV2(digest: DigestIdentity | undefined): boolean {
  return digest !== undefined && digest.contentHashAlgo === CONTENT_HASH_ALGO_V2 && coreVersionIsV2(digest.coreVersion);
}

/** 读时清洗：legacy 的 lastDigest/pendingPr 不对外呈现，旧历史记录打 legacy 标。 */
function normalizeState(state: PluginState): PluginState {
  const next: PluginState = { ...state };
  if (next.lastDigest !== undefined && !digestIsV2(next.lastDigest)) {
    delete next.lastDigest;
    delete next.pendingPr;
  }
  if (next.lastResult !== undefined && next.lastResult.legacy !== true && !coreVersionIsV2(next.lastResult.coreVersion)) {
    next.lastResult = { ...next.lastResult, legacy: true };
  }
  return next;
}

export interface LegacyMigrationResult {
  stateChanged: boolean;
  clearedDigest: boolean;
  clearedPendingPr: boolean;
  historyMarked: number;
}

/** 原子写：同目录临时文件写完再 rename，权限 0600。 */
export function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

export interface StoreOptions {
  env?: NodeJS.ProcessEnv;
  /** 直接指定目录，测试用。 */
  dir?: string;
}

export class Store {
  readonly dir: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: StoreOptions = {}) {
    this.env = options.env ?? process.env;
    this.dir = options.dir ?? dataDir(this.env);
  }

  get settingsPath(): string {
    return path.join(this.dir, SETTINGS_FILE);
  }

  get statePath(): string {
    return path.join(this.dir, STATE_FILE);
  }

  get historyPath(): string {
    return path.join(this.dir, HISTORY_FILE);
  }

  get logsPath(): string {
    // 必须跟随 `dir`：测试与自定义数据目录都只应写在自己的目录下，绝不回落到真实 ~/.dsh。
    return path.join(this.dir, 'runs');
  }

  get previewsPath(): string {
    return path.join(this.dir, 'previews');
  }

  readSettings(): Settings {
    return normalizeSettings(readJson<unknown>(this.settingsPath, {}));
  }

  writeSettings(settings: Settings): void {
    writeJsonAtomic(this.settingsPath, settings);
  }

  readState(): PluginState {
    return normalizeState(readJson<PluginState>(this.statePath, {}));
  }

  writeState(state: PluginState): void {
    writeJsonAtomic(this.statePath, state);
  }

  /**
   * 把 v1 时代遗留的 state / history 一次性清洗落盘：清掉不可信的 lastDigest 与
   * 与之绑定的 pendingPr，并给旧历史记录打 legacy 标。插件启动时调用一次。
   */
  migrateLegacyState(): LegacyMigrationResult {
    const rawState = readJson<PluginState>(this.statePath, {});
    const nextState = normalizeState(rawState);
    const stateChanged = JSON.stringify(nextState) !== JSON.stringify(rawState);
    if (stateChanged) this.writeState(nextState);

    const rawHistory = readJson<HistoryFile>(this.historyPath, { records: [] });
    const records = Array.isArray(rawHistory.records) ? rawHistory.records : [];
    let historyMarked = 0;
    const nextRecords = records.map((record) => {
      if (record.legacy === true || coreVersionIsV2(record.coreVersion)) return record;
      historyMarked += 1;
      return { ...record, legacy: true };
    });
    if (historyMarked > 0) writeJsonAtomic(this.historyPath, { records: nextRecords });

    return {
      stateChanged,
      clearedDigest: rawState.lastDigest !== undefined && nextState.lastDigest === undefined,
      clearedPendingPr: rawState.pendingPr !== undefined && nextState.pendingPr === undefined,
      historyMarked,
    };
  }

  readHistory(): RunRecord[] {
    return this.readHistoryRaw().map((record) =>
      record.legacy === true || coreVersionIsV2(record.coreVersion) ? record : { ...record, legacy: true },
    );
  }

  /** 原始历史（不做 legacy 标注）：写入路径用它，避免把「读时标注」持久化。 */
  private readHistoryRaw(): RunRecord[] {
    const file = readJson<HistoryFile>(this.historyPath, { records: [] });
    return Array.isArray(file.records) ? file.records : [];
  }

  /** 记录一次运行：历史裁剪到 30 条，state 同步更新。 */
  recordRun(record: RunRecord, next: Partial<PluginState> = {}): void {
    const records = [record, ...this.readHistoryRaw()].slice(0, HISTORY_LIMIT);
    writeJsonAtomic(this.historyPath, { records });
    const state = this.readState();
    this.writeState({ ...state, ...next, lastResult: record });
  }

  newLogPath(id: string): string {
    ensureDir(this.logsPath);
    return path.join(this.logsPath, `${id}.log`);
  }

  appendLog(file: string, line: string): void {
    ensureDir(path.dirname(file));
    appendFileSync(file, `${line}\n`, { mode: 0o600 });
  }

  hasLog(file: string): boolean {
    return existsSync(file);
  }

  readLog(file: string, maxBytes = 64 * 1024): string {
    try {
      const text = readFileSync(file, 'utf8');
      return text.length > maxBytes ? text.slice(text.length - maxBytes) : text;
    } catch {
      return '';
    }
  }

  /** 预览副本路径；写入前才建目录，读接口不会凭空创建目录。 */
  previewPath(id: string): string {
    return path.join(this.previewsPath, `${id}.md`);
  }

  /** 写预览副本：同目录临时文件 + rename、0600；写完裁到 30 份。 */
  writePreview(id: string, text: string): void {
    ensureDir(this.previewsPath);
    const file = this.previewPath(id);
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, file);
    this.prunePreviews();
  }

  /** 读预览副本；不存在/不可读返回 undefined，超过上限时截断。 */
  readPreview(id: string, maxBytes = PREVIEW_MAX_BYTES): { text: string; truncated: boolean } | undefined {
    const file = this.previewPath(id);
    try {
      const stat = statSync(file);
      if (!stat.isFile()) return undefined;
      const truncated = stat.size > maxBytes;
      const buffer = readFileSync(file);
      return {
        text: (truncated ? buffer.subarray(0, maxBytes) : buffer).toString('utf8'),
        truncated,
      };
    } catch {
      return undefined;
    }
  }

  /** 只保留最近 `keep` 份预览副本；按 mtime 倒序，任何错误都忽略。 */
  prunePreviews(keep = PREVIEW_LIMIT): void {
    let names: string[];
    try {
      names = readdirSync(this.previewsPath);
    } catch {
      return;
    }
    const entries: Array<{ file: string; mtimeMs: number }> = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const file = path.join(this.previewsPath, name);
      try {
        const stat = statSync(file);
        if (stat.isFile()) entries.push({ file, mtimeMs: stat.mtimeMs });
      } catch {
        // 并发删除/权限问题：跳过这一份，不影响其余裁剪。
      }
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const entry of entries.slice(keep)) {
      try {
        unlinkSync(entry.file);
      } catch {
        // 忽略：下次写入时还会再尝试裁剪。
      }
    }
  }
}

/** 运行 id：时间前缀便于按时间排序，随机后缀避免同毫秒撞车。 */
export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const random = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${random}`;
}
