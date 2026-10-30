/**
 * Client half 入口：两个挂载面 + 一个侧栏卡片。
 *
 *   settings.section  → 设置页（内容来源 / 模型 / 仓库 / 认证 / 榜单 / 调度）
 *   main + sidebar.panellist → 运行页（本次 / 历史）
 *   侧栏卡片 → 运行页的紧凑版（状态 + 一键运行）
 *
 * 全部数据来自 Host half 的 `/api/morehao/github-trending/*`；这里不碰文件、不碰核心。
 */
import { buildTranslate } from './i18n.js';
import { injectStyles } from './styles.js';
import { useStore } from './store.js';
import { SettingsView } from './settings.js';
import { RunsView } from './runs.js';
import { Widget } from './widget.js';
import { h } from './ui.js';

export const PANEL_ID = 'dsh-github-trending';

export const inject = ['slots', 'locale'];

interface Slots {
  register: (options: Record<string, unknown>, component: any) => () => void;
  inject: (name: string, factory: () => unknown) => () => void;
}

export function apply(ctx: any): void {
  const slots = ctx.get?.('slots') as Slots | undefined;
  if (slots === undefined || typeof slots.register !== 'function') return;
  const locale = ctx.get?.('locale');
  const t = buildTranslate(locale);

  const disposeStyles = injectStyles();
  const disposers: Array<() => void> = [];
  const layout = ctx.get?.('layout');
  const pickDirectory = async (): Promise<string | undefined> => {
    const workspace = ctx.get?.('uiWorkspace') as { pickDirectory?: () => Promise<string | undefined> } | undefined;
    return workspace?.pickDirectory?.();
  };

  function store(): ReturnType<typeof useStore> {
    return useStore();
  }

  function SettingsSurface(props: { close?: () => void }): any {
    const value = store();
    return h(SettingsView, { t, store: value, pickDirectory, ...(props?.close === undefined ? {} : { onClose: props.close }) });
  }

  function RunsSurface(): any {
    const value = store();
    return h(RunsView, { t, store: value, page: true });
  }

  function SidebarWidget(): any {
    const value = store();
    return h(Widget, {
      t,
      store: value,
      onOpen: () => {
        try {
          layout?.selectPanel?.(PANEL_ID);
        } catch {
          // 侧栏未就绪时点开失败不算错，用户仍可从设置页进入
        }
      },
    });
  }

  disposers.push(
    slots.inject('settings.section', () =>
      slots.register(
        { name: 'settings.section', id: PANEL_ID, order: 40, label: () => t('section.title') },
        SettingsSurface,
      ),
    ),
  );

  disposers.push(
    slots.inject('main', () => {
      const disposeMain = slots.register({ name: 'main', key: PANEL_ID }, RunsSurface);
      const disposeEntry = slots.inject('sidebar.panellist', () =>
        slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => t('section.title') },
          SidebarWidget,
        ),
      );
      return [disposeMain, disposeEntry];
    }),
  );

  if (typeof ctx.effect === 'function') {
    ctx.effect(
      () => () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose();
          } catch {
            // 单个卸载失败不影响其它挂载点
          }
        }
        disposeStyles();
      },
      'dsh-github-trending:client',
    );
  }
}
