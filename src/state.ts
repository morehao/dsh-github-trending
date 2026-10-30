/**
 * 状态与运行记录：插件是这两份数据**唯一的写者**（ADR D-12）。
 *
 * - `state.json`：`{ lastRunAt, lastDigest, lastResult, pendingPr }`，界面与工具读它；
 * - `history.json`：最近 30 条记录，超出即裁掉最旧的；
 * - `runs/<id>.log`：单次核心 stderr（已脱敏），排障用。
 *
 * 写入一律「临时文件 + rename」，权限 0600：宿主崩溃时宁可丢最后一条，也不留半个 JSON。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { normalizeSettings, type Settings } from './config.js';
import { HISTORY_FILE, SETTINGS_FILE, STATE_FILE, dataDir } from './paths.js';

export const HISTORY_LIMIT = 30;

export interface DigestIdentity {
  date: string;
  contentHash: string;
  coreVersion: string;
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
  contentHash?: string;
  branch?: string;
  commit?: string;
  prUrl?: string;
  coreVersion: string;
  model: { provider: string; model: string };
  languages: string[];
  warnings: string[];
  logFile?: string;
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

  readSettings(): Settings {
    return normalizeSettings(readJson<unknown>(this.settingsPath, {}));
  }

  writeSettings(settings: Settings): void {
    writeJsonAtomic(this.settingsPath, settings);
  }

  readState(): PluginState {
    return readJson<PluginState>(this.statePath, {});
  }

  writeState(state: PluginState): void {
    writeJsonAtomic(this.statePath, state);
  }

  readHistory(): RunRecord[] {
    const file = readJson<HistoryFile>(this.historyPath, { records: [] });
    return Array.isArray(file.records) ? file.records : [];
  }

  /** 记录一次运行：历史裁剪到 30 条，state 同步更新。 */
  recordRun(record: RunRecord, next: Partial<PluginState> = {}): void {
    const records = [record, ...this.readHistory()].slice(0, HISTORY_LIMIT);
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
}

/** 运行 id：时间前缀便于按时间排序，随机后缀避免同毫秒撞车。 */
export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const random = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${random}`;
}
