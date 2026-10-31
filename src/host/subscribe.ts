/**
 * 发版订阅：经**核心 subscribe IPC 命令**管理订阅列表（不自己写仓库）。
 *
 * 时序（core 0.7.0 / contract 0.4.0）：
 *   - 插件把 `RunRequest{ipcSchema:2, command:"subscribe", action, repo?, volume?, configPath}`
 *     JSON 写进核心 **stdin**（`subscribe --json`）；
 *   - `configPath` 指向插件生成的临时配置（与 run 同源 `toCoreConfig`），保证
 *     subscribe 与 run 解析出同一个 `<output.dir>/subscriptions.yaml`；
 *   - 核心把 payload 放进结果信封（`subscriptions` / `subscriptionDoc`）；旧核心还把
 *     `list` 逐行打到信封前，`parseSubscribeResult` 两种都认；
 *     `add/remove` 只写 `.git/trendradar-subscriptions.pending`，`run` 落盘随 PR 提交；
 *     `releases` 只读某个仓库的发版文档，**不碰工作树**。
 *
 * 插件**绝不**直接写 subscriptions.yaml，也不碰工作树——所有写操作在核心进程里完成。
 * 子进程只走 `exec.ts`（环境白名单、不拼 shell、超时兜底）。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { effectiveBaseURL, toCoreConfig, toYaml, validateSettings, type Settings } from '../config.js';
import { IpcError, parseSubscribeResult, type SubscribeAction, type SubscribeOutcome } from '../ipc.js';
import { locateCore } from '../core/locate.js';
import { execCapture, sanitizedEnv } from '../core/exec.js';
import type { Store } from '../state.js';

/** 订阅命令超时：核心只做一次 GitHub 请求/本地文件读写，8 s 足够。 */
export const SUBSCRIBE_TIMEOUT_MS = 8_000;

/**
 * `releases` 要真的读一份可能几百行的文档文件、并在缺失时回退到卷索引，
 * 比 list/add/remove 重得多；给它 30 s，避免大仓库文档被判成「无输出」。
 */
export const RELEASES_TIMEOUT_MS = 30_000;

/** `owner/repo` 形态（与契约 `RunRequest.repo` 的 pattern 一致）。 */
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isValidRepo(repo: string): boolean {
  return REPO_PATTERN.test(repo.trim());
}

export interface SubscribeDeps {
  store: Store;
  env?: NodeJS.ProcessEnv;
  /** 测试注入：跳过 locateCore，直接用给定二进制。 */
  corePath?: string;
}

/**
 * 代理模式（mode=proxy）的端点由运行期回环代理注入，设置里的 baseURL 为空；
 * 但核心 `config.Load` 不区分 run/subscribe，一律要求 baseURL 非空，否则返回
 * `config invalid: baseURL为必填字段`。订阅命令不调用模型，补一个回环占位地址即可；
 * 它永远不会被请求（list 只读本地订阅队列，add/remove 只写 pending）。
 */
const SUBSCRIBE_PLACEHOLDER_BASE_URL = 'http://127.0.0.1:9/v1';

/**
 * 把 settings 写成一份临时 YAML 配置（0600），传给核心作为 `configPath`。
 * subscribe 不解析模型，但 `config.Load` 会校验整个配置（provider/name/baseURL/repo.path
 * 必填）。因此要求设置足够完整；apiKey 不参与校验，给空串即可（密钥不落盘）。
 */
function writeTempConfig(settings: Settings): { file: string; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-subscribe-'));
  const file = path.join(dir, 'config.yml');
  const placeholder = effectiveBaseURL(settings.model) === '' ? SUBSCRIBE_PLACEHOLDER_BASE_URL : undefined;
  const yaml = `${toYaml(toCoreConfig(settings, '', placeholder))}\n`;
  writeFileSync(file, yaml, { mode: 0o600 });
  return { file, dir };
}

/** 订阅阶段的设置前置校验：repo.path 必填、模型/仓库字段满足核心 config.Load。 */
function requireUsableConfig(settings: Settings): void {
  const problems = validateSettings(settings);
  if (problems.length > 0) {
    const first = problems[0];
    throw new IpcError('CONFIG_INVALID', `配置不完整，无法管理订阅：${first?.message ?? '未知问题'}`);
  }
}

/**
 * 执行一次 subscribe 命令：`action=list` 读列表，`add/remove` 改 pending 队列，
 * `releases` 读某个仓库的发版文档。
 * 返回 `{ ok, repos, items?, doc?, error? }`；非 ok 由调用方（路由）决定转成 `SUBSCRIBE_FAILED`。
 */
export async function runSubscribe(
  input: { action: SubscribeAction; repo?: string; volume?: number },
  deps: SubscribeDeps,
): Promise<SubscribeOutcome> {
  const env = deps.env ?? process.env;
  const settings = deps.store.readSettings();
  requireUsableConfig(settings);

  if (input.action !== 'list') {
    const repo = (input.repo ?? '').trim();
    if (!isValidRepo(repo)) {
      throw new IpcError('CONFIG_INVALID', `仓库必须是 owner/repo 形态：${repo || '(空)'}`);
    }
  }
  if (input.volume !== undefined && (!Number.isInteger(input.volume) || input.volume < 1)) {
    throw new IpcError('CONFIG_INVALID', `卷号必须是正整数：${String(input.volume)}`);
  }

  const corePath = deps.corePath !== undefined
    ? deps.corePath
    : (await locateCore({ settings, env, allowDownload: settings.coreAutoDownload })).path;

  const { file, dir } = writeTempConfig(settings);
  try {
    const request = {
      ipcSchema: 2,
      command: 'subscribe',
      action: input.action,
      ...(input.action === 'list' ? {} : { repo: (input.repo ?? '').trim() }),
      // 仅 `releases` 认卷号；核心对其它 action 传 volume 会直接判 CONFIG_INVALID。
      ...(input.action === 'releases' && input.volume !== undefined ? { volume: input.volume } : {}),
      configPath: file,
    };
    const timeoutMs = input.action === 'releases' ? RELEASES_TIMEOUT_MS : SUBSCRIBE_TIMEOUT_MS;
    const result = await execCapture(corePath, ['subscribe', '--json'], {
      env: sanitizedEnv(env),
      input: JSON.stringify(request),
      timeoutMs,
    });
    if (result.timedOut) {
      throw new IpcError('SUBSCRIBE_FAILED', `订阅命令超时（${Math.round(timeoutMs / 1000)} s）`);
    }
    if (result.stdout.trim() === '') {
      const detail = result.stderr.trim();
      throw new IpcError('SUBSCRIBE_FAILED', `订阅命令无输出${detail === '' ? '' : `：${detail}`}`);
    }
    return parseSubscribeResult(result.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
