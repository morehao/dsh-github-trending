/**
 * 单渠道 webhook 试发：spawn `trendradar notify --json`，复用核心真实的发送/加签链路。
 *
 * 与 `runCore` 的区别：
 * - 不抓取、不调模型、不碰仓库——核心只发一条固定测试消息；
 * - 配置里 webhook/secret 仍是 `${VAR}` 引用（不含明文密钥），经 0600 临时文件传给核心；
 * - 真实值通过 `notifyEnv` 注入子进程 env（核心从 env 展开 `${VAR}`，白名单不含这些名）。
 *
 * 结果：契约 `RunResult`（`command:"notify"`），逐渠道 `status`（sent/failed + error）
 * 在 `RunResult.notify`（`NotifyReport`）里——与「最近推送」页读同一形状。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { spawnCollect, sanitizedEnv } from '@morehao/dsh-plugin-kit/exec';

import { toCoreConfig, toYaml, type Settings } from '../config.js';
import { IpcError, type NotifyReport } from '../ipc.js';
import type { CoreLocation } from './locate.js';
import type { NotifyChannelKey } from '../config.js';

export interface NotifyTestOptions {
  core: CoreLocation;
  settings: Settings;
  /** 解析后的 `${VAR}` 真实值（键=变量名），注入子进程 env。 */
  notifyEnv?: Record<string, string>;
  /** 只测该渠道；省略 = 全部已启用渠道。 */
  channel?: NotifyChannelKey;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface NotifyTestResult {
  /** 契约 NotifyReport（逐渠道 status）。 */
  report: NotifyReport;
  /** 是否所有被尝试（非 disabled）的渠道都 sent。 */
  ok: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** 试发一次，返回契约报告。失败（无法 spawn / 输出不可解析 / 核心报错）抛 IpcError。 */
export async function notifyTest(options: NotifyTestOptions): Promise<NotifyTestResult> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-trending-notify-'));
  const cfgPath = path.join(dir, 'core.yml');
  try {
    // 0600 临时文件；内容里 webhook/secret 仍是 ${VAR}（无明文密钥）。
    const yaml = toYaml(toCoreConfig(options.settings, ''));
    await writeFile(cfgPath, yaml, { mode: 0o600 });

    const req: Record<string, unknown> = {
      ipcSchema: 4,
      command: 'notify',
      action: 'test',
      configPath: cfgPath,
    };
    if (options.channel !== undefined) req.channel = options.channel;

    const result = await spawnCollect(options.core.path, ['notify', '--json'], {
      env: sanitizedEnv(process.env, options.notifyEnv ?? {}),
      input: JSON.stringify(req),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    if (result.timedOut) throw new IpcError('CORE_TIMEOUT', '试发超时：核心未在限定时间内返回');
    if (result.error !== undefined) {
      throw new IpcError('CORE_UNAVAILABLE', `无法启动核心：${result.error.message}`);
    }

    const parsed = parseNotifyResult(result.stdout);
    return parsed;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 解析核心 `notify --json` 的 stdout 为试发结果。 */
export function parseNotifyResult(stdout: string): NotifyTestResult {
  const text = stdout.trim();
  if (text === '') throw new IpcError('IPC_INVALID', '核笔试发没有任何输出');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new IpcError('IPC_INVALID', '核笔试发输出不是 JSON');
  }
  if (typeof value !== 'object' || value === null) {
    throw new IpcError('IPC_INVALID', '核笔试发输出不是对象');
  }
  const env = value as Record<string, unknown>;
  if (env.command !== 'notify') {
    throw new IpcError('IPC_INVALID', '核笔试发不是契约 RunResult（command≠notify）');
  }
  if (env.ok !== true && env.error !== undefined) {
    const err = env.error as { code?: unknown; message?: unknown };
    const code = typeof err.code === 'string' ? err.code : 'IPC_INVALID';
    const message = typeof err.message === 'string' ? err.message : '试发失败';
    throw new IpcError(code, message);
  }
  const report = env.notify as NotifyReport | undefined;
  if (report === undefined || report === null) {
    throw new IpcError('IPC_INVALID', '核笔试发缺少 notify 报告（核心版本可能过低）');
  }
  return { report, ok: allSent(report) };
}

function allSent(report: NotifyReport): boolean {
  const active = report.messages.flatMap((m) => m.channels.filter((c) => c.status !== 'disabled'));
  return active.length > 0 && active.every((c) => c.status === 'sent');
}
