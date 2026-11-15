import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadI18n() {
  const outfile = path.join(mkdtempSync(path.join(tmpdir(), 'dshgt-i18n-notify-')), 'i18n.mjs');
  await build({ absWorkingDir: root, entryPoints: [path.join(root, 'client/i18n.ts')], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}

const indexSrc = readFileSync(path.join(root, 'client/index.ts'), 'utf8');
const notifySrc = readFileSync(path.join(root, 'client/notify.ts'), 'utf8');

test('NAV 含 notify tab（label nav.notify / icon bell），并接 renderView 分发', () => {
  assert.match(indexSrc, /\{\s*id:\s*'notify',\s*label:\s*'nav\.notify',\s*icon:\s*'bell'\s*\}/);
  assert.match(indexSrc, /import \{ NotifyView \} from '\.\/notify\.js'/);
  assert.match(indexSrc, /view === 'notify'/);
  assert.match(indexSrc, /h\(NotifyView/);
});

test("navIcon 支持 'bell'", () => {
  assert.match(indexSrc, /name === 'bell'/);
});

test('notify 视图存在并读取 RunResult.notify（逐渠道 status / messages）', () => {
  assert.match(notifySrc, /export function NotifyView/);
  assert.match(notifySrc, /\.notify/);
  assert.match(notifySrc, /channels/);
  assert.match(notifySrc, /summarySource/);
  assert.match(notifySrc, /bodyChars/);
});

test('通知页 zh/en 文案键齐全且占位符一致', async () => {
  const mod = await loadI18n();
  assert.deepEqual(mod.checkI18n(), []);
  const zh = mod.buildTranslate({ getLocale: () => ({ active: 'zh' }) });
  const en = mod.buildTranslate({ getLocale: () => ({ active: 'en' }) });
  const keys = [
    'nav.notify',
    'shell.notify.dek',
    'notify.master.on',
    'notify.master.channelsOn',
    'notify.channels.title',
    'notify.channel.wecom',
    'notify.content.title',
    'notify.content.strategy',
    'notify.recent.title',
    'notify.recent.noNotify',
    'notify.stat.total',
    'notify.filter.all',
    'notify.status.sent',
    'notify.record.tokens',
    'notify.save.save',
    'notify.save.saved',
  ];
  for (const key of keys) {
    assert.notEqual(zh(key), key, `zh 缺少键 ${key}`);
    assert.notEqual(en(key), key, `en 缺少键 ${key}`);
  }
  // 占位符替换
  assert.equal(zh('notify.master.channelsOn', { n: 3 }), '3 个渠道在线');
  assert.equal(en('notify.master.channelsOn', { n: 3 }), '3 channel(s) online');
  assert.equal(zh('notify.record.tokens', { n: 830 }), '830 tokens');
});
