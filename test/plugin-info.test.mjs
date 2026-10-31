import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluginInfo } from '../lib/internal.js';

test('normalizeRepositoryUrl：git+ / ssh / .git / 尾斜杠都归一成 https://github.com/o/r', () => {
  assert.equal(
    pluginInfo.normalizeRepositoryUrl('git+https://github.com/morehao/dsh-github-trending.git'),
    'https://github.com/morehao/dsh-github-trending',
  );
  assert.equal(
    pluginInfo.normalizeRepositoryUrl('git@github.com:morehao/dsh-github-trending.git'),
    'https://github.com/morehao/dsh-github-trending',
  );
  assert.equal(
    pluginInfo.normalizeRepositoryUrl('https://github.com/morehao/dsh-github-trending/'),
    'https://github.com/morehao/dsh-github-trending',
  );
});

test('normalizeRepositoryUrl：非 GitHub / 非法协议 / 空值返回 undefined', () => {
  assert.equal(pluginInfo.normalizeRepositoryUrl('https://gitlab.com/o/r.git'), undefined);
  assert.equal(pluginInfo.normalizeRepositoryUrl('ftp://github.com/o/r'), undefined);
  assert.equal(pluginInfo.normalizeRepositoryUrl('git@gitlab.com:o/r.git'), undefined);
  assert.equal(pluginInfo.normalizeRepositoryUrl(''), undefined);
  assert.equal(pluginInfo.normalizeRepositoryUrl(undefined), undefined);
});

test('readPluginInfo 读到包名、版本与规范化仓库地址', () => {
  const info = pluginInfo.readPluginInfo();
  assert.equal(info.name, '@morehao/dsh-github-trending');
  assert.match(info.version, /^\d+\.\d+\.\d+/);
  assert.equal(info.repository, 'https://github.com/morehao/dsh-github-trending');
});
