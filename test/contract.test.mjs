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
  assert.equal(upstream.aggregate, '4717074d26d1a6d85c1885bd052d411f81c20b39467cb81c398f565bbe34dcde');
  assert.equal(upstream.commit, '5cf0ad26c5748cf2bc9a1cc4ce66a09411d590f7');
  const manifest = readFileSync(path.join(root, 'contract/CONTRACT.sha256'), 'utf8');
  assert.match(manifest, new RegExp(`aggregate: ${upstream.aggregate}`));
});

test('src/ipc.gen.ts 与 schema 同步', () => {
  const result = run('scripts/gen-ipc-types.mjs', ['--check']);
  assert.equal(result.status, 0, result.stdout);
});
