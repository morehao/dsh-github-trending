import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { importCli } from '../lib/internal.js';

const SAMPLE = `# trendradar CLI config
model:
  provider: deepseek
  name: deepseek-chat
  baseURL: https://api.deepseek.com/v1
  apiKey: sk-should-never-be-imported
  temperature: 0.3
  maxTokens: 4096
  allowDegraded: false
repo:
  path: /Users/me/notes
  remote: origin
  baseBranch: trunk
pr:
  enabled: true
  titleTemplate: "chore(trending): {date}"
  autoMerge: false
  labels: ["digest", "auto"]
trending:
  languages: ["all", "go"]
  since: weekly
  perLanguage: 15
output:
  dir: digests
schedule:
  cron: "0 8 * * *"
`;

test('导入非敏感字段，密钥与 cron 不落位', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dshgt-import-'));
  const file = path.join(dir, 'config.yaml');
  writeFileSync(file, SAMPLE);
  const result = importCli.importFromCli(file);
  assert.equal(result.ok, true);
  const settings = result.settings;
  assert.equal(settings.model.provider, 'deepseek');
  assert.equal(settings.model.model, 'deepseek-chat');
  assert.equal(settings.model.temperature, 0.3);
  assert.equal(settings.model.maxTokens, 4096);
  assert.equal(settings.model.allowDegraded, false);
  assert.equal(settings.repo.path, '/Users/me/notes');
  assert.equal(settings.repo.baseBranch, 'trunk');
  assert.deepEqual(settings.pr.labels, ['digest', 'auto']);
  assert.equal(settings.pr.autoMerge, false);
  assert.deepEqual(settings.trending.languages, ['all', 'go']);
  assert.equal(settings.trending.since, 'weekly');
  assert.equal(settings.trending.topN, 15);
  assert.equal(settings.output.dir, 'digests');

  assert.ok(result.skippedSecrets.includes('model.apiKey'), '应当报告跳过了 apiKey');
  assert.equal(JSON.stringify(settings).includes('sk-should-never-be-imported'), false);
  assert.ok(result.problems.some((problem) => problem.includes('schedule.cron')));
});

test('坏 YAML 报解析失败而不是半导入', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dshgt-import-bad-'));
  const file = path.join(dir, 'config.yaml');
  writeFileSync(file, 'model:\n  - this is a list\n');
  const result = importCli.importFromCli(file);
  assert.equal(result.ok, false);
  assert.ok(result.problems.length > 0);
});

test('找不到配置时返回明确的候选路径', () => {
  const result = importCli.importFirstAvailable({ XDG_CONFIG_HOME: '/nonexistent-dir' });
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /没有找到本机 CLI 配置/);
});
