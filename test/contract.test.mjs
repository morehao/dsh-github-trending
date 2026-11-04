import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { contractVersion, errorCatalog, fixtures, rawSchema, validators } from '@morehao/trendradar-contract';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = '@morehao/trendradar-contract';
const contractRoot = path.join(root, 'node_modules', CONTRACT);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

const pkg = readJson(path.join(root, 'package.json'));
const contractPkg = readJson(path.join(contractRoot, 'package.json'));
const versionMap = readJson(path.join(contractRoot, 'version-map.json'));

test('契约包依赖精确锁定，且安装版本与导出一致', () => {
  const spec = pkg.dependencies?.[CONTRACT];
  assert.match(String(spec), /^\d+\.\d+\.\d+$/, `dependencies["${CONTRACT}"] 必须是精确版本`);
  assert.equal(spec, contractPkg.version, 'dependency 版本与已安装包版本不一致');
  assert.equal(contractVersion, contractPkg.version, '导出的 contractVersion 与包版本不一致');
});

test('wire 版本是 v3（ipcSchema=3 / digestSchema=2 / contractVersion 主版本 0）', () => {
  assert.equal(rawSchema.ipc.$defs.RunResult.properties.ipcSchema.const, 3);
  assert.equal(rawSchema.ipc.$defs.RunRequest.properties.ipcSchema.const, 3);
  assert.equal(rawSchema.digest.properties.schema.const, 2);
  assert.equal(rawSchema.versionInfo.properties.ipcSchema.const, 3);
  assert.equal(rawSchema.versionInfo.properties.digestSchema.const, 2);
  assert.equal(versionMap['ipc.v3.json'].current, 3);
  assert.equal(versionMap['digest.v2.json'].current, 2);
  assert.equal(String(versionMap['version-info.v2.json'].current).split('.')[0], '0');
});

test('RunResult.digest 是 ipc v3 的必填四字段（path/bytes/sha256/text）', () => {
  const digest = rawSchema.ipc.$defs.DigestArtifact;
  assert.deepEqual([...digest.required].sort(), ['bytes', 'path', 'sha256', 'text']);
  const rr = {
    ipcSchema: 3,
    ok: true,
    command: 'run',
    startedAt: '2026-11-04T00:00:00Z',
    finishedAt: '2026-11-04T00:05:00Z',
    skipped: false,
    files: [{ path: 'trending/daily/2026-11/2026-11-04.md', bytes: 5, sha256: `sha256:${'a'.repeat(64)}` }],
    digest: {
      path: 'trending/daily/2026-11/2026-11-04.md',
      bytes: 5,
      sha256: `sha256:${'a'.repeat(64)}`,
      text: '# hi\n',
    },
  };
  assert.equal(validators.runResult(rr), true);
  assert.equal(validators.runResult({ ...rr, ipcSchema: 2 }), false, 'v2 信封必须被拒');
  const { text, ...withoutText } = rr.digest;
  assert.equal(validators.runResult({ ...rr, digest: withoutText }), false, 'digest.text 必填');
});

test('v2 fixtures 全部通过对应的 ajv 校验', () => {
  // 契约 0.4.0 起 fixtures 含 digest / release / 订阅三类，各自有专用校验器。
  // 顺序有讲究：subscriptionDocNormal 不能落到 subscriptionList。
  const validatorFor = (name) => {
    if (name === 'subscriptionDocNormal') return ['subscriptionDoc', validators.subscriptionDoc];
    if (name.startsWith('subscriptions')) return ['subscriptionList', validators.subscriptionList];
    if (name.startsWith('release')) return ['releases', validators.releases];
    return ['digest', validators.digest];
  };
  for (const [name, fixture] of Object.entries(fixtures)) {
    const [validatorName, validate] = validatorFor(name);
    assert.equal(validate(fixture), true, `fixture ${name} 未通过 ${validatorName} 校验`);
  }
});

test('错误目录覆盖 17 个核心码，且与 RunResult 的 ErrorCode 枚举一致', () => {
  const catalogKeys = Object.keys(errorCatalog).sort();
  const enumValues = [...rawSchema.ipc.$defs.ErrorCode.enum].sort();
  assert.equal(catalogKeys.length, 17);
  assert.deepEqual(catalogKeys, enumValues);
});

test('本地不再保留 contract/ 快照与生成器（单一来源是 npm 契约包）', () => {
  for (const stale of ['contract', 'scripts/sync-contract.mjs', 'scripts/gen-ipc-types.mjs', 'src/ipc.gen.ts']) {
    assert.equal(existsSync(path.join(root, stale)), false, `${stale} 应已删除`);
  }
  assert.equal((pkg.files ?? []).includes('contract'), false, 'files 不应再包含 contract');
  assert.equal(pkg.scripts?.['gen:ipc'], undefined, '不应再有 gen:ipc 脚本');
  assert.equal(pkg.scripts?.['check:contract'], 'node --test test/contract.test.mjs');
  const ipcSource = readFileSync(path.join(root, 'src/ipc.ts'), 'utf8');
  assert.match(ipcSource, /@morehao\/trendradar-contract/, 'src/ipc.ts 应从契约包取类型');
  assert.doesNotMatch(ipcSource, /ipc\.gen/, 'src/ipc.ts 不应再引用本地生成物');
});
