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

test('代理模式允许空 baseURL，direct 仍需显式端点', () => {
  const providers = ['deepseek', 'openai-compatible'];
  const proxy = config.normalizeSettings({ model: { provider: 'openai-compatible', mode: 'proxy', model: 'm' }, repo: { path: '/tmp/x' } });
  assert.equal(config.effectiveBaseURL(proxy.model), '');
  assert.equal(config.validateSettings(proxy, providers).some((problem) => problem.field === 'model.baseURL'), false);

  const direct = config.normalizeSettings({ model: { provider: 'openai-compatible', mode: 'direct', model: 'm' }, repo: { path: '/tmp/x' } });
  assert.ok(config.validateSettings(direct, providers).some((problem) => problem.field === 'model.baseURL'));
});

test('分段合并只覆盖目标分区，字段归位正确', () => {
  const stored = config.normalizeSettings({ model: { provider: 'deepseek', model: 'deepseek-chat' }, repo: { path: '/tmp/a' }, trending: { topN: 10 } });
  const incoming = config.normalizeSettings({ model: { provider: 'openai-compatible', mode: 'proxy', model: '' }, repo: { path: '/tmp/b' }, trending: { topN: 30 } });

  const repoMerged = config.mergeSettingsSection(stored, incoming, 'repo');
  assert.equal(repoMerged.repo.path, '/tmp/b');
  assert.equal(repoMerged.model.provider, 'deepseek'); // 其它分区保持已保存值
  assert.equal(repoMerged.trending.topN, 10);

  const modelMerged = config.mergeSettingsSection(stored, incoming, 'model');
  assert.equal(modelMerged.model.provider, 'openai-compatible');
  assert.equal(modelMerged.repo.path, '/tmp/a');
  assert.equal(modelMerged.trending.topN, 10);

  assert.equal(config.sectionOfField('model.baseURL'), 'model');
  assert.equal(config.sectionOfField('output.dir'), 'repo');
  assert.equal(config.sectionOfField('github.tokenRef'), 'auth');
  assert.equal(config.sectionOfField('trending.topN'), 'scope');
  assert.equal(config.sectionOfField('schedule.timezone'), 'schedule');
  assert.equal(config.sectionOfField('schedule.periods'), 'schedule');
});

test('周期枚举：since 支持 monthly，非法值回落 daily', () => {
  assert.equal(config.normalizeSettings({ trending: { since: 'monthly' } }).trending.since, 'monthly');
  assert.equal(config.normalizeSettings({ trending: { since: 'weekly' } }).trending.since, 'weekly');
  assert.equal(config.normalizeSettings({ trending: { since: 'hourly' } }).trending.since, 'daily');
});

test('schedule.periods：默认 daily、去重按规范序、空数组保留', () => {
  assert.deepEqual(config.normalizeSettings({}).schedule.periods, ['daily']);
  assert.deepEqual(
    config.normalizeSettings({ schedule: { periods: ['monthly', 'daily', 'daily', 'bogus'] } }).schedule.periods,
    ['daily', 'monthly'],
  );
  assert.deepEqual(config.normalizeSettings({ schedule: { periods: [] } }).schedule.periods, []);
});

test('校验：调度开启却没选周期要拦，关闭则允许为空', () => {
  const enabled = config.normalizeSettings({
    model: { provider: 'deepseek', model: 'x' },
    repo: { path: '/tmp/x' },
    schedule: { enabled: true, periods: [] },
  });
  assert.ok(config.validateSettings(enabled, ['deepseek']).some((problem) => problem.field === 'schedule.periods'));

  const disabled = config.normalizeSettings({
    model: { provider: 'deepseek', model: 'x' },
    repo: { path: '/tmp/x' },
    schedule: { enabled: false, periods: [] },
  });
  assert.equal(config.validateSettings(disabled, ['deepseek']).some((problem) => problem.field === 'schedule.periods'), false);
});

test('toCoreConfig 用本次运行的 period 覆盖 trending.since', () => {
  const settings = config.normalizeSettings({ trending: { since: 'daily' } });
  assert.equal(config.toCoreConfig(settings, 'k').trending.since, 'daily');
  assert.equal(config.toCoreConfig(settings, 'k', undefined, 'weekly').trending.since, 'weekly');
  assert.equal(config.toCoreConfig(settings, 'k', undefined, 'monthly').trending.since, 'monthly');
});
