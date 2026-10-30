import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(script, args) {
  try {
    return { status: 0, stdout: execFileSync(process.execPath, [path.join(root, script), ...args], { cwd: root, encoding: 'utf8' }) };
  } catch (error) {
    return { status: error.status ?? 1, stdout: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

test('contract 快照与 UPSTREAM.json 一致', () => {
  const result = run('scripts/sync-contract.mjs', ['--check']);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /contract 校验通过/);
});

test('聚合哈希与上游 CONTRACT.sha256 声明一致', () => {
  const upstream = JSON.parse(readFileSync(path.join(root, 'contract/UPSTREAM.json'), 'utf8'));
  assert.equal(upstream.aggregate, 'eb7f1ac9e117a709d15d87de89cf30e309c479e62dfa3d320cb8f154d3f1dc1e');
  assert.equal(upstream.commit, 'd3bf720a869732e7a2ee04fa39d32dd50868fd61');
  const manifest = readFileSync(path.join(root, 'contract/CONTRACT.sha256'), 'utf8');
  assert.match(manifest, new RegExp(`aggregate: ${upstream.aggregate}`));
});

test('src/ipc.gen.ts 与 schema 同步', () => {
  const result = run('scripts/gen-ipc-types.mjs', ['--check']);
  assert.equal(result.status, 0, result.stdout);
});
