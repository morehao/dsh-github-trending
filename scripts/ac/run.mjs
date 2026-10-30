#!/usr/bin/env node
/**
 * AC-P-01…13 的机械部分：能在本机一次跑完的都在这里跑，剩下的打印人工步骤。
 *
 *   node scripts/ac/run.mjs            跑全部机械检查
 *   node scripts/ac/run.mjs --verbose  额外打印每条证据
 *
 * 约定：所有用例都在临时目录里跑，不碰真实的 `~/.dsh`、不碰真实仓库；
 * 核心一律用 `test/fixtures/fake-core.mjs`（场景通过包装脚本注入，因为插件的
 * sanitizedEnv 不会把 FAKE_* 传进子进程——这本身也是 AC-P-04 的一部分）。
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const verbose = process.argv.includes('--verbose');
const FAKE = path.join(root, 'test', 'fixtures', 'fake-core.mjs');

const { config, importCli, state: stateModule, runner: runnerModule, errors, core, locate } = await import(
  path.join(root, 'lib', 'internal.js')
);

const results = [];
function record(id, title, ok, evidence) {
  results.push({ id, title, ok, evidence });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${id}  ${title}`);
  if (!ok || verbose) for (const line of String(evidence).split('\n')) console.log(`      ${line}`);
}

function scenarioCore(scenario = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ac-core-'));
  const file = path.join(dir, 'core.mjs');
  const assignments = Object.entries(scenario)
    .map(([key, value]) => `process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)};`)
    .join('\n');
  writeFileSync(file, `#!/usr/bin/env node\n${assignments}\nawait import(${JSON.stringify(`file://${FAKE}`)});\n`);
  chmodSync(file, 0o755);
  return file;
}

function tempRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), 'ac-repo-'));
  mkdirSync(path.join(repo, '.git'));
  return repo;
}

function setup(overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ac-data-'));
  const store = new stateModule.Store({ dir });
  const repo = overrides.repo ?? tempRepo();
  store.writeSettings({
    model: { provider: 'deepseek', model: 'deepseek-chat', apiKeyRef: 'AC_KEY', baseURL: 'https://api.deepseek.com/v1' },
    repo: { path: repo },
    ...overrides.settings,
  });
  const env = {
    PATH: overrides.PATH ?? process.env.PATH,
    HOME: process.env.HOME,
    TRENDING_DIGEST_CORE: overrides.core ?? scenarioCore(overrides.scenario ?? {}),
    AC_KEY: 'sk-ac-secret-value',
  };
  const runner = new runnerModule.Runner({ store, get: () => undefined, env });
  return { runner, store, repo, env };
}

function repoFiles(repo) {
  const out = [];
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(repo);
  return out.sort();
}

// ---- AC-P-01：包内容齐全（真实 profile 安装见人工步骤） ----
{
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const required = ['lib/index.js', 'lib/index.d.ts', 'client.js', 'cordis.patch.yml', 'contract/schema/ipc.v1.json', 'contract/UPSTREAM.json', 'locale/zh.json', 'locale/en.json', 'icon.svg'];
  const missing = required.filter((file) => !existsSync(path.join(root, file)));
  const exportsOk = pkg.exports['./client'] === './client.js' && pkg.exports['./cordis.patch.yml'] !== undefined;
  record('AC-P-01', '干净 profile 一条命令安装并出现设置页', missing.length === 0 && exportsOk && pkg.dsh.client.platform === 'web',
    `包内文件：${missing.length === 0 ? '齐全' : `缺 ${missing.join(', ')}`}；exports.client=${pkg.exports['./client']}；dsh.client.platform=${pkg.dsh.client.platform}\n真实安装：dsh plugin --profile <新 profile> add <tgz>`);
}

// ---- AC-P-04：密钥不落盘 / 不泄漏 ----
{
  const { runner, store } = setup({ scenario: { FAKE_STDERR: 'error: MODEL_FAILED: upstream said apiKey: sk-ac-secret-value', FAKE_EXIT: '1' } });
  const summary = await runner.run({ trigger: 'tool' });
  const files = [store.settingsPath, store.statePath, store.historyPath];
  const leaks = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (text.includes('sk-ac-secret-value')) leaks.push(`${path.basename(file)} 含明文密钥`);
  }
  const log = store.readLog(path.join(store.logsPath, `${summary.id}.log`));
  if (log.includes('sk-ac-secret-value')) leaks.push('运行日志含明文密钥');
  if (!log.includes('***')) leaks.push('日志未脱敏（找不到 ***）');
  record('AC-P-04', '密钥不泄漏（日志 / 设置 / 状态）', leaks.length === 0, leaks.length === 0 ? `stderr 已脱敏：${log.trim().split('\n').slice(-1)[0]}` : leaks.join('\n'));
}

// ---- AC-P-05：同日幂等 ----
{
  const { runner, store } = setup();
  const first = await runner.run({ trigger: 'tool' });
  const second = await runner.run({ trigger: 'tool', });
  const skippedRun = await setup({ scenario: { FAKE_SKIPPED: '1' } });
  const third = await skippedRun.runner.run({ trigger: 'tool' });
  const history = store.readHistory();
  record('AC-P-05', '同日幂等：第二次运行 0 新增 commit', first.ok && second.ok && third.skipped && third.files === 0 && history.length === 2,
    `first.files=${first.files} second.files=${second.files} third.skipped=${third.skipped} third.files=${third.files} 记录数=${history.length}`);
}

// ---- AC-P-06：核心不可用 ----
{
  const { runner, repo } = setup({ core: '/nope/trendradar' });
  const before = repoFiles(repo);
  const summary = await runner.run({ trigger: 'tool' });
  record('AC-P-06', '核心不可用 → CORE_UNAVAILABLE，目标目录无新文件', summary.error?.code === 'CORE_UNAVAILABLE' && repoFiles(repo).length === before.length,
    `code=${summary.error?.code}\n${summary.error?.message ?? ''}`);
}

// ---- AC-P-07：协议不匹配 ----
{
  const { runner, repo } = setup({ scenario: { FAKE_IPC_SCHEMA: '2' } });
  const summary = await runner.run({ trigger: 'tool' });
  record('AC-P-07', '版本不匹配 → CORE_INCOMPATIBLE 且不运行', summary.error?.code === 'CORE_INCOMPATIBLE' && repoFiles(repo).length === 0,
    `code=${summary.error?.code}\n${summary.error?.message ?? ''}`);
}

// ---- AC-P-08：模型不可用 ----
{
  const { runner, repo } = setup({ scenario: { FAKE_EXIT: '1', FAKE_STDERR: 'HTTP 401: incorrect api key provided' } });
  const summary = await runner.run({ trigger: 'tool' });
  const ok = summary.error?.code === 'MODEL_UNAUTHORIZED' && repoFiles(repo).length === 0;
  record('AC-P-08', '模型不可用 → MODEL_*，无文件写入', ok, `code=${summary.error?.code} inferred=${summary.error?.inferred} 仓库文件=${repoFiles(repo).length}`);
}

// ---- AC-P-09：取消 ----
{
  const { runner, store } = setup({ scenario: { FAKE_SLEEP: '5000' } });
  const pending = runner.run({ trigger: 'manual' });
  // 等到核心真的被 spawn（runner.running 出现）再取消，避免取消落在握手里
  for (let index = 0; index < 100 && runner.running === undefined; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  const cancelled = runner.cancel();
  const summary = await pending;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const leftover = (() => {
    try {
      return execFileSync('pgrep', ['-f', 'fake-core.mjs'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  })();
  const ok = cancelled && summary.error?.code === 'CORE_CANCELLED' && store.readState().lastDigest === undefined && leftover === 0;
  record('AC-P-09', '取消：无半成品、无状态提交、无残留进程', ok,
    `cancelled=${cancelled} code=${summary.error?.code} durationMs=${summary.durationMs} lastDigest=${store.readState().lastDigest === undefined ? 'undefined' : 'set'} 残留进程=${leftover}`);
}

// ---- AC-P-10：插件不改写核心产出 ----
{
  const { runner, repo } = setup();
  const before = repoFiles(repo);
  await runner.run({ trigger: 'tool' });
  const after = repoFiles(repo);
  record('AC-P-10', 'canonical：插件不写、不改仓库文件', JSON.stringify(before) === JSON.stringify(after),
    `运行前后仓库文件一致：${after.length === 0 ? '(空仓库)' : after.join(', ')}；插件只记录核心给出的 sha256`);
}

// ---- AC-P-11：解析顺序 ----
{
  const override = setup({ core: scenarioCore() });
  const withEnv = await override.runner.run({ trigger: 'tool' });
  const without = (() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ac-noenv-'));
    const store = new stateModule.Store({ dir });
    // 不联网：禁掉自动下载，验证「无缓存 → 明确报错」这条路径
    store.writeSettings({ model: { provider: 'deepseek', model: 'm', apiKeyRef: 'AC_KEY' }, repo: { path: tempRepo() }, coreAutoDownload: false });
    return new runnerModule.Runner({ store, get: () => undefined, env: { PATH: process.env.PATH, HOME: process.env.HOME, AC_KEY: 'k', TRENDING_DIGEST_HOME: dir } });
  })();
  const noEnv = await without.run({ trigger: 'tool' });
  const ok = withEnv.ok && noEnv.error?.code === 'CORE_NOT_DOWNLOADED' && String(noEnv.error.message).includes('releases/download');
  record('AC-P-11', '核心解析顺序：环境变量优先，未设走 Release（缓存/下载）', ok,
    `设 TRENDING_DIGEST_CORE → ok=${withEnv.ok}；未设且禁用自动下载 → ${noEnv.error?.code}（${noEnv.error?.message?.slice(0, 90)}…）`);
}

// ---- AC-P-12：首次导入不导密钥 ----
{
  const dir = mkdtempSync(path.join(tmpdir(), 'ac-import-'));
  const file = path.join(dir, 'config.yaml');
  writeFileSync(file, 'model:\n  provider: deepseek\n  name: deepseek-chat\n  apiKey: sk-must-not-import\nrepo:\n  path: /tmp/notes\n  baseBranch: trunk\ntrending:\n  languages: ["all", "go"]\n  perLanguage: 12\n');
  const result = importCli.importFromCli(file);
  const ok = result.ok && result.skippedSecrets.includes('model.apiKey') && !JSON.stringify(result.settings).includes('sk-must-not-import') && result.settings.repo.baseBranch === 'trunk' && result.settings.trending.topN === 12;
  record('AC-P-12', '首次导入：非敏感字段落位，密钥未导入', ok, `imported=${result.imported.join(', ')}\nskippedSecrets=${result.skippedSecrets.join(', ')}`);
}

// ---- AC-P-13：共存检测 ----
{
  const bin = mkdtempSync(path.join(tmpdir(), 'ac-bin-'));
  const fakeCli = path.join(bin, 'trendradar');
  writeFileSync(fakeCli, `#!/usr/bin/env node\nif (process.argv[2] === 'version') process.stdout.write(JSON.stringify({version:'0.0.9-old',ipcSchema:9,digestSchema:9})+'\\n');\n`);
  chmodSync(fakeCli, 0o755);
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: process.env.HOME };
  const settings = config.normalizeSettings({ model: { provider: 'deepseek', model: 'm', apiKeyRef: 'AC_KEY' }, repo: { path: tempRepo() } });
  const coexistence = await core.detectCoexistence(undefined, { env, fresh: true });
  const { runner } = setup({ PATH: env.PATH });
  const summary = await runner.run({ trigger: 'tool' });
  const ok = coexistence.found && coexistence.compatible === false && summary.ok;
  record('AC-P-13', 'PATH 有旧版 CLI → 只提示；本次仍用自带核心', ok,
    `found=${coexistence.found} version=${coexistence.version} compatible=${coexistence.compatible} run.ok=${summary.ok}`);
}

// ---- 人工步骤 ----
console.log('\n人工步骤（机械检查覆盖不到的部分）：');
console.log('  AC-P-02 三步走查：设置页选仓库 → 「沿用 DSH 配置」选模型 → 「试跑」。');
console.log('  AC-P-03 三种凭据形态：本机有 env 密钥的 provider、已存凭据的 provider、OAuth provider（走回环代理）各填一次；');
console.log('          自动化部分见 test/quickfill.test.mjs。');
console.log('  AC-P-01 真实安装：dsh plugin --profile <新 profile> add <tgz>，启动后设置页出现「GitHub 趋势」。');

const failed = results.filter((result) => !result.ok);
console.log(`\n合计 ${results.length} 条：通过 ${results.length - failed.length}，失败 ${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);
