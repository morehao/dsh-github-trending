/**
 * 工具定义 schema 回归：两个工具必须能被宿主 `defineTool` 的 DSL 接受。
 *
 * 历史 regression：`output.schema` 根上的 `required: ['ok','markdown']` 会让
 * `defineTool` 抛 `schema.required is not supported by the value schema DSL`，
 * 而注册失败被 `try/catch` 吞掉，两个工具静默消失。这里用与宿主同规则的
 * 离线校验器把这条守住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertToolDefinition } from './fixtures/tool-schema-dsl.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadTools() {
  const outfile = path.join(mkdtempSync(path.join(tmpdir(), 'dshgt-tools-')), 'tools.mjs');
  await build({
    absWorkingDir: root,
    entryPoints: [path.join(root, 'src/tools.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}

test('trending_run：output schema 符合宿主 DSL，ok / markdown 内联必填', async () => {
  const mod = await loadTools();
  const tool = mod.createTrendingRunTool({});
  assert.doesNotThrow(() => assertToolDefinition(tool));
  assert.equal(tool.output.schema.properties.ok.required, true);
  assert.equal(tool.output.schema.properties.markdown.required, true);
  assert.equal('required' in tool.output.schema, false, '根节点不允许 required 数组');
});

test('trending_history：output schema 符合宿主 DSL，markdown 内联必填', async () => {
  const mod = await loadTools();
  const tool = mod.createTrendingHistoryTool({}, { describe: () => ({}) });
  assert.doesNotThrow(() => assertToolDefinition(tool));
  assert.equal(tool.output.schema.properties.markdown.required, true);
  assert.equal('required' in tool.output.schema, false, '根节点不允许 required 数组');
});
