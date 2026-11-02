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

test('RestoreNotice：居中弹层渲染版本跨栏/标题/正文/唯一「关闭」按钮，且不自动消失', async () => {
  // 捕获 React 的 effect，确认组件不注册任何自动收起的定时器。
  let effectFn = null;
  const realSetTimeout = globalThis.setTimeout;
  let scheduled = 0;
  globalThis.setTimeout = () => { scheduled += 1; return 1; };
  globalThis.clearTimeout = () => {};

  let elements = [];
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

    // ① 有旧版本：版本跨栏 + 结论式标题
    let dismissed = 0;
    mod.RestoreNotice({ t, version: '0.8.11', from: '0.8.10', onDismiss: () => { dismissed += 1; } });

    const mask = elements.find((e) => e.props.className === 'dshgt-restore-mask');
    assert.ok(mask, '应渲染遮罩 .dshgt-restore-mask（铺满窗口、弹层居中）');
    const dialog = elements.find((e) => e.props.className === 'dshgt-restore');
    assert.ok(dialog, '应渲染对话框 .dshgt-restore');
    assert.equal(dialog.props.role, 'dialog');
    assert.equal(dialog.props['aria-modal'], 'true');
    assert.equal(dialog.props['aria-labelledby'], 'dshgt-restore-title');

    const fromChip = elements.find((e) => e.props.className === 'dshgt-restore-version');
    const toChip = elements.find((e) => e.props.className === 'dshgt-restore-version is-new');
    assert.ok(fromChip && toChip, '应渲染 from → to 两枚版本号');
    assert.equal(fromChip.children[0], 'v0.8.10', '旧版本统一补 v 前缀');
    assert.equal(toChip.children[0], 'v0.8.11');

    const titleNode = elements.find((e) => e.props.className === 'dshgt-restore-title');
    assert.ok(titleNode, '应渲染 .dshgt-restore-title');
    assert.equal(titleNode.props.id, 'dshgt-restore-title');
    assert.equal(titleNode.children[0], 'restoreNotice.titleInstalled', '有版本跨栏时标题只说结论');
    const bodyNode = elements.find((e) => e.props.className === 'dshgt-restore-body');
    assert.ok(bodyNode, '应渲染 .dshgt-restore-body');
    assert.equal(bodyNode.children[0], 'restoreNotice.body');

    // 唯一动作：「关闭」一个按钮，点了才收起
    const buttons = elements.filter((e) => e.type === 'button');
    assert.equal(buttons.length, 1, '弹层里只应有一个按钮');
    assert.equal(buttons[0].children[0], 'restoreNotice.dismiss');
    assert.equal(buttons[0].props.className, 'dshgt-restore-close');
    assert.equal(buttons[0].props.autoFocus, true, '焦点应落在唯一按钮上');
    buttons[0].props.onClick();
    assert.equal(dismissed, 1);

    // 关键回归：没有任何自动收起的定时器
    if (typeof effectFn === 'function') effectFn();
    assert.equal(scheduled, 0, '不应注册任何自动收起的定时器');

    // ② 没有旧版本（首次安装）：不显示版本跨栏，标题退回带版本号的写法
    elements = [];
    mod.RestoreNotice({ t, version: '0.8.11', onDismiss: () => undefined });
    assert.equal(elements.filter((e) => e.props.className === 'dshgt-restore-versions').length, 0, '无旧版本时不应渲染跨栏');
    const bareTitle = elements.find((e) => e.props.className === 'dshgt-restore-title');
    assert.equal(bareTitle.children[0], 'restoreNotice.title:0.8.11', '标题带版本号、且去掉重复的 v');
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
