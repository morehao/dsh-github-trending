#!/usr/bin/env node
/**
 * 测试用的假核心：只实现插件依赖的两个命令面。
 *
 *   version --json   → {version, commit, ipcSchema, digestSchema, contractVersion, supportedProviders}
 *   run --config X   → 读一遍配置（验证 FIFO/临时文件通道可用），再输出契约 v2 RunResult
 *
 * 行为全部由环境变量控制，测试里按用例设置：
 *   FAKE_IPC_SCHEMA      覆盖 ipcSchema（AC-P-07）
 *   FAKE_DIGEST_SCHEMA   覆盖 digestSchema
 *   FAKE_CONTRACT_VERSION 覆盖 contractVersion
 *   FAKE_EXIT            非 0 时以该码退出并在 stderr 打一条错误（AC-P-08）
 *   FAKE_STDERR          非 0 退出时打印的 stderr 文本
 *   FAKE_SLEEP           运行前睡多少毫秒（用于取消测试）
 *   FAKE_SKIPPED         输出 skipped: true（幂等）
 *   FAKE_GARBAGE         输出非 JSON（IPC_INVALID）
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const command = argv[0];

// 契约 RunResult 的 contentHash 必须匹配 ^sha256:[0-9a-f]{64}$；用两串固定值区分
// 「配置里带密钥」与「不带密钥」两种路径。
const HASH_WITH_KEY = `sha256:${'a'.repeat(64)}`;
const HASH_NO_KEY = `sha256:${'b'.repeat(64)}`;

if (command === 'version') {
  process.stdout.write(
    JSON.stringify({
      version: '0.3.0-fake',
      commit: 'test',
      ipcSchema: Number(process.env.FAKE_IPC_SCHEMA ?? '2'),
      digestSchema: Number(process.env.FAKE_DIGEST_SCHEMA ?? '2'),
      contractVersion: process.env.FAKE_CONTRACT_VERSION ?? '0.2.0',
      supportedProviders: ['openai-compatible', 'deepseek'],
    }) + '\n',
  );
  process.exit(0);
}

if (command === 'run') {
  const index = argv.indexOf('--config');
  const configPath = index >= 0 ? argv[index + 1] : '';
  let config = '';
  try {
    config = readFileSync(configPath, 'utf8');
  } catch (error) {
    process.stderr.write(`error: CONFIG_INVALID: cannot read config ${String(error?.message ?? error)}\n`);
    process.exit(1);
  }
  const sleep = Number(process.env.FAKE_SLEEP ?? '0');
  if (sleep > 0) {
    await new Promise((resolve) => setTimeout(resolve, sleep));
  }
  if (process.env.FAKE_GARBAGE === '1') {
    process.stdout.write('not json at all\n');
    process.exit(0);
  }
  const exit = Number(process.env.FAKE_EXIT ?? '0');
  if (exit !== 0) {
    process.stderr.write(`${process.env.FAKE_STDERR ?? 'error: INTERNAL: fake failure'}\n`);
    process.exit(exit);
  }
  const skipped = process.env.FAKE_SKIPPED === '1';
  const hasKey = /apiKey:\s*"[^"]+"/.test(config);
  const now = new Date().toISOString();
  process.stdout.write(
    JSON.stringify({
      ipcSchema: 2,
      ok: true,
      command: 'run',
      startedAt: now,
      finishedAt: now,
      skipped,
      files: skipped ? [] : [{ path: 'trending/2026-10-30/all.md', bytes: 12, sha256: `sha256:${'c'.repeat(64)}` }],
      ...(skipped
        ? {}
        : {
            branch: 'trending/2026-10-30',
            commit: 'deadbeef',
            prUrl: 'https://example.invalid/pr/1',
            contentHash: hasKey ? HASH_WITH_KEY : HASH_NO_KEY,
          }),
      warnings: [],
    }) + '\n',
  );
  process.exit(0);
}

process.stderr.write(`unknown command ${command}\n`);
process.exit(2);
