import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 单独 bundle `client/subscriptions.ts` 只为拿到导出的纯函数 `canAnalyzeOne`。
 * 客户端依赖宿主提供的 `react`（仓库里没有该包），用 alias 指向一个空 stub；
 * 测试只调用纯函数、不渲染组件，因此 stub 内部无需实现任何 API。
 */
async function loadSubscriptions() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dshgt-subs-'));
  const reactStub = path.join(dir, 'react-stub.mjs');
  writeFileSync(reactStub, 'export default {};\n');
  const outfile = path.join(dir, 'subscriptions.mjs');
  await build({
    absWorkingDir: root,
    entryPoints: [path.join(root, 'client/subscriptions.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    alias: { react: reactStub },
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}

const item = (status) => ({ fullName: 'a/b', status });

test('canAnalyzeOne：核心有明细时，只有「repos 有、items 无」才不可分析', async () => {
  const { canAnalyzeOne } = await loadSubscriptions();
  // hasItemDetail=false（旧核心整包无 items）：无从判断，一律放行，避免误伤全表。
  assert.equal(canAnalyzeOne(undefined, false), true);
  // hasItemDetail=true：缺 item = 仅写进 .git/pending、尚未落盘 → 点了必败 → 不可点。
  assert.equal(canAnalyzeOne(undefined, true), false);
});

test('canAnalyzeOne：baseline（已落盘、该周无 section）仍可正常单仓分析', async () => {
  const { canAnalyzeOne } = await loadSubscriptions();
  // baseline 是「首次发现、无 section」，不是「不能分析」——旧实现据此置灰是错的。
  assert.equal(canAnalyzeOne(item('baseline'), true), true);
  assert.equal(canAnalyzeOne(item('ok'), true), true);
  assert.equal(canAnalyzeOne(item('no_change'), true), true);
  assert.equal(canAnalyzeOne(item('rate_limited'), true), true);
  assert.equal(canAnalyzeOne(item('failed'), true), true);
});

test('canAnalyzeOne：有 item 但缺 status（契约外畸形）→ 视为未落盘，不可分析', async () => {
  const { canAnalyzeOne } = await loadSubscriptions();
  assert.equal(canAnalyzeOne({ fullName: 'a/b' }, true), false);
});
