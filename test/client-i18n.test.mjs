import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadI18n() {
  const outfile = path.join(mkdtempSync(path.join(tmpdir(), 'dshgt-i18n-')), 'i18n.mjs');
  await build({ absWorkingDir: root, entryPoints: [path.join(root, 'client/i18n.ts')], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}

test('zh / en 键集合与占位符完全一致', async () => {
  const mod = await loadI18n();
  assert.deepEqual(mod.checkI18n(), []);
});

test('语言切换与占位符替换', async () => {
  const mod = await loadI18n();
  const zh = mod.buildTranslate({ getLocale: () => ({ active: 'zh' }) });
  const en = mod.buildTranslate({ getLocale: () => ({ active: 'en' }) });
  assert.equal(zh('settings.save'), '保存设置');
  assert.equal(en('settings.save'), 'Save');
  assert.equal(zh('settings.import.done', { fields: 'repo.path' }), '已导入：repo.path');
  assert.equal(en('settings.import.done', { fields: 'repo.path' }), 'Imported: repo.path');
  const fallback = mod.buildTranslate(undefined);
  assert.equal(fallback('settings.save'), '保存设置');
});
