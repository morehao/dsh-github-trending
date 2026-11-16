import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function load() {
  const outfile = path.join(mkdtempSync(path.join(tmpdir(), 'dshgt-notify-webhook-')), 'notify-webhook.mjs');
  await build({ absWorkingDir: root, entryPoints: [path.join(root, 'client/notify-webhook.ts')], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}

const mod = await load();

const channel = (patch = {}) => ({ enabled: true, webhookURL: '', ...patch });

test('默认占位 `${LARK_WEBHOOK}` 不算已配置（问题②）', () => {
  assert.equal(mod.isChannelConfigured(channel({ webhookURL: '${LARK_WEBHOOK}' })), false);
  assert.equal(mod.hasRealWebhook(channel({ webhookURL: '${LARK_WEBHOOK}' })), false);
});

test('占位符前后空白也不误判', () => {
  assert.equal(mod.isChannelConfigured(channel({ webhookURL: '  ${DINGTALK_SIGN}  ' })), false);
});

test('真实 URL 视为已配置', () => {
  assert.equal(mod.isChannelConfigured(channel({ webhookURL: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc' })), true);
});

test('空串未配置', () => {
  assert.equal(mod.isChannelConfigured(channel({ webhookURL: '   ' })), false);
});

test('有地址但未启用 → 未配置（展示语义：需启用才算生效）', () => {
  assert.equal(mod.isChannelConfigured(channel({ enabled: false, webhookURL: 'https://example.com/hook' })), false);
});

test('用户填的 ${VAR} 引用里带额外字符不算纯占位（视为用户主动配置）', () => {
  // 很边缘：只有「整串就是一个 ${VAR}」才当作占位；其余引用视为用户已处理。
  assert.equal(mod.hasRealWebhook(channel({ webhookURL: 'https://x/${VAR}' })), true);
});
