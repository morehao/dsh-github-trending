/**
 * 错误码：核心码（契约包 `ipc.v2` / `errors.v2` 的 17 个）+ 插件自己的码。
 *
 * 核心当前只在 stderr 打 `error: <CODE>: <message>`，模型/抓取的失败甚至没有码，
 * 所以这里承担两件事：
 *   1. 从 stderr 里**优先**取出核心自己的码（有码就用码，不改写）；
 *   2. 没有码时按稳定的文本特征归类，归类结果会标注 `inferred: true`，
 *      让界面能区分「核心说的」与「插件猜的」。
 */
import type { ErrorCode } from '@morehao/trendradar-contract';

/** 插件在核心之外新增的码。前缀统一避免与核心码冲突。 */
export const PLUGIN_CODES = [
  'CORE_UNAVAILABLE',
  'CORE_INCOMPATIBLE',
  'CORE_SPAWN_FAILED',
  'CORE_TIMEOUT',
  'CORE_CANCELLED',
  'CORE_CONFIG_CHANNEL_FAILED',
  'CORE_NOT_DOWNLOADED',
  'CORE_CHECKSUM_MISMATCH',
  'IPC_INVALID',
  'MODEL_KEY_MISSING',
  'MODEL_NOT_FOUND',
  'MODEL_PROVIDER_UNSUPPORTED',
  'GITHUB_AUTH',
  'PUSH_FAILED',
  'REPO_DIRTY',
] as const;

export type PluginCode = (typeof PLUGIN_CODES)[number];
export type AnyCode = ErrorCode | PluginCode;

export interface ClassifiedError {
  code: AnyCode;
  message: string;
  retriable: boolean;
  /** true = 插件按文本推断出来的码，不是核心明确返回的。 */
  inferred: boolean;
}

/** 重试是否有意义（与核心 `Retriable` 表保持一致，插件码另列）。 */
const RETRIABLE: Record<string, boolean> = {
  INTERNAL: true,
  CONFIG_INVALID: false,
  PAYLOAD_TOO_LARGE: false,
  FETCH_FAILED: false,
  FETCH_RATE_LIMITED: true,
  PARSE_FAILED: false,
  MODEL_UNAUTHORIZED: false,
  MODEL_RATE_LIMITED: true,
  MODEL_TIMEOUT: true,
  MODEL_FAILED: true,
  MODEL_BAD_OUTPUT: false,
  GIT_NOT_INSTALLED: false,
  REPO_NOT_GIT: false,
  REPO_DIRTY: false,
  GIT_OPERATION_FAILED: true,
  PR_FAILED: true,
  NOT_MERGEABLE: false,
  CORE_UNAVAILABLE: false,
  CORE_INCOMPATIBLE: false,
  CORE_SPAWN_FAILED: true,
  CORE_TIMEOUT: true,
  CORE_CANCELLED: false,
  CORE_CONFIG_CHANNEL_FAILED: true,
  CORE_NOT_DOWNLOADED: false,
  CORE_CHECKSUM_MISMATCH: true,
  IPC_INVALID: false,
  MODEL_KEY_MISSING: false,
  MODEL_NOT_FOUND: false,
  MODEL_PROVIDER_UNSUPPORTED: false,
  GITHUB_AUTH: false,
  PUSH_FAILED: true,
};

export function isRetriable(code: string): boolean {
  return RETRIABLE[code] === true;
}

/** 错误码 → 界面落点。UI 用这个决定红字出现在哪个区块。 */
export type ErrorArea = 'core' | 'model' | 'repo' | 'auth' | 'run';

export function areaOf(code: string): ErrorArea {
  if (code.startsWith('CORE_') || code === 'IPC_INVALID') return 'core';
  if (code.startsWith('MODEL_')) return 'model';
  if (code.startsWith('REPO_') || code === 'GIT_NOT_INSTALLED' || code === 'GIT_OPERATION_FAILED') return 'repo';
  if (code === 'GITHUB_AUTH') return 'auth';
  return 'run';
}

