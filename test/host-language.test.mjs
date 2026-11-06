import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hostLanguage } from '../lib/internal.js';

const { normalizeLang, resolveOutputLanguage, SUPPORTED_OUTPUT_LANGUAGES, FALLBACK_LANGUAGE } = hostLanguage;

test('normalizeLang 取主标签小写，非法/空返回空串', () => {
  assert.equal(normalizeLang('en-US'), 'en');
  assert.equal(normalizeLang('zh_CN'), 'zh');
  assert.equal(normalizeLang('EN'), 'en');
  assert.equal(normalizeLang('zh'), 'zh');
  assert.equal(normalizeLang(''), '');
  assert.equal(normalizeLang(undefined), '');
  assert.equal(normalizeLang(null), '');
  assert.equal(normalizeLang(42), '');
  assert.equal(normalizeLang('!!'), '');
});

test('支持集首期为 zh/en，兜底为 zh', () => {
  assert.deepEqual([...SUPPORTED_OUTPUT_LANGUAGES], ['zh', 'en']);
  assert.equal(FALLBACK_LANGUAGE, 'zh');
});

test('显式 ∈ 支持集时最高优先（覆盖宿主）', () => {
  assert.deepEqual(resolveOutputLanguage('en', 'zh-CN'), { language: 'en', source: 'explicit', hostLanguage: 'zh' });
  assert.deepEqual(resolveOutputLanguage('zh', 'en-US'), { language: 'zh', source: 'explicit', hostLanguage: 'en' });
  // 大小写/区域显式值都能归一
  assert.equal(resolveOutputLanguage('EN-us', undefined).language, 'en');
});

test('显式为空 / 非支持集时跟随宿主偏好', () => {
  assert.deepEqual(resolveOutputLanguage('', 'en-US'), { language: 'en', source: 'host', hostLanguage: 'en' });
  assert.deepEqual(resolveOutputLanguage('', 'zh-CN'), { language: 'zh', source: 'host', hostLanguage: 'zh' });
  // 显式是支持集外的值（校验本应拦下，这里仍不应污染），按跟随宿主处理
  assert.equal(resolveOutputLanguage('fr', 'en-US').language, 'en');
  assert.equal(resolveOutputLanguage('fr', 'en-US').source, 'host');
});

test('中英之外一律回落 zh（关键约束）', () => {
  // 宿主是法语/德语/日语 → 回落 zh
  assert.deepEqual(resolveOutputLanguage('', 'fr'), { language: 'zh', source: 'fallback', hostLanguage: 'fr' });
  assert.deepEqual(resolveOutputLanguage('', 'de-DE'), { language: 'zh', source: 'fallback', hostLanguage: 'de' });
  assert.deepEqual(resolveOutputLanguage('', 'ja-JP'), { language: 'zh', source: 'fallback', hostLanguage: 'ja' });
  // 显式非支持集 + 宿主非支持集 → 回落 zh
  assert.deepEqual(resolveOutputLanguage('', 'ko'), { language: 'zh', source: 'fallback', hostLanguage: 'ko' });
});

test('缺失/未知名（undefined / 空串 / 垃圾）→ 回落 zh', () => {
  assert.deepEqual(resolveOutputLanguage(undefined, undefined), { language: 'zh', source: 'fallback', hostLanguage: '' });
  assert.deepEqual(resolveOutputLanguage('', ''), { language: 'zh', source: 'fallback', hostLanguage: '' });
  assert.deepEqual(resolveOutputLanguage('', '###'), { language: 'zh', source: 'fallback', hostLanguage: '' });
});

test('zh-CN → zh、en-US → en（宿主区域标签归一）', () => {
  assert.equal(resolveOutputLanguage('', 'zh-CN').language, 'zh');
  assert.equal(resolveOutputLanguage('', 'zh-CN').source, 'host');
  assert.equal(resolveOutputLanguage('', 'en-US').language, 'en');
  assert.equal(resolveOutputLanguage('', 'en-US').source, 'host');
});
