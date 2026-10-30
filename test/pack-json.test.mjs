import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractJsonValues, parsePackOutput } from '../scripts/lib/pack-json.mjs';

const packJson = (paths) =>
  JSON.stringify([{ id: 'pkg@1.0.0', files: paths.map((p) => ({ path: p, size: 1, mode: 420 })) }]);

test('npm 12：顶层是按包名索引的对象', () => {
  const stdout = JSON.stringify({
    'pkg@1.0.0': { id: 'pkg@1.0.0', files: [{ path: 'package.json' }, { path: 'lib/index.js' }], entryCount: 2 },
  });
  assert.deepEqual(parsePackOutput(stdout), ['package.json', 'lib/index.js']);
});

test('干净输出：直接取出文件清单', () => {
  assert.deepEqual(parsePackOutput(packJson(['package.json', 'lib/index.js'])), [
    'package.json',
    'lib/index.js',
  ]);
});

test('前缀日志混进 stdout 也能取到', () => {
  const stdout = `> pkg@1.0.0 prepack\n> npm run build\n\n构建完成\n${packJson(['a.js'])}\n`;
  assert.deepEqual(parsePackOutput(stdout), ['a.js']);
});

test('两段 JSON 以逗号相连（CI 实测形态）取第一段', () => {
  const stdout = `${packJson(['a.js'])},\n${packJson(['b.js'])}\n`;
  assert.deepEqual(parsePackOutput(stdout), ['a.js']);
});

test('文件名里的括号 / 引号不会破坏平衡扫描', () => {
  const stdout = packJson(['a]b.js', 'c"d.js', 'e[0].js']);
  assert.deepEqual(parsePackOutput(stdout), ['a]b.js', 'c"d.js', 'e[0].js']);
});

test('完全解析不了时抛出带诊断信息的错误', () => {
  assert.throws(() => parsePackOutput('no json here'), /npm pack 未输出可解析的 JSON 清单/);
  assert.throws(() => parsePackOutput('[{"files": [}'), /npm pack 未输出可解析的 JSON 清单/);
});

test('extractJsonValues 只切顶层值', () => {
  const values = extractJsonValues('x [1,[2]] y {"a":[3]} z');
  assert.deepEqual(values, ['[1,[2]]', '{"a":[3]}']);
});
