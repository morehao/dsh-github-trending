import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, importCli } from '../lib/internal.js';

test('默认值合理且未知字段被丢弃', () => {
  const settings = config.normalizeSettings({ model: { provider: 'deepseek', nope: 1 }, extra: true });
  assert.equal(settings.model.provider, 'deepseek');
  assert.equal(settings.model.mode, 'direct');
  assert.equal(settings.repo.baseBranch, 'main');
  assert.equal(settings.schedule.time, '08:30:00');
  assert.equal(settings.schedule.timezone, 'Asia/Shanghai');
  assert.equal('extra' in settings, false);
  assert.equal('nope' in settings.model, false);
});

test('校验拦下缺模型、缺仓库、坏时区与不支持的 provider', () => {
  const problems = config.validateSettings(config.normalizeSettings({}), ['deepseek', 'openai-compatible']);
  const fields = problems.map((problem) => problem.field);
  assert.ok(fields.includes('model.model'));
  assert.ok(fields.includes('repo.path'));

  const badProvider = config.validateSettings(
    config.normalizeSettings({ model: { provider: 'anthropic', model: 'x', baseURL: 'https://a.b/v1' }, repo: { path: '/tmp/x' } }),
    ['deepseek'],
  );
  assert.equal(badProvider[0].code, 'MODEL_PROVIDER_UNSUPPORTED');

  const badTz = config.validateSettings(
    config.normalizeSettings({ model: { provider: 'deepseek', model: 'x' }, repo: { path: '/tmp/x' }, schedule: { timezone: 'Mars/Base' } }),
    ['deepseek'],
  );
  assert.ok(badTz.some((problem) => problem.field === 'schedule.timezone'));
});

test('provider 默认端点与代理模式的 baseURL 处理', () => {
  const settings = config.normalizeSettings({ model: { provider: 'deepseek', model: 'deepseek-chat' }, repo: { path: '/tmp/x' } });
  assert.equal(config.effectiveBaseURL(settings.model), 'https://api.deepseek.com/v1');
  const proxy = config.normalizeSettings({ model: { provider: 'openai-compatible', mode: 'proxy', model: 'm', baseURL: 'https://ignored' }, repo: { path: '/tmp/x' } });
  const coreConfig = config.toCoreConfig(proxy, 'KEY', 'http://127.0.0.1:1234/v1');
  assert.equal(coreConfig.model.baseURL, 'http://127.0.0.1:1234/v1');
  assert.equal(coreConfig.model.apiKey, 'KEY');
  assert.equal(coreConfig.pr.enabled, true);
});

test('toYaml 生成的配置能被自己的 YAML 子集解析器读回', () => {
  const settings = config.normalizeSettings({ model: { provider: 'deepseek', model: 'deepseek-chat' }, repo: { path: '/tmp/x' }, trending: { languages: ['all', 'go'] } });
  const yaml = config.toYaml(config.toCoreConfig(settings, 'sk-test'));
  const parsed = importCli.parseSimpleYaml(yaml);
  assert.equal(parsed.model.name, 'deepseek-chat');
  assert.equal(parsed.model.apiKey, 'sk-test');
  assert.deepEqual(parsed.trending.languages, ['all', 'go']);
  assert.equal(parsed.repo.path, '/tmp/x');
  assert.equal(parsed.output.retentionDays, 90);
});

test('direct 提交模式不会写 PR 开关', () => {
  const settings = config.normalizeSettings({ model: { provider: 'deepseek', model: 'm' }, repo: { path: '/tmp/x', commitMode: 'direct' } });
  assert.equal(config.toCoreConfig(settings, 'k').pr.enabled, false);
});
