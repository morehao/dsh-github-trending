/**
 * Client half 入口：一个左侧栏挂载面 + 一个侧栏入口图标。
 *
 *   main + sidebar.panellist → 面板页（运行 / 设置 两个 tab）
 *   sidebar.panellist → 导航行里的小图标，点它切到面板页
 *
 * 插件只出现在左侧菜单栏一处，不再同时注册 `settings.section`——避免「左侧栏和设置里
 * 都出现一份」。全部数据来自 Host half 的 `/api/morehao/github-trending/*`；这里不碰
 * 文件、不碰核心。
 */
import { buildTranslate } from './i18n.js';
import { injectStyles } from './styles.js';
import { useStore } from './store.js';
import { SettingsView } from './settings.js';
import { RunsView } from './runs.js';
import { SidebarPanelIcon } from './panel-icon.js';
import { h, React } from './ui.js';

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
  const pickDirectory = async (): Promise<string | undefined> => {
    const workspace = ctx.get?.('uiWorkspace') as { pickDirectory?: () => Promise<string | undefined> } | undefined;
    return workspace?.pickDirectory?.();
  };

  function store(): ReturnType<typeof useStore> {
    return useStore();
  }

  /** 面板页：运行 / 设置 两个 tab，共用同一份 store 快照。 */
  function PanelView(): any {
    const value = store();
    const [tab, setTab] = React.useState<'runs' | 'settings'>('runs');
    const tabButton = (id: 'runs' | 'settings', label: string): any =>
      h(
        'button',
        {
          type: 'button',
          className: 'dshgt-tab',
          role: 'tab',
          'aria-selected': tab === id ? 'true' : 'false',
          onClick: () => setTab(id),
        },
        label,
      );
    return h(
      'div',
      { className: 'dshgt-root dshgt-shell' },
      h(
        'div',
        { className: 'dshgt-tabs', role: 'tablist' },
        tabButton('runs', t('tab.runs')),
        tabButton('settings', t('tab.settings')),
      ),
      h(
        'div',
        { className: 'dshgt-content' },
        tab === 'settings'
          ? h(SettingsView, { t, store: value, pickDirectory })
          : h('div', { className: 'dshgt-scroll' }, h(RunsView, { t, store: value, page: true })),
      ),
    );
  }

  disposers.push(
    slots.inject('main', () => {
      const disposeMain = slots.register({ name: 'main', key: PANEL_ID }, PanelView);
      const disposeEntry = slots.inject('sidebar.panellist', () =>
        slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => t('section.title') },
          SidebarPanelIcon,
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
