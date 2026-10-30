#!/usr/bin/env node
/**
 * 测试用的假核心：只实现插件依赖的两个命令面。
 *
 *   version --json   → {version, commit, ipcSchema, digestSchema, supportedProviders}
 *   run --config X   → 读一遍配置（验证 FIFO/临时文件通道可用），再输出 runOutput
 *
 * 行为全部由环境变量控制，测试里按用例设置：
 *   FAKE_IPC_SCHEMA      覆盖 ipcSchema（AC-P-07）
 *   FAKE_EXIT            非 0 时以该码退出并在 stderr 打一条错误（AC-P-08）
 *   FAKE_STDERR          非 0 退出时打印的 stderr 文本
 *   FAKE_SLEEP           运行前睡多少毫秒（用于取消测试）
 *   FAKE_SKIPPED         输出 skipped: true（幂等）
 *   FAKE_GARBAGE         输出非 JSON（IPC_INVALID）
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const command = argv[0];

if (command === 'version') {
  process.stdout.write(
    JSON.stringify({
      version: '0.1.0-fake',
      commit: 'test',
      ipcSchema: Number(process.env.FAKE_IPC_SCHEMA ?? '1'),
      digestSchema: Number(process.env.FAKE_DIGEST_SCHEMA ?? '1'),
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
  process.stdout.write(
    JSON.stringify({
      files: skipped ? [] : [{ path: 'trending/2026-10-30/all.md', bytes: 12, sha256: 'sha256:abc' }],
      skipped,
      branch: skipped ? undefined : 'trending/2026-10-30',
      prUrl: skipped ? undefined : 'https://example.invalid/pr/1',
      digest: { contentHash: hasKey ? 'hash-with-key' : 'hash-no-key' },
    }) + '\n',
  );
  process.exit(0);
}

process.stderr.write(`unknown command ${command}\n`);
process.exit(2);
