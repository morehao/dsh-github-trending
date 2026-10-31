import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadClientModule(name) {
  const outfile = path.join(mkdtempSync(path.join(tmpdir(), 'dshgt-credential-')), `${name}.mjs`);
  await build({
    absWorkingDir: root,
    entryPoints: [path.join(root, 'client', `${name}.ts`)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}

const { credentialView } = await loadClientModule('credential');
const { buildTranslate } = await loadClientModule('i18n');
const zh = buildTranslate(undefined);
const en = buildTranslate({ getLocale: () => ({ active: 'en' }) });

const credential = (patch = {}) => ({ ref: '', configured: false, source: null, writable: false, ...patch });

test('proxy 模式：已复用宿主凭据，不再显示「未配置」', () => {
  const view = credentialView({ mode: 'proxy', credential: credential() }, zh);
  assert.equal(view.ok, true, '回环代理不需要本机密钥，就绪数应算通过');
  assert.equal(view.kind, 'ok');
  assert.equal(view.label, '沿用 DSH 凭据');
  assert.match(view.hint, /回环代理/);
});

test('proxy 模式：残留的旧 apiKeyRef 不冒充「已配置」来源', () => {
  const view = credentialView(
    { mode: 'proxy', credential: credential({ ref: 'OPENAI_API_KEY', configured: true, source: 'env' }) },
    zh,
  );
  assert.equal(view.label, '沿用 DSH 凭据');
  assert.ok(!view.label.includes('env'), '代理模式下该引用并不生效，不该展示为来源');
});

test('direct 模式：解析到密钥显示「已配置 · 来源」', () => {
  const view = credentialView(
    { mode: 'direct', credential: credential({ ref: 'OPENAI_API_KEY', configured: true, source: 'env' }) },
    zh,
  );
  assert.equal(view.ok, true);
  assert.equal(view.label, '已配置 · env');
});

test('direct 模式：解析不到密钥时如实报「未配置」，并给出补配置的入口', () => {
  const empty = credentialView({ mode: 'direct', credential: credential() }, zh);
  assert.equal(empty.ok, false);
  assert.equal(empty.kind, 'err');
  assert.equal(empty.label, '未配置');
  assert.match(empty.hint, /沿用 DSH 配置/);

  const dangling = credentialView(
    { mode: 'direct', credential: credential({ ref: 'MISSING_KEY', configured: false }) },
    zh,
  );
  assert.equal(dangling.label, '未配置 · MISSING_KEY', '引用名要露出来，方便判断是不是写错了');
});

test('英文文案同样区分「宿主凭据」与「缺配置」', () => {
  assert.equal(credentialView({ mode: 'proxy', credential: credential() }, en).label, 'uses DSH credential');
  assert.equal(credentialView({ mode: 'direct', credential: credential() }, en).label, 'missing');
  assert.equal(
    credentialView({ mode: 'direct', credential: credential({ configured: true, source: 'env' }) }, en).label,
    'configured · env',
  );
});
