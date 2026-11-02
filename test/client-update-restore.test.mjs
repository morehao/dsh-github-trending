import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 把某个 client 模块打成 ESM 后 import（platform=node，离线）。 */
async function loadModule(entryRel) {
  const outfile = path.join(mkdtempSync(path.join(tmpdir(), 'dshgt-upd-')), 'mod.mjs');
  await build({
    absWorkingDir: root,
    entryPoints: [path.join(root, entryRel)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    external: ['react'],
  });
  return import(pathToFileURL(outfile).href);
}

/** 最小 localStorage 桩：只在内存里，模拟浏览器行为。 */
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

test('update-store：写入 → 读回，键前缀与结构正确', async () => {
  const storage = makeStorage();
  globalThis.window = { localStorage: storage };
  try {
    const mod = await loadModule('client/update-store.ts');
    mod.writePendingUpdate('0.8.7', '0.8.8');
    const raw = storage.getItem('dsh-github-trending:update-pending');
    assert.ok(raw, '应写入 dsh-github-trending:update-pending 键');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.from, '0.8.7');
    assert.equal(parsed.to, '0.8.8');
    assert.equal(typeof parsed.at, 'number');
    const read = mod.readPendingUpdate();
    assert.deepEqual({ from: read.from, to: read.to }, { from: '0.8.7', to: '0.8.8' });
    mod.clearPendingUpdate();
    assert.equal(storage.getItem('dsh-github-trending:update-pending'), null);
    assert.equal(mod.readPendingUpdate(), null);
  } finally {
    delete globalThis.window;
  }
});

test('update-store：损坏 / 过期 / 缺失都 fail-open 返回 null，不抛', async () => {
  const storage = makeStorage();
  globalThis.window = { localStorage: storage };
  try {
    const mod = await loadModule('client/update-store.ts');
    // 缺失
    assert.equal(mod.readPendingUpdate(), null);
    // 损坏 JSON → null 并清理
    storage.setItem('dsh-github-trending:update-pending', '{not json');
    assert.equal(mod.readPendingUpdate(), null);
    assert.equal(storage.getItem('dsh-github-trending:update-pending'), null);
    // 过期（at 早于 24h 之前）
    storage.setItem('dsh-github-trending:update-pending', JSON.stringify({ from: 'a', to: 'b', at: Date.now() - 25 * 60 * 60 * 1000 }));
    assert.equal(mod.readPendingUpdate(), null);
    assert.equal(storage.getItem('dsh-github-trending:update-pending'), null);
  } finally {
    delete globalThis.window;
  }
});

test('update-store：无 localStorage（SSR/测试 vm）全程 fail-open', async () => {
  // 不设 globalThis.window
  const mod = await loadModule('client/update-store.ts');
  assert.doesNotThrow(() => mod.writePendingUpdate('1', '2'));
  assert.equal(mod.readPendingUpdate(), null);
  assert.doesNotThrow(() => mod.clearPendingUpdate());
});

test('RestoreNotice：顶部横条渲染标题/正文/按钮，且不再自动消失', async () => {
  // 捕获 React 的 effect，确认组件不再注册任何自动收起的定时器。
  let effectFn = null;
  const realSetTimeout = globalThis.setTimeout;
  let scheduled = 0;
  globalThis.setTimeout = () => { scheduled += 1; return 1; };
  globalThis.clearTimeout = () => {};

  const elements = [];
  const reactStub = {
    createElement: (type, props, ...children) => {
      const node = { type, props: props || {}, children };
      elements.push(node);
      return node;
    },
    useState: (v) => [typeof v === 'function' ? v() : v, () => undefined],
    useEffect: (fn) => { effectFn = fn; return () => undefined; },
  };

  try {
    const mod = await loadModuleWithReact('client/restore-notice.ts', reactStub);
    const t = (key, params) => (params && params.version !== undefined ? `${key}:${params.version}` : key);
    let dismissed = false;
    let restarted = false;
    mod.RestoreNotice({
      t,
      version: '0.8.8',
      onRestart: () => { restarted = true; },
      onDismiss: () => { dismissed = true; },
    });

    // 标题
    const titleNode = elements.find((e) => e.props.className === 'dshgt-restore-title');
    assert.ok(titleNode, '应渲染 .dshgt-restore-title');
    assert.equal(titleNode.children[0], 'restoreNotice.title:0.8.8');
    // 正文使用 restoreNotice.body
    const bodyNode = elements.find((e) => e.props.className === 'dshgt-restore-body');
    assert.ok(bodyNode, '应渲染 .dshgt-restore-body');
    assert.equal(bodyNode.children[0], 'restoreNotice.body');
    // 根节点是「恢复提示」横条，不是右下角浮层（类名仍为 dshgt-restore，靠 styles 改成顶部横条）
    const rootNode = elements.find((e) => e.props.className === 'dshgt-restore');
    assert.ok(rootNode, '应渲染 .dshgt-restore 根节点');

    // 关键回归：不再有 effect 自动定时收起
    if (typeof effectFn === 'function') effectFn();
    assert.equal(scheduled, 0, '不应注册任何自动收起的定时器（改为常驻，点知道了才收起）');

    // 两个按钮：重启 + 知道了，点击各自回调
    const btnByText = (label) => elements.find((e) => e.type && e.props && (e.props.onClick === undefined ? false : true) && e.children && e.children[0] === label);
    // Btn 在 ui.js 里是函数组件，这里被 stub 成 createElement('Btn'?) —— 直接查找按钮文本节点
    const texts = elements.filter((e) => typeof e.children?.[0] === 'string').map((e) => e.children[0]);
    assert.ok(texts.includes('restoreNotice.restart'), '应有「退出并重启」按钮文案');
    assert.ok(texts.includes('restoreNotice.dismiss'), '应有「知道了」按钮文案');
    // 直接调用传入的按钮 onClick
    const buttonNodes = elements.filter((e) => typeof e.props?.onClick === 'function');
    const restartBtn = buttonNodes.find((e) => e.children?.includes('restoreNotice.restart'));
    const dismissBtn = buttonNodes.find((e) => e.children?.includes('restoreNotice.dismiss'));
    assert.ok(restartBtn, '重启按钮应有 onClick');
    assert.ok(dismissBtn, '知道了按钮应有 onClick');
    restartBtn.props.onClick();
    assert.equal(restarted, true);
    dismissBtn.props.onClick();
    assert.equal(dismissed, true);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

/** 把 React 用桩替换后打包 import（用 alias 把 react 指到桩）。 */
async function loadModuleWithReact(entryRel, reactStub) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dshgt-upd-react-'));
  const stubPath = path.join(dir, 'react-stub.mjs');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(stubPath, `const stub = globalThis.__REACT_STUB__; export default stub; export const { createElement, useState, useEffect, useRef, useCallback, useMemo, Fragment } = stub;`);
  const outfile = path.join(dir, 'mod.mjs');
  await build({
    absWorkingDir: root,
    entryPoints: [path.join(root, entryRel)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    alias: { react: stubPath },
  });
  globalThis.__REACT_STUB__ = reactStub;
  return import(pathToFileURL(outfile).href);
}