/** 每种码一句「下一步怎么做」，避免界面只给码不给路。 */
export function hintOf(code: string, message?: string): string {
  // GIT_OPERATION_FAILED 覆盖很多 git 子命令失败；带 non-fast-forward 时给最可执行的建议。
  if (code === 'GIT_OPERATION_FAILED' && typeof message === 'string' && /non-fast-forward|\[rejected\]|failed to push|fetch first/i.test(message)) {
    return '推送被拒（non-fast-forward）：远端已有同名分支且历史分叉。先合并/关闭并删除该远端分支，或让核心以 --force-with-lease 推送后重试。';
  }
  switch (code) {
    case 'CORE_UNAVAILABLE':
      return '核心二进制没找到：确认插件安装完整（含平台包），或用 TRENDING_DIGEST_CORE 指向一个可执行的 trendradar。';
    case 'CORE_INCOMPATIBLE':
      return '核心协议版本不匹配：升级插件（或升级核心），不要混搭版本。';
    case 'CORE_TIMEOUT':
      return '核心超时未返回：检查网络与模型端点；超时后不会提交任何状态。';
    case 'CORE_CANCELLED':
      return '运行已取消：核心已终止，未提交状态，也未留半成品。';
    case 'CORE_CONFIG_CHANNEL_FAILED':
      return '配置通道建立失败（FIFO 不可用）：改用临时文件模式重试，或检查目标文件系统。';
    case 'CORE_NOT_DOWNLOADED':
      return '核心还没下载：在设置页点「下载核心」（或用 TRENDING_DIGEST_CORE 指向本地核心）。首次运行需要联网。';
    case 'CORE_CHECKSUM_MISMATCH':
      return '核心二进制校验失败且已丢弃：网络代理可能改写了内容，重试一次；仍失败请手动下载后放到缓存目录。';
    case 'IPC_INVALID':
      return '核心输出不是约定的结果信封：升级插件与核心到同一版本。';
    case 'MODEL_KEY_MISSING':
      return '没有可用的模型密钥：在设置页快速填充或手动填写。';
    case 'MODEL_UNAUTHORIZED':
      return '密钥被模型端点拒绝：重新选择模型或更新密钥。';
    case 'MODEL_NOT_FOUND':
      return '端点不认识这个模型 ID：核对模型名，或换一个模型。';
    case 'MODEL_PROVIDER_UNSUPPORTED':
      return '当前核心不支持这个 provider：按核心 version --json 的 supportedProviders 选择。';
    case 'MODEL_RATE_LIMITED':
      return '模型限流：稍后重试；结果未写入任何文件。';
    case 'GIT_NOT_INSTALLED':
      return '本机没有可用的 git：安装 git ≥ 2.30 后重试。';
    case 'REPO_NOT_GIT':
      return '目标目录不是 git 仓库：插件不会替你 git init，请先建库或换目录。';
    case 'REPO_DIRTY':
      return '仓库有未提交改动：插件不 stash、不 reset，请先处理。';
    case 'GITHUB_AUTH':
      return 'GitHub 认证失效：重新连接或更新 PAT；本地 commit 会保留，可直接重试。';
    case 'NOT_MERGEABLE':
      return 'PR 无法自动合并（常见于分支保护）：PR 已保留，需人工处理。';
    case 'PUSH_FAILED':
      return '推送失败：本地 commit 已保留，修复权限/网络后重试即可复用。';
    case 'PR_FAILED':
      return '创建 PR 失败：本地 commit 与分支已保留。';
    case 'FETCH_FAILED':
      return '抓取失败：检查网络或代理；核心会在内部重试一次。';
    case 'FETCH_RATE_LIMITED':
      return 'GitHub 匿名限流：配一个 GitHub token 或稍后重试。';
    default:
      return '查看核心日志（按运行 id 归档）定位失败原因。';
  }
}

