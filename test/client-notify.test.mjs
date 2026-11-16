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
const settingsSrc = readFileSync(path.join(root, 'client/settings.ts'), 'utf8');
const runsSrc = readFileSync(path.join(root, 'client/runs.ts'), 'utf8');

test('「通知」页签已删除：NAV 无 notify tab、无 NotifyView 分发', () => {
  assert.doesNotMatch(indexSrc, /\{\s*id:\s*'notify'/);
  assert.doesNotMatch(indexSrc, /from '\.\/notify\.js'/);
  assert.doesNotMatch(indexSrc, /view === 'notify'/);
  assert.doesNotMatch(indexSrc, /NotifyView/);
});

test('设置页新增 notify section（SectionId / SECTIONS / 渲染分支）', () => {
  assert.match(settingsSrc, /type SectionId = [^;]*'notify'/);
  assert.match(settingsSrc, /const SECTIONS: SectionId\[\] = \[[^\]]*'notify'/);
  assert.match(settingsSrc, /case 'notify':\s*return \{ notify: settings\.notify \}/);
  assert.match(settingsSrc, /section === 'notify' \? notifyCard/);
  assert.match(settingsSrc, /NotifySettingsSection/);
});

test('notify.ts 导出受控分区组件与共享卡片（无 NotifyView）', () => {
  assert.match(notifySrc, /export function NotifySettingsSection/);
  assert.match(notifySrc, /export function NotifyPushRecord/);
  assert.match(notifySrc, /export function recordStatusOf/);
  assert.match(notifySrc, /export const DEFAULT_NOTIFY/);
  assert.doesNotMatch(notifySrc, /export function NotifyView/);
  // 已下线的跨运行汇总不应再出现
  assert.doesNotMatch(notifySrc, /collectPushes/);
  assert.doesNotMatch(notifySrc, /withinDays/);
});

test('官方渠道 logo 内联 SVG（非汉字 letter）', () => {
  assert.match(notifySrc, /icon:/);
  assert.doesNotMatch(notifySrc, /letter:\s*'[企钉飞]'/);
  // 品牌色对齐官方值
  assert.match(notifySrc, /#07C160/);
  assert.match(notifySrc, /#0089FF/);
  assert.match(notifySrc, /#3370FF/);
});

test('运行记录详情渲染推送结果（仅 attempted=true）', () => {
  assert.match(runsSrc, /import \{ NotifyPushRecord \} from '\.\/notify\.js'/);
  assert.match(runsSrc, /record\.notify\.attempted === true/);
  assert.match(runsSrc, /NotifyDetail/);
});

test('通知相关 zh/en 文案键齐全且占位符一致', async () => {
  const mod = await loadI18n();
  assert.deepEqual(mod.checkI18n(), []);
  const zh = mod.buildTranslate({ getLocale: () => ({ active: 'zh' }) });
  const en = mod.buildTranslate({ getLocale: () => ({ active: 'en' }) });
  // 保留键（配置分区 + 推送卡片继续使用）
  const kept = [
    'notify.master.on',
    'notify.master.channelsOn',
    'notify.channels.title',
    'notify.channel.wecom',
    'notify.content.title',
    'notify.content.strategy',
    'notify.status.sent',
    'notify.record.tokens',
    'notify.save.save',
    'notify.save.saved',
    'st.notify',
    'runs.detail.notify',
    'runs.notify.sent',
    'runs.notify.rate',
  ];
  for (const key of kept) {
    assert.notEqual(zh(key), key, `zh 缺少键 ${key}`);
    assert.notEqual(en(key), key, `en 缺少键 ${key}`);
  }
  // 已删除键不再存在（buildTranslate 对缺失键回退为键名本身）
  const removed = ['nav.notify', 'shell.notify.dek', 'notify.recent.title', 'notify.recent.noNotify', 'notify.stat.total', 'notify.filter.all'];
  for (const key of removed) {
    assert.equal(zh(key), key, `zh 不应再有键 ${key}`);
    assert.equal(en(key), key, `en 不应再有键 ${key}`);
  }
  // 占位符替换
  assert.equal(zh('notify.master.channelsOn', { n: 3 }), '3 个渠道在线');
  assert.equal(en('notify.master.channelsOn', { n: 3 }), '3 channel(s) online');
  assert.equal(zh('notify.record.tokens', { n: 830 }), '830 tokens');
});
