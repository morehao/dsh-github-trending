import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 在 Node 里加载 `client.js`：只验证「bundle 能执行、apply 能挂载」，
 * 不渲染 React 组件。宿主给的是 `window.__ModuleLoader__.load({id, factory})`，
 * `factory(require)` 里的 require 只允许解析 `react`。
 */
function loadBundle() {
  const source = readFileSync(path.join(root, 'client.js'), 'utf8');
  let loaded = null;
  const window = {
    __ModuleLoader__: {
      load(entry) {
        loaded = entry;
      },
    },
  };
  const reactStub = {
    createElement: (...args) => ({ type: 'element', args }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => undefined],
    useEffect: () => undefined,
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
  };
  const requireStub = (id) => {
    if (id === 'react') return reactStub;
    throw new Error(`unexpected require: ${id}`);
  };
  const run = new Function('window', 'globalThis', source);
  run(window, { window, document: undefined, navigator: undefined });
  assert.ok(loaded !== null, 'bundle 没有调用 __ModuleLoader__.load');
  return loaded.factory(requireStub);
}

test('client bundle 可加载，id 与包名一致', () => {
  const source = readFileSync(path.join(root, 'client.js'), 'utf8');
  assert.match(source, /id:\s*"@morehao\/dsh-github-trending"/);
  assert.match(source, /window\.__ModuleLoader__\.load/);
});

test('apply 注册设置分区、主面板、侧栏入口与清理 effect', () => {
  const mod = loadBundle();
  const registered = [];
  const injected = [];
  const effects = [];
  const ctx = {
    get: (name) => (name === 'slots' ? { register: (options, component) => { registered.push({ options, component }); return () => undefined; }, inject: (name, factory) => { injected.push(name); factory(); return () => undefined; } } : undefined),
    effect: (factory, label) => { effects.push({ label, dispose: factory() }); },
  };
  mod.apply(ctx);
  assert.deepEqual(mod.inject, ['slots', 'locale']);
  const names = registered.map((entry) => entry.options.name);
  assert.ok(names.includes('settings.section'));
  assert.ok(names.includes('main'));
  assert.ok(names.includes('sidebar.panellist'));
  const section = registered.find((entry) => entry.options.name === 'settings.section');
  assert.equal(section.options.id, 'dsh-github-trending');
  assert.equal(section.options.label(), 'GitHub 趋势');
  const main = registered.find((entry) => entry.options.name === 'main');
  assert.equal(main.options.key, 'dsh-github-trending');
  assert.ok(injected.includes('settings.section'));
  assert.ok(injected.includes('main'));
  assert.ok(injected.includes('sidebar.panellist'));
  assert.equal(effects[0].label, 'dsh-github-trending:client');
});
