#!/usr/bin/env node
// 命名与接线一致性校验：把「装上之后才发现」的错位前移到 PR。
//
//   1. package.json 的 name  == cordis.patch.yml 的 insert[0].name（宿主 import() 的模块标识符）
//   2. lib/index.ts 的 export const name == insert[0].id（cordis 配置树内的键）
//   3. dsh.core.{repo,version} 与 contract/UPSTREAM.json 同源（publishing.md 的硬约束：不要手改一处）
//   4. exports / files / dsh 段的接线与 main/types 对得上（缺 ./client 或 files 漏 lib 会「能装、白屏」）
//
// 依赖 `lib/`：`npm run check` 里排在 build 之后（与兄弟仓的 check 顺序一致）。
import { readFile } from 'node:fs/promises';

const read = async (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};

const pkg = JSON.parse(await read('package.json'));
const patch = await read('cordis.patch.yml');
const upstream = JSON.parse(await read('contract/UPSTREAM.json'));
const { name: pluginName } = await import('../lib/index.js');

// 极简读取：本仓 patch 只有一条 insert，取第一个 id / name 即可，不引入 YAML 依赖。
const insertId = patch.match(/^\s*-\s+id:\s*(\S+)\s*$/m)?.[1];
const insertName = patch.match(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/m)?.[1];

if (!insertId) fail('cordis.patch.yml 未找到 insert[0].id');
if (!insertName) fail('cordis.patch.yml 未找到 insert[0].name');

if (insertName && insertName !== pkg.name) {
  fail(`包名不一致：package.json name=${pkg.name}，cordis.patch.yml insert[0].name=${insertName}`);
}
if (insertId && insertId !== pluginName) {
  fail(`插件名不一致：lib/index.ts（产物 lib/index.js）export const name=${pluginName}，insert[0].id=${insertId}`);
}

// dsh.core 是「首次运行下载哪个核心 Release」的唯一来源；它必须与契约快照同源（sync-contract 写入）。
const core = pkg.dsh?.core;
if (!core) {
  fail('package.json 缺少 dsh.core（repo / version）');
} else {
  const ref = String(upstream.ref ?? '');
  const version = String(core.version ?? '');
  if (version !== ref && `v${version}` !== ref) {
    fail(`dsh.core.version=${version} 与 contract/UPSTREAM.json ref=${ref} 不同源（用 sync-contract --ref 同步）`);
  }
  const repo = String(core.repo ?? '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  const upstreamRepo = String(upstream.repo ?? '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '');
  if (repo !== upstreamRepo) {
    fail(`dsh.core.repo=${core.repo} 与 contract/UPSTREAM.json repo=${upstream.repo} 不一致`);
  }
}

// exports / files / main / types：npm 页面看到的东西和运行时 import 的东西要指向同一份产物。
const exportsMap = pkg.exports ?? {};
const entry = exportsMap['.'];
const entryDefault = typeof entry === 'string' ? entry : entry?.default;
const entryTypes = typeof entry === 'object' ? entry?.types : pkg.types;

if (entryDefault !== `./${pkg.main}`) {
  fail(`exports["."].default=${entryDefault} 与 main=${pkg.main} 不一致`);
}
if (!entryTypes) fail('缺少 types（exports["."].types 或 package.json types）');
if (pkg.main !== 'lib/index.js') fail(`main 应为 lib/index.js（tsup outDir），实际 ${pkg.main}`);
if (exportsMap['./client'] !== './client.js') {
  fail('exports["./client"] 必须指向 ./client.js（宿主按这个子路径加载前端 bundle）');
}
for (const key of ['./locale/*.json', './icon', './package.json']) {
  if (!(key in exportsMap)) fail(`exports 缺少 ${key}`);
}
if (pkg.publishConfig?.access !== 'public') {
  fail('package.json 缺少 publishConfig.access = "public"');
}

const files = new Set(pkg.files ?? []);
for (const required of ['lib', 'client.js', 'contract', 'locale', 'cordis.patch.yml', 'icon.svg']) {
  if (!files.has(required)) fail(`files 缺少 ${required}（发布产物会缺文件）`);
}

if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') {
  fail('dsh.bundle.patch 必须指向 ./cordis.patch.yml');
}
if (pkg.dsh?.client?.platform !== 'web') {
  fail('dsh.client.platform 必须为 web');
}

console.log(
  process.exitCode
    ? '命名/接线校验失败'
    : `命名/接线校验通过：包名 ${pkg.name} / 插件名 ${pluginName} / 核心 v${core.version} / exports ${Object.keys(exportsMap).length} 项`,
);
