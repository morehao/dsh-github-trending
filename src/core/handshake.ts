/**
 * 握手：`version --json` → 比对 `ipcSchema` / `digestSchema`（FR-P-07 / AC-P-07）。
 *
 * 不匹配就**不运行**，也不做「尽力兼容」。核心的协议版本是硬闸：混搭版本带来的
 * 是静默的产出差异，比一次明确的失败昂贵得多。
 */
import { execCapture } from './exec.js';
import {
  IpcError,
  IPC_SCHEMA_VERSION,
  SUPPORTED_CONTRACT_MAJOR,
  SUPPORTED_DIGEST_SCHEMA,
  parseVersionInfo,
  type VersionInfo,
} from '../ipc.js';
import type { CoreLocation } from './locate.js';

export interface HandshakeResult {
  version: VersionInfo;
  corePath: string;
  durationMs: number;
  /** 核心声明的 provider 能力；设置页据此限制 provider 选择。 */
  supportedProviders: string[];
}

export const DEFAULT_PROVIDERS = ['deepseek', 'openai-compatible'] as const;

export async function handshake(
  core: CoreLocation,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<HandshakeResult> {
  let result;
  try {
    result = await execCapture(core.path, ['version', '--json'], {
      timeoutMs: options.timeoutMs ?? 5000,
      signal: options.signal,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new IpcError('CORE_SPAWN_FAILED', `无法执行核心 ${core.path}：${detail}`);
  }
  // 取消可能发生在握手途中：这是「用户取消」，不是「核心不兼容」。
  if (result.aborted || options.signal?.aborted === true) {
    throw new IpcError('CORE_CANCELLED', '运行已取消（握手阶段）：核心进程已终止，未提交任何状态');
  }
  if (result.timedOut) {
    throw new IpcError('CORE_TIMEOUT', `核心 ${core.path} version --json 超时（5 s）未返回`);
  }
  if (result.code !== 0) {
    const tail = result.stderr.trim().split('\n').slice(-3).join(' / ');
    throw new IpcError('CORE_INCOMPATIBLE', `核心 version --json 退出码 ${result.code ?? 'null'}：${tail}`);
  }
  let version: VersionInfo;
  try {
    version = parseVersionInfo(result.stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new IpcError('CORE_INCOMPATIBLE', `核心 version --json 输出无法识别：${detail}`);
  }
  const contractMajor =
    typeof version.contractVersion === 'string' ? Number(version.contractVersion.split('.')[0]) : undefined;
  if (
    version.ipcSchema !== IPC_SCHEMA_VERSION ||
    version.digestSchema !== SUPPORTED_DIGEST_SCHEMA ||
    contractMajor !== SUPPORTED_CONTRACT_MAJOR
  ) {
    throw new IpcError(
      'CORE_INCOMPATIBLE',
      `核心协议不匹配：核心 ipcSchema=${version.ipcSchema} digestSchema=${version.digestSchema} contractVersion=${version.contractVersion ?? '(缺失)'}，` +
        `插件支持 ipcSchema=${IPC_SCHEMA_VERSION} digestSchema=${SUPPORTED_DIGEST_SCHEMA} contractVersion 主版本=${SUPPORTED_CONTRACT_MAJOR}。` +
        '请把插件与核心升级到同一版本（插件带平台包，升级插件即可）。',
    );
  }
  const supportedProviders =
    Array.isArray(version.supportedProviders) && version.supportedProviders.length > 0
      ? version.supportedProviders
      : [...DEFAULT_PROVIDERS];
  return { version, corePath: core.path, durationMs: result.durationMs, supportedProviders };
}