/** 核心已知码集合，用于判断 stderr 里的码是否可信。 */
const CORE_CODES = new Set<string>([
  'INTERNAL',
  'CONFIG_INVALID',
  'PAYLOAD_TOO_LARGE',
  'FETCH_FAILED',
  'FETCH_RATE_LIMITED',
  'PARSE_FAILED',
  'MODEL_UNAUTHORIZED',
  'MODEL_RATE_LIMITED',
  'MODEL_TIMEOUT',
  'MODEL_FAILED',
  'MODEL_BAD_OUTPUT',
  'GIT_NOT_INSTALLED',
  'REPO_NOT_GIT',
  'REPO_DIRTY',
  'GIT_OPERATION_FAILED',
  'PR_FAILED',
  'NOT_MERGEABLE',
]);

const TEXT_RULES: Array<{ pattern: RegExp; code: AnyCode }> = [
  { pattern: /\b401\b|unauthori[sz]ed|invalid api[ -]?key|incorrect api key|authentication (failed|error)/i, code: 'MODEL_UNAUTHORIZED' },
  { pattern: /\b404\b|model[^\n]*not found|no such model/i, code: 'MODEL_NOT_FOUND' },
  { pattern: /\b429\b|rate[ _-]?limit/i, code: 'MODEL_RATE_LIMITED' },
  { pattern: /timeout|timed out|deadline exceeded|context deadline/i, code: 'MODEL_TIMEOUT' },
  { pattern: /git not found|exec: "git"|git: command not found/i, code: 'GIT_NOT_INSTALLED' },
  { pattern: /not a git (repository|repo)|does not have any commits|bad revision/i, code: 'REPO_NOT_GIT' },
  { pattern: /working tree has tracked changes|dirty working tree/i, code: 'REPO_DIRTY' },
  { pattern: /dial tcp|no such host|connection refused|fetch trending|get "https:/i, code: 'FETCH_FAILED' },
  { pattern: /low level fetch|server misbehaving/i, code: 'FETCH_FAILED' },
];

/**
 * 从核心的 stderr 里解出一个结构化错误。
 *
 * 优先级：`error: <CODE>: ...` 的显式码 > 文本归类 > INTERNAL。
 * 显式码命中的那一行往往只是首行（如 `error: GIT_OPERATION_FAILED: To github.com:...`），
 * 真正的根因在其后的多行里（`! [rejected] ... (non-fast-forward)`、`hint: ...`），
 * 因此把这些诊断行一并保留进 message，避免界面只看到半句。
 */
export function classifyStderr(stderr: string): ClassifiedError {
  const text = stderr.trim();
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const explicit = /^(?:error:\s*)?([A-Z][A-Z0-9_]+):\s*(.*)$/;
  // 从后往前找第一条带码的行：核心的根因通常在最外层（最后打印）。
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    const match = explicit.exec(line);
    if (match !== null && CORE_CODES.has(match[1] ?? '')) {
      const code = match[1] as AnyCode;
      const detail = [(match[2] ?? '').trim(), ...lines.slice(index + 1)]
        .filter((part) => part !== '')
        .join('\n')
        .slice(0, 2000);
      return { code, message: detail || line, retriable: isRetriable(code), inferred: false };
    }
  }
  const message = lines[lines.length - 1] ?? '核心未输出错误信息';
  for (const rule of TEXT_RULES) {
    if (rule.pattern.test(text)) {
      return { code: rule.code, message, retriable: isRetriable(rule.code), inferred: true };
    }
  }
  return { code: 'INTERNAL', message, retriable: isRetriable('INTERNAL'), inferred: true };
}

/** 常见密钥形态；宁可多抹，也不把明文留在日志里。 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /(authorization\s*:\s*bearer\s+)\S+/gi,
  /("?(?:apiKey|api_key|token|access_token|secret)"?\s*[:=]\s*)"[^"]*"/gi,
];

/**
 * 脱敏：先把调用方已知的明文密钥逐个替换，再按形态兜一层。
 * 所有进日志/返回给前端的 stderr 都必须过这里（AC-P-04 的第一道闸）。
 */
export function redact(input: string, secrets: Array<string | undefined> = []): string {
  let output = input;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue;
    output = output.split(secret).join('***');
  }
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, prefix: string | undefined) =>
      typeof prefix === 'string' ? `${prefix}"***"` : '***',
    );
  }
  return output;
}
