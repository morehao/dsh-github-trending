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

test('显式错误码保留后续诊断行（non-fast-forward 不再被截断）', () => {
  const stderr = [
    'error: GIT_OPERATION_FAILED: To github.com:owner/repo.git',
    ' ! [rejected]        trending/2026-10-31 -> trending/2026-10-31 (non-fast-forward)',
    "error: failed to push some refs to 'github.com:owner/repo.git'",
    'hint: Updates were rejected because the tip of your current branch is behind',
  ].join('\n');
  const classified = errors.classifyStderr(stderr);
  assert.equal(classified.code, 'GIT_OPERATION_FAILED');
  assert.equal(classified.inferred, false);
  assert.match(classified.message, /non-fast-forward/);
  assert.match(classified.message, /failed to push some refs/);
});

test('hintOf 针对 non-fast-forward 给出可执行建议', () => {
  const hint = errors.hintOf('GIT_OPERATION_FAILED', ' ! [rejected] ... (non-fast-forward)');
  assert.match(hint, /force-with-lease|删除该远端分支/);
  // 非 non-fast-forward 的 git 失败仍走默认提示
  assert.doesNotMatch(errors.hintOf('GIT_OPERATION_FAILED', 'some other git failure'), /force-with-lease/);
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

test('stale info 与 non-fast-forward 是两种原因，提示不再串台', () => {
  const stale = ' ! [rejected] trending/x -> trending/x (stale info)';
  const diverged = ' ! [rejected] trending/x -> trending/x (non-fast-forward)';
  assert.equal(errors.reasonOf('GIT_OPERATION_FAILED', stale), 'stale-lease');
  assert.equal(errors.reasonOf('GIT_OPERATION_FAILED', diverged), 'non-fast-forward');
  assert.match(errors.hintOf('GIT_OPERATION_FAILED', stale), /fetch --prune/);
  assert.doesNotMatch(errors.hintOf('GIT_OPERATION_FAILED', stale), /non-fast-forward/);
  // 核心给的结构化 reason 优先于文本推断
  assert.equal(errors.reasonOf('GIT_OPERATION_FAILED', stale, { reason: 'auth' }), 'auth');
  assert.equal(errors.reasonOf('MODEL_TIMEOUT', stale), undefined);
});
