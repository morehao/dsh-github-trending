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
 *
 * 预览用例还要让「核心」真的在 temp repo 里写文件。默认行为不变（固定 artifact、不写盘）：
 *   FAKE_ARTIFACT_PATH        单个 artifact 的仓库内相对路径
 *   FAKE_ARTIFACT_CONTENT     文件内容（给空串也会真的写一个空文件）
 *   FAKE_ARTIFACT_SIZE        生成 N 个字符的内容（避免把 512 KB 塞进 env）
 *   FAKE_ARTIFACT_NUL         '1' 时在内容末尾追加 NUL 字节
 *   FAKE_ARTIFACT_SHA         覆盖 artifact.sha256（测 sha 不一致）
 *   FAKE_ARTIFACT_BYTES       覆盖 artifact.bytes
 *   FAKE_ARTIFACTS            JSON 数组，每项 {path, content?, size?, nul?, sha256?, bytes?}
 *
 * 仓库路径从核心配置的 `repo.path` 解析（配置是插件生成的 YAML，字符串统一双引号）。
 *
 * 触发来源断言：
 *   FAKE_SKIP_REASON     skipped 时附带 skipReason（merged / pr-closed / unchanged）
 *   FAKE_ECHO_TRIGGER    把 TRENDRADAR_TRIGGER 回显到 warnings，断言触发来源
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readFileSync as readStdinSync } from 'node:fs';

const argv = process.argv.slice(2);
const command = argv[0];

// 契约 RunResult 的 contentHash 必须匹配 ^sha256:[0-9a-f]{64}$；用两串固定值区分
// 「配置里带密钥」与「不带密钥」两种路径。
const HASH_WITH_KEY = `sha256:${'a'.repeat(64)}`;
const HASH_NO_KEY = `sha256:${'b'.repeat(64)}`;
const DEFAULT_ARTIFACT = { path: 'trending/2026-10-30/all.md', bytes: 12, sha256: `sha256:${'c'.repeat(64)}` };

