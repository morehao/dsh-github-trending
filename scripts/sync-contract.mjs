#!/usr/bin/env node
/**
 * 契约快照同步 / 校验。
 *
 *   node scripts/sync-contract.mjs --ref <sha|tag> [--src <trendradar-dir>]
 *       从上游 git 对象（不是工作区）导出 contract/{schema,fixtures,CONTRACT.sha256}，
 *       逐文件重算 sha256 与 aggregate，与上游 CONTRACT.sha256 对齐后写入本包，
 *       并写 contract/UPSTREAM.json（ref / commit / aggregate / 文件清单）。
 *
 *   node scripts/sync-contract.mjs --check
 *       只用本地 contract/ 重算，与 UPSTREAM.json 比对；不联网、不需要上游仓库。
 *
 * 为什么读 git 对象而不是工作区：快照必须对应一个确定 commit，工作区可能有未提交改动。
 * 为什么本地也重算：CONTRACT.sha256 里的 aggregate 是「每文件 sha256 行按路径排序后再 sha256」，
 * 抄错一个字节就应当在同步时失败，而不是等到插件运行时。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const contractDir = path.join(root, 'contract');
const upstreamPath = path.join(contractDir, 'UPSTREAM.json');
const SCOPES = ['contract/schema', 'contract/fixtures'];

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] ?? '') : undefined;
};
const has = (name) => argv.includes(name);

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** 上游 CONTRACT.sha256 → { files: Map<relPath, sha>, aggregate } */
export function parseManifest(text) {
  const files = new Map();
  let aggregate = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const aggregateMatch = /^aggregate:\s*([0-9a-f]{64})$/.exec(line);
    if (aggregateMatch) {
      aggregate = aggregateMatch[1];
      continue;
    }
    const match = /^([0-9a-f]{64})\s{2}(.+)$/.exec(line);
    if (!match) throw new Error(`CONTRACT.sha256 行无法解析：${line}`);
    files.set(match[2], match[1]);
  }
  if (aggregate === null) throw new Error('CONTRACT.sha256 缺少 aggregate 行');
  return { files, aggregate };
}

