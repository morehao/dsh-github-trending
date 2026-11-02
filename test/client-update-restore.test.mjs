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

test('RestoreNotice：渲染带版本的标题，并在约 6 秒后自动 onDismiss', async () => {
  // 捕获 React 的 effect，手动触发，并用假 setTimeout 驱动自动收起。
  let effectFn = null;
  let cleared = 0;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let scheduledDelay = null;
  let scheduledFn = null;
  globalThis.setTimeout = (fn, delay) => { scheduledFn = fn; scheduledDelay = delay; return 1; };
  globalThis.clearTimeout = () => { cleared += 1; };

  // 用 CJS 风格桩：ui.js 里 `import React from 'react'` + `h = React.createElement`
  const elements = [];
  const reactStub = {
    createElement: (type, props, ...children) => {
      const node = { type, props: props || {}, children };
      elements.push(node);
      return node;
    },
    useState: (v) => [typeof v === 'function' ? v() : v, () => undefined],
    useEffect: (fn) => { effectFn = fn; return () => undefined; },  };

  try {
    const mod = await loadModuleWithReact('client/restore-notice.ts', reactStub);
    const t = (key, params) => (params && params.version !== undefined ? `${key}:${params.version}` : key);
    let dismissed = false;
    mod.RestoreNotice({ t, version: '0.8.8', onDismiss: () => { dismissed = true; } });

    // 找到标题节点内容
    const titleNode = elements.find((e) => e.props.className === 'dshgt-restore-title');
    assert.ok(titleNode, '应渲染 .dshgt-restore-title');
    assert.equal(titleNode.children[0], 'restoreNotice.title:0.8.8');

    assert.equal(typeof effectFn, 'function', '应注册 useEffect');
    // 触发 effect（React 在提交后调用），其中才会 setTimeout
    const cleanup = effectFn();
    assert.equal(scheduledDelay, 6000, '自动收起延时应为 6000ms');
    assert.equal(typeof scheduledFn, 'function');
    scheduledFn();
    assert.equal(dismissed, true, '6 秒后应调用 onDismiss');
    // 卸载时清理定时器
    assert.equal(typeof cleanup, 'function');
    cleanup();
    assert.equal(cleared, 1, 'effect 清理应 clearTimeout');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
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
