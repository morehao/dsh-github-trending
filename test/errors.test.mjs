import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errors } from '../lib/internal.js';

test('显式错误码优先，且标记 inferred=false', () => {
  const classified = errors.classifyStderr('context line\nerror: REPO_DIRTY: working tree has tracked changes');
  assert.equal(classified.code, 'REPO_DIRTY');
  assert.equal(classified.inferred, false);
  assert.match(classified.message, /tracked changes/);
});

test('没有码时按文本归类，标记 inferred=true', () => {
  const auth = errors.classifyStderr('HTTP 401: incorrect api key provided');
  assert.equal(auth.code, 'MODEL_UNAUTHORIZED');
  assert.equal(auth.inferred, true);
  const git = errors.classifyStderr('error: exit status 1: exec: "git": executable file not found in $PATH');
  assert.equal(git.code, 'GIT_NOT_INSTALLED');
});

test('未知错误落到 INTERNAL', () => {
  assert.equal(errors.classifyStderr('something odd happened').code, 'INTERNAL');
});

test('redact 抹掉已知密钥与常见形态', () => {
  const secret = 'sk-abcdefghijklmnop';
  const token = 'ghp_1234567890abcdefghij';
  const text = `Authorization: Bearer ${token} apiKey: "${secret}" also sk-zzzzzzzzzzzz`;
  const out = errors.redact(text, [secret, token]);
  assert.equal(out.includes(secret), false);
  assert.equal(out.includes(token), false);
  assert.equal(out.includes('sk-zzzzzzzzzzzz'), false);
});

test('错误码到界面落点的映射稳定', () => {
  assert.equal(errors.areaOf('MODEL_UNAUTHORIZED'), 'model');
  assert.equal(errors.areaOf('CORE_UNAVAILABLE'), 'core');
  assert.equal(errors.areaOf('REPO_NOT_GIT'), 'repo');
  assert.equal(errors.areaOf('GITHUB_AUTH'), 'auth');
  assert.equal(errors.areaOf('PR_FAILED'), 'run');
  assert.equal(errors.isRetriable('FETCH_RATE_LIMITED'), true);
  assert.equal(errors.isRetriable('MODEL_UNAUTHORIZED'), false);
});
