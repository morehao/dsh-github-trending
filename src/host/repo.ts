/**
 * 只读的仓库信息探测：读取目标仓库的**默认分支**，供设置页只读展示。
 *
 * 边界（与 AGENTS「插件不碰用户仓库」一致）：这里只做 `git symbolic-ref` /
 * `rev-parse` 这类只读查询，绝不 commit / push / 改工作树。写仓库仍全部在核心进程里。
 * 路径来自用户选择的目录，先做绝对路径 + 存在性校验，再作为 argv 传给 git（不拼 shell）。
 */
import { statSync } from 'node:fs';
import path from 'node:path';

import { execCapture } from '../core/exec.js';

export interface DefaultBranchResult {
  branch?: string;
  /** `origin-head` = 远端默认分支；`head` = 本地当前分支兜底；`none` = 读不到。 */
  source: 'origin-head' | 'head' | 'none';
  message?: string;
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** 只读执行一次 git；spawn 失败（比如本机没有 git）时按「读不到」处理，绝不抛。 */
async function git(dir: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const result = await execCapture('git', ['-C', dir, ...args], { env, timeoutMs: 5000 });
    return result.code === 0 ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 读取仓库默认分支：
 *   1. `refs/remotes/origin/HEAD` → 远端默认分支（最准确）；
 *   2. 回退到本地当前分支 `HEAD`（空仓库/未 fetch 时仍能给个值）；
 *   3. 都失败返回 `none`，由界面提示。
 */
export async function readDefaultBranch(
  repoPath: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<DefaultBranchResult> {
  const dir = repoPath.trim();
  if (dir === '') return { source: 'none', message: '仓库路径为空' };
  if (!path.isAbsolute(dir)) return { source: 'none', message: '仓库路径必须是绝对路径' };
  if (!isDirectory(dir)) return { source: 'none', message: '目录不存在或不可访问' };

  const env = options.env ?? process.env;
  const origin = await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], env);
  if (origin !== undefined) {
    const branch = origin.replace(/^origin\//, '');
    if (branch !== '') return { branch, source: 'origin-head' };
  }

  const head = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], env);
  if (head !== undefined) {
    if (head !== '' && head !== 'HEAD') return { branch: head, source: 'head' };
  }

  return { source: 'none', message: '未读取到默认分支（可能是空仓库或没有 origin）' };
}
