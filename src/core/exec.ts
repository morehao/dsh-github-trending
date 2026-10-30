/**
 * 子进程执行的最小封装：环境清洗、超时、取消、输出上限。
 *
 * 只做一件事：给定可执行文件与参数，拿到「退出码 + stdout + stderr」。
 * 不拼 shell、不继承全部环境（AC-P-04 的安全面）。
 */
import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

/** 传给子进程的环境变量白名单：可执行、网络代理、证书、locale、git 身份。 */
const ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_CONFIG_GLOBAL',
  'GIT_SSH_COMMAND',
];

const PROXY_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
];

export function sanitizedEnv(
  source: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...ENV_KEYS, ...PROXY_KEYS]) {
    const value = source[key];
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  return env;
}

export interface ExecOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxStdout?: number;
  maxStderr?: number;
}

function killTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // 进程已退出
  }
}

/**
 * 执行一次短命令并收集输出（握手、共存探测都走这里）。
 * 超时与取消都先 SIGTERM、3 s 后 SIGKILL——核心是单进程，不需要 process group。
 */
export async function execCapture(
  file: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxStdout = options.maxStdout ?? 1024 * 1024;
  const maxStderr = options.maxStderr ?? 1024 * 1024;
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let aborted = false;

  const hardKill = setTimeout(() => killTree(child, 'SIGKILL'), timeoutMs + 3000);
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child, 'SIGTERM');
  }, timeoutMs);
  const onAbort = (): void => {
    aborted = true;
    killTree(child, 'SIGTERM');
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    if (stdout.length < maxStdout) stdout += chunk;
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length < maxStderr) stderr += chunk;
  });

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on('error', (error) => reject(error));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  clearTimeout(timer);
  clearTimeout(hardKill);
  options.signal?.removeEventListener('abort', onAbort);

  return {
    ...result,
    stdout,
    stderr,
    timedOut,
    aborted,
    durationMs: Date.now() - started,
  };
}