/** 按上游同一算法重算本地 contract/ 的每文件哈希与 aggregate。 */
export function computeLocal(dir = contractDir) {
  const entries = [];
  for (const scope of ['schema', 'fixtures']) {
    const abs = path.join(dir, scope);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      const full = path.join(abs, name);
      const stat = readFileSync(full);
      entries.push({ path: `${scope}/${name}`, sha256: sha256(stat) });
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // 与上游 tools/contracthash 完全一致：每行结尾都带 "\n"（包括最后一行）。
  const lines = entries.map((entry) => `${entry.sha256}  ${entry.path}\n`).join('');
  return { files: entries, aggregate: sha256(lines) };
}

function git(args, cwd, encoding = 'utf8') {
  return execFileSync('git', args, { cwd, encoding, maxBuffer: 64 * 1024 * 1024 });
}

function sync({ ref, src }) {
  const source = path.resolve(src ?? process.env.TRENDRADAR_DIR ?? path.join(root, '..', 'trendradar'));
  if (!existsSync(path.join(source, '.git'))) {
    throw new Error(
      `上游源码目录不存在或不是 git 仓库：${source}\n` +
        '用法：node scripts/sync-contract.mjs --ref <sha> --src /path/to/trendradar（或设 TRENDRADAR_DIR）',
    );
  }
  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`], source).trim();
  const remote = git(['config', '--get', 'remote.origin.url'], source).trim();
  const manifestText = git(['show', `${commit}:contract/CONTRACT.sha256`], source);
  const expected = parseManifest(manifestText);

  const paths = SCOPES.flatMap((scope) =>
    git(['ls-tree', '-r', '--name-only', commit, '--', scope], source)
      .split('\n')
      .filter((item) => item.trim() !== ''),
  );

  const files = paths.map((repoPath) => {
    const rel = repoPath.replace(/^contract\//, '');
    const buffer = git(['show', `${commit}:${repoPath}`], source, 'buffer');
    const digest = sha256(buffer);
    const expectedDigest = expected.files.get(rel);
    if (expectedDigest !== digest) {
      throw new Error(`sha256 不一致：${rel} 期望 ${expectedDigest ?? '(缺失)'}，实际 ${digest}`);
    }
    return { path: rel, sha256: digest, buffer };
  });
  if (files.length !== expected.files.size) {
    throw new Error(`文件数不一致：上游清单 ${expected.files.size} 个，git 树 ${files.length} 个`);
  }

  // 顺序以「路径」为准（上游先 sort 路径再逐条哈希），不能对整行排序。
  const aggregate = sha256(
    files
      .slice()
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((file) => `${file.sha256}  ${file.path}\n`)
      .join(''),
  );
  if (aggregate !== expected.aggregate) {
    throw new Error(`aggregate 不一致：清单 ${expected.aggregate}，重算 ${aggregate}`);
  }

  for (const scope of ['schema', 'fixtures']) {
    rmSync(path.join(contractDir, scope), { recursive: true, force: true });
    mkdirSync(path.join(contractDir, scope), { recursive: true });
  }
  for (const file of files) {
    writeFileSync(path.join(contractDir, file.path), file.buffer);
  }
  writeFileSync(path.join(contractDir, 'CONTRACT.sha256'), manifestText);
  // ref 是 tag（vX.Y.Z）时，同时把「要下载的核心版本」写进 package.json 的 dsh.core：
  // 契约来源与二进制版本必须是同一个值，否则插件会下载另一个版本的核心。
  const tagMatch = /^v?(\d+\.\d+\.\d+(?:-[\w.]+)?)$/.exec(ref.trim());
  if (tagMatch !== null) {
    const pkgPath = path.join(root, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const slug = /^https?:\/\/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/.exec(remote.replace(/\.git$/, ''));
    const dsh = pkg.dsh ?? {};
    dsh.core = {
      repo: slug === null ? (dsh.core?.repo ?? '') : slug[1],
      version: tagMatch[1],
    };
    pkg.dsh = dsh;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`package.json dsh.core → ${dsh.core.repo}@${dsh.core.version}`);
  } else {
    console.log(`ref 不是 tag（${ref}），未更新 dsh.core.version`);
  }

  writeFileSync(
    upstreamPath,
    `${JSON.stringify(
      {
        repo: remote,
        ref,
        commit,
        aggregate,
        syncedAt: new Date().toISOString(),
        files: files.map((file) => ({ path: file.path, sha256: file.sha256 })),
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `contract 已同步：${remote}@${commit.slice(0, 7)} · ${files.length} 个文件 · aggregate ${aggregate}`,
  );
}

function check() {
  if (!existsSync(upstreamPath)) throw new Error('缺少 contract/UPSTREAM.json；先跑一次 --ref 同步');
  const upstream = JSON.parse(readFileSync(upstreamPath, 'utf8'));
  const local = computeLocal();
  const problems = [];
  if (local.aggregate !== upstream.aggregate) {
    problems.push(`aggregate 不一致：UPSTREAM.json ${upstream.aggregate}，本地 ${local.aggregate}`);
  }
  const expected = new Map(upstream.files.map((file) => [file.path, file.sha256]));
  for (const file of local.files) {
    if (!expected.has(file.path)) problems.push(`多出文件：${file.path}`);
    else if (expected.get(file.path) !== file.sha256) problems.push(`内容被改动：${file.path}`);
  }
  for (const file of expected.keys()) {
    if (!local.files.some((item) => item.path === file)) problems.push(`缺少文件：${file}`);
  }
  if (existsSync(path.join(contractDir, 'CONTRACT.sha256'))) {
    const manifest = parseManifest(readFileSync(path.join(contractDir, 'CONTRACT.sha256'), 'utf8'));
    if (manifest.aggregate !== upstream.aggregate) {
      problems.push('contract/CONTRACT.sha256 与 UPSTREAM.json 的 aggregate 不一致');
    }
  } else {
    problems.push('缺少 contract/CONTRACT.sha256');
  }
  if (problems.length > 0) {
    console.error(`contract 校验失败（${problems.length} 项）：`);
    for (const problem of problems) console.error(`  · ${problem}`);
    process.exit(1);
  }
  console.log(
    `contract 校验通过：${upstream.commit?.slice(0, 7) ?? upstream.ref} · ${local.files.length} 个文件 · aggregate ${local.aggregate}`,
  );
}

try {
  if (has('--check')) check();
  else if (flag('--ref') !== undefined) sync({ ref: flag('--ref'), src: flag('--src') });
  else {
    console.error('用法：node scripts/sync-contract.mjs --ref <sha|tag> [--src <dir>] | --check');
    process.exit(2);
  }
} catch (error) {
  console.error(`sync-contract: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