/** 从插件生成的 YAML 配置里取 repo.path（唯一一个顶层 `path:`）。 */
function repoPathFromConfig(config) {
  const match = /^\s*path:\s*("(?:[^"\\]|\\.)*")\s*$/m.exec(config);
  if (match === null) return '';
  try {
    const value = JSON.parse(match[1]);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

function contentOf(spec) {
  if (typeof spec.content === 'string') return spec.content;
  if (typeof spec.size === 'number' && spec.size > 0) return 'x'.repeat(spec.size);
  return undefined;
}

/** 把一个 spec 落成契约 FileArtifact；有 content 时真的写进 temp repo。 */
function artifactFromSpec(spec, repoPath) {
  const file = typeof spec.path === 'string' && spec.path !== '' ? spec.path : DEFAULT_ARTIFACT.path;
  let content = contentOf(spec);
  if (spec.nul === true || spec.nul === '1') content = `${content ?? ''}\0`;
  if (content !== undefined) {
    if (repoPath === '') throw new Error('FAKE_ARTIFACT_CONTENT requires repo.path in config');
    const target = path.resolve(repoPath, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const buffer = content === undefined ? undefined : Buffer.from(content, 'utf8');
  const bytes = Number.isFinite(Number(spec.bytes)) ? Number(spec.bytes) : buffer === undefined ? DEFAULT_ARTIFACT.bytes : buffer.length;
  const sha256 =
    typeof spec.sha256 === 'string'
      ? spec.sha256
      : buffer === undefined
        ? DEFAULT_ARTIFACT.sha256
        : `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
  return { path: file, bytes, sha256 };
}

/** 本用例要输出的 artifact 列表；默认保持「固定路径 + 固定 hash、不写盘」。 */
function artifactsFor(config, skipped) {
  if (skipped) return [];
  if (typeof process.env.FAKE_ARTIFACTS === 'string' && process.env.FAKE_ARTIFACTS !== '') {
    const specs = JSON.parse(process.env.FAKE_ARTIFACTS);
    if (!Array.isArray(specs)) throw new Error('FAKE_ARTIFACTS must be a JSON array');
    const repoPath = repoPathFromConfig(config);
    return specs.map((spec) => artifactFromSpec(spec ?? {}, repoPath));
  }
  const custom =
    process.env.FAKE_ARTIFACT_PATH !== undefined ||
    process.env.FAKE_ARTIFACT_CONTENT !== undefined ||
    process.env.FAKE_ARTIFACT_SIZE !== undefined ||
    process.env.FAKE_ARTIFACT_NUL !== undefined ||
    process.env.FAKE_ARTIFACT_SHA !== undefined ||
    process.env.FAKE_ARTIFACT_BYTES !== undefined;
  if (!custom) return [DEFAULT_ARTIFACT];
  return [
    artifactFromSpec(
      {
        path: process.env.FAKE_ARTIFACT_PATH,
        content: process.env.FAKE_ARTIFACT_CONTENT,
        size: process.env.FAKE_ARTIFACT_SIZE === undefined ? undefined : Number(process.env.FAKE_ARTIFACT_SIZE),
        nul: process.env.FAKE_ARTIFACT_NUL,
        sha256: process.env.FAKE_ARTIFACT_SHA,
        bytes: process.env.FAKE_ARTIFACT_BYTES,
      },
      repoPathFromConfig(config),
    ),
  ];
}

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
  const files = artifactsFor(config, skipped);
  // 契约 0.3.0：可选 usage / releases 块。用 FAKE_USAGE_* / FAKE_RELEASES_* 控制。
  const usageSpec = process.env.FAKE_USAGE;
  let usage;
  if (usageSpec === 'unknown') {
    usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, usageKnown: false, calls: 0, retries: 0, batches: 0, cacheHits: 0 };
  } else if (usageSpec !== undefined && usageSpec !== '') {
    const total = Number(usageSpec);
    usage = { promptTokens: Math.floor(total * 0.8), completionTokens: Math.floor(total * 0.2), totalTokens: total, cachedTokens: 0, usageKnown: true, calls: 1, retries: 0, batches: 1, cacheHits: 0 };
  }
  const releasesSpec = process.env.FAKE_RELEASES;
  let releases;
  if (releasesSpec !== undefined && releasesSpec !== '') {
    if (releasesSpec === 'off') {
      releases = { enabled: false, repos: 0, newReleases: 0, durationMs: 0, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, usageKnown: false, calls: 0, retries: 0, batches: 0, cacheHits: 0 } };
    } else {
      // 形如 "repos,newReleases,tokens[,degraded,failed,skipped]"
      const [repos, newReleases, tokens, degraded, failed, skippedCount] = releasesSpec.split(',').map((part) => Number(part));
      const rTotal = Number.isFinite(tokens) ? tokens : 0;
      releases = {
        enabled: true,
        repos,
        newReleases,
        ...(Number.isFinite(degraded) ? { degraded } : {}),
        ...(Number.isFinite(failed) ? { failed } : {}),
        ...(Number.isFinite(skippedCount) ? { skipped: skippedCount } : {}),
        summarized: newReleases,
        durationMs: 1000,
        usage: { promptTokens: Math.floor(rTotal * 0.8), completionTokens: Math.floor(rTotal * 0.2), totalTokens: rTotal, cachedTokens: 0, usageKnown: true, calls: 1, retries: 0, batches: 1, cacheHits: 0 },
      };
    }
  }
  process.stdout.write(
    JSON.stringify({
      ipcSchema: 2,
      ok: true,
      command: 'run',
      startedAt: now,
      finishedAt: now,
      skipped,
      ...(skipped && process.env.FAKE_SKIP_REASON ? { skipReason: process.env.FAKE_SKIP_REASON } : {}),
      files,
      ...(skipped
        ? {}
        : {
            branch: 'trending/2026-10-30',
            commit: 'deadbeef',
            prUrl: 'https://example.invalid/pr/1',
            contentHash: hasKey ? HASH_WITH_KEY : HASH_NO_KEY,
          }),
      ...(usage === undefined ? {} : { usage }),
      ...(releases === undefined ? {} : { releases }),
      warnings: process.env.FAKE_ECHO_TRIGGER === '1' ? [`trigger=${process.env.TRENDRADAR_TRIGGER ?? ''}`] : [],
    }) + '\n',
  );
  process.exit(0);
}

if (command === 'subscribe') {
  // 读 RunRequest from stdin（`subscribe --json`）。
  let request = {};
  try {
    const raw = readStdinSync(0, 'utf8');
    request = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`error: CONFIG_INVALID: cannot read RunRequest: ${String(error?.message ?? error)}\n`);
    process.exit(1);
  }
  const action = request.action;
  const repoArg = request.repo;
  const configPath = typeof request.configPath === 'string' ? request.configPath : '';
  let config = '';
  try {
    config = readFileSync(configPath, 'utf8');
  } catch {
    config = '';
  }
  // 和真核心一样从配置推导数据仓里的订阅文件；缺省落到 configPath 同级，保证断得住。
  const repoRoot = repoPathFromConfig(config) || path.dirname(configPath || '.');
  const outMatch = /^\s*dir:\s*"((?:[^"\\]|\\.)*)"\s*$/m.exec(config);
  const outputDir = outMatch === null ? 'trending' : JSON.parse(`"${outMatch[1]}"`);
  const subsFile = path.join(repoRoot, outputDir, 'subscriptions.fake.json');
  const readList = () => {
    try {
      const value = JSON.parse(readFileSync(subsFile, 'utf8'));
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  };
  const writeList = (list) => {
    mkdirSync(path.dirname(subsFile), { recursive: true });
    writeFileSync(subsFile, JSON.stringify(list));
  };
  const now = new Date().toISOString();
  const envelope = (ok, errorCode, errorMessage) => {
    const out = { ipcSchema: 2, ok, command: 'subscribe', startedAt: now, finishedAt: now, skipped: false, files: [] };
    if (!ok) out.error = { code: errorCode, message: errorMessage, retriable: false };
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(ok ? 0 : 1);
  };
  // 与真核心 config.Load 一致：subscribe 不调用模型，但仍要求 baseURL 非空。
  // 用来守住「代理模式（baseURL 为空）管理订阅」的回归。
  const baseURLMatch = /^\s*baseURL:\s*"((?:[^"\\]|\\.)*)"\s*$/m.exec(config);
  if (baseURLMatch === null || baseURLMatch[1] === '') {
    process.stderr.write('error: config invalid: baseURL为必填字段\n');
    envelope(false, 'INTERNAL', 'config invalid: baseURL为必填字段');
  }
  if (process.env.FAKE_SUBSCRIBE_FAIL === '1') {
    envelope(false, 'CONFIG_INVALID', 'fake subscribe failure');
  }
  if (action === 'list') {
    for (const repo of readList()) process.stdout.write(`${repo}\n`);
    envelope(true);
  }
  if (action === 'add') {
    const list = readList();
    if (!repoArg || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoArg)) {
      envelope(false, 'CONFIG_INVALID', `invalid repo ${repoArg ?? ''}`);
    }
    if (!list.includes(repoArg)) {
      list.push(repoArg);
      writeList(list);
    }
    envelope(true);
  }
  if (action === 'remove') {
    const list = readList();
    if (!list.includes(repoArg)) {
      envelope(false, 'CONFIG_INVALID', `repo ${repoArg ?? ''} not subscribed`);
    }
    writeList(list.filter((repo) => repo !== repoArg));
    envelope(true);
  }
  envelope(false, 'CONFIG_INVALID', `unknown subscribe action ${action}`);
}

process.stderr.write(`unknown command ${command}\n`);
process.exit(2);
