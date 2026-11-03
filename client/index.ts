/**
 * Client half 入口：工作台外壳（顶部身份条 + 横向 tab + 主区）。
 *
 * 结构（A 方案定稿）：
 *   1. 第一行 `.dshgt-idbar`：插件名称 / 版本 / 完整包名 / 检查更新 / GitHub（IdentityBar，两个图标紧跟包名）；
 *   2. 第二行 `.dshgt-tabsbar`：横向 tab（概览 / 榜单 / 订阅 / 运行记录 / 设置）+ 右侧状态；
 *   3. 主区 `.dshgt-main`：页面标题（含试跑/立即运行）+ 视图内容。
 *
 * 五个视图：概览 / 榜单 / 订阅 / 运行记录 / 设置。数据只来自 Host 的
 * `/api/morehao/github-trending/*`；这里不碰文件、不碰核心。视图切换用 React state，
 * 不读写 `location.hash`。
 */
import { buildTranslate, activeLang } from './i18n.js';
import { injectStyles } from './styles.js';
import { useStore } from './store.js';
import { SettingsView } from './settings.js';
import { OverviewView } from './overview.js';
import { RunsView } from './runs.js';
import { DigestView } from './digest.js';
import { SubscriptionsView } from './subscriptions.js';
import { AboutDialog } from './about.js';
import { IdentityBar } from './identity-bar.js';
import { RestoreNotice } from './restore-notice.js';
import { usePluginUpdate, isUpdateSettled, deriveSettledNotice } from './update-panel.js';
import { clearPendingUpdate, readPendingUpdate, type PendingUpdate } from './update-store.js';
import { SidebarPanelIcon } from './panel-icon.js';
import { useRunController } from './run-controller.js';
import { credentialView } from './credential.js';
import type { DigestTarget } from './api.js';
import { Btn, h, React } from './ui.js';

export const PANEL_ID = 'dsh-github-trending';

export const inject = ['slots', 'locale'];

interface Slots {
  register: (options: Record<string, unknown>, component: any) => void;
  inject: (name: string, factory: () => unknown) => () => void;
}

type ViewId = 'overview' | 'digest' | 'runs' | 'subscriptions' | 'settings';

const NAV: Array<{ id: ViewId; label: string; icon: string }> = [
  { id: 'overview', label: 'nav.overview', icon: 'grid' },
  { id: 'digest', label: 'nav.digest', icon: 'doc' },
  { id: 'subscriptions', label: 'nav.subscriptions', icon: 'rss' },
  { id: 'runs', label: 'nav.runs', icon: 'list' },
  { id: 'settings', label: 'nav.settings', icon: 'sliders' },
];

function navIcon(name: string, size = 16): any {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  };
  if (name === 'grid') {
    return h(
      'svg',
      common,
      h('rect', { x: 3.5, y: 3.5, width: 7, height: 7, rx: 1.5 }),
      h('rect', { x: 13.5, y: 3.5, width: 7, height: 7, rx: 1.5 }),
      h('rect', { x: 3.5, y: 13.5, width: 7, height: 7, rx: 1.5 }),
      h('rect', { x: 13.5, y: 13.5, width: 7, height: 7, rx: 1.5 }),
    );
  }
  if (name === 'doc') {
    return h(
      'svg',
      common,
      h('path', { d: 'M5 4.5h11a2 2 0 0 1 2 2V20H7a2 2 0 0 1-2-2z' }),
      h('path', { d: 'M8 8h7M8 12h7M8 16h4' }),
    );
  }
  if (name === 'list') {
    return h(
      'svg',
      common,
      h('path', { d: 'M8 6h12M8 12h12M8 18h12' }),
      h('path', { d: 'M4 6h.01M4 12h.01M4 18h.01' }),
    );
  }
  if (name === 'rss') {
    return h(
      'svg',
      common,
      h('path', { d: 'M5 5a14 14 0 0 1 14 14' }),
      h('path', { d: 'M5 11a8 8 0 0 1 8 8' }),
      h('circle', { cx: 6, cy: 18, r: 1.6 }),
    );
  }
  return h(
    'svg',
    common,
    h('path', { d: 'M4 7h10M18 7h2M4 17h4M12 17h8' }),
    h('circle', { cx: 16, cy: 7, r: 2.2 }),
    h('circle', { cx: 10, cy: 17, r: 2.2 }),
  );
}

function relativeFuture(iso: string | undefined, t: ReturnType<typeof buildTranslate>): string | undefined {
  if (iso === undefined) return undefined;
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return undefined;
  const diff = target - Date.now();
  if (diff <= 0) return undefined;
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return t('time.in.minutes', { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.in.hours', { hours, minutes: minutes % 60 });
  return t('time.in.days', { days: Math.floor(hours / 24) });
}

function nextRunText(iso: string | undefined): string {
  if (iso === undefined) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

export function apply(ctx: any): void {
  const slots = ctx.get?.('slots') as Slots | undefined;
  if (slots === undefined || typeof slots.register !== 'function') return;
  const locale = ctx.get?.('locale');
  const t = buildTranslate(locale);
  const lang = activeLang(locale);

  const disposeStyles = injectStyles();
  const disposers: Array<() => void> = [];
  const pickDirectory = async (): Promise<string | undefined> => {
    const workspace = ctx.get?.('uiWorkspace') as { pickDirectory?: () => Promise<string | undefined> } | undefined;
    return workspace?.pickDirectory?.();
  };

  function store(): ReturnType<typeof useStore> {
    return useStore();
  }

  /** 面板页：顶部身份条 + 横向 tab + 五视图。 */
  function PanelView(): any {
    const value = store();
    const controller = useRunController(value);
    const [view, setView] = React.useState<ViewId>('overview');
    const [digestTarget, setDigestTarget] = React.useState<DigestTarget | undefined>(undefined);
    const [aboutOpen, setAboutOpen] = React.useState(false);
    // 自更新恢复提示：进入面板时读一次「刚点过更新」的记号（重开的新进程读得到）。
    // 渲染成居中弹层（不随视图切换消失），点「关闭」才收起并清记号。
    const [pendingUpdate, setPendingUpdate] = React.useState<PendingUpdate | null>(null);
    React.useEffect(() => {
      setPendingUpdate(readPendingUpdate());
    }, []);
    // 面板内直接点「确认更新」时不会重挂载，上面那个 mount-only 的读取拿不到刚写下的记号，
    // 导致更新成功后没有任何「已更新、请重启」的反馈（看起来像点了没反应）。这里订阅共享
    // 更新状态：一旦落到 applied / restart-required（更新已装上、待重启生效），立刻推出恢复提示
    // 弹 RestoreNotice，不必等重新打开面板。判定收敛在 deriveSettledNotice 里（纯函数、可单测）。
    const [updateState] = usePluginUpdate();
    React.useEffect(() => {
      if (!isUpdateSettled(updateState)) return;
      setPendingUpdate((current) => current ?? deriveSettledNotice(updateState, readPendingUpdate()));
    }, [updateState]);

    const openDigest = React.useCallback((target?: DigestTarget): void => {
      if (target !== undefined) setDigestTarget(target);
      setView('digest');
    }, []);
    const openRuns = React.useCallback((): void => setView('runs'), []);
    const openSettings = React.useCallback((): void => setView('settings'), []);
    const openSubscriptions = React.useCallback((): void => setView('subscriptions'), []);
    const openAbout = React.useCallback((): void => setAboutOpen(true), []);
    const state = value.state;
    const plugin = state?.plugin;
    const history = state?.status.history ?? [];
    const schedule = state?.schedule;
    const ready = state === null
      ? 0
      : [
          state.core.state === 'ready',
          credentialView(state.model, t).ok,
          state.settings.repo.path.trim() !== '',
          state.github.configured,
        ].filter(Boolean).length;
    const digestTail = state?.status.lastResult?.date ?? state?.status.history[0]?.date;
    const showActions = view === 'overview' || view === 'runs' || view === 'digest';
    const nextRun = schedule === undefined || !schedule.enabled
      ? t('shell.scheduleOff')
      : schedule.nextRunAt === undefined
        ? `${schedule.time} · ${schedule.timezone}`
        : nextRunText(schedule.nextRunAt);
    const relNext = schedule !== undefined && schedule.enabled && schedule.nextRunAt !== undefined ? relativeFuture(schedule.nextRunAt, t) : undefined;

    const viewNode =
      view === 'overview'
        ? h(OverviewView, {
            t,
            lang,
            store: value,
            controller,
            onOpenDigest: openDigest,
            onOpenRuns: openRuns,
            onOpenSettings: openSettings,
          })
        : view === 'digest'
          ? h(DigestView, {
              t,
              lang,
              store: value,
              controller,
              ...(digestTarget === undefined ? {} : { selected: digestTarget }),
              onSelect: setDigestTarget,
              onOpenRuns: openRuns,
            })
          : view === 'runs'
            ? h(RunsView, { t, store: value, controller, onOpenDigest: openDigest })
            : view === 'subscriptions'
              ? h(SubscriptionsView, { t, store: value, onOpenSettings: openSettings })
              : h(SettingsView, { t, store: value, pickDirectory, onOpenSubscriptions: openSubscriptions });

    return h(
      'div',
      { className: 'dshgt-root dshgt-shell' },
      h(
        'div',
        { className: 'dshgt-app' },
        pendingUpdate === null
          ? null
          : h(RestoreNotice, {
              t,
              version: pendingUpdate.to,
              from: pendingUpdate.from,
              onDismiss: () => { clearPendingUpdate(); setPendingUpdate(null); },
            }),
        plugin === undefined ? null : h(IdentityBar, { t, plugin, onOpenAbout: openAbout }),
        h(
          'div',
          { className: 'dshgt-tabsbar' },
          h(
            'nav',
            { className: 'dshgt-tabnav', 'aria-label': t('shell.nav') },
            NAV.map((item) =>
              h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  className: `dshgt-tab${view === item.id ? ' on' : ''}`,
                  'aria-current': view === item.id ? 'page' : undefined,
                  onClick: () => setView(item.id),
                },
                navIcon(item.icon),
                h('span', null, t(item.label)),
                item.id === 'digest' && digestTail !== undefined
                  ? h('span', { className: 'dshgt-tab-tail dshgt-mono' }, digestTail.slice(5))
                  : item.id === 'runs' && history.length > 0
                    ? h('span', { className: 'dshgt-tab-tail dshgt-mono' }, String(history.length))
                    : null,
              ),
            ),
          ),
          h(
            'div',
            { className: 'dshgt-tabsbar-status' },
            h(
              'span',
              { className: 'dshgt-status-item' },
              h('span', { className: `dshgt-lamp ${ready === 4 ? 'ok' : ready > 0 ? 'warn' : 'err'}` }),
              t('shell.ready', { ready, total: 4 }),
            ),
            h(
              'span',
              { className: 'dshgt-status-item dshgt-next' },
              h('span', { className: 'dshgt-status-key' }, t('shell.nextRun')),
              h('span', { className: 'dshgt-status-val dshgt-mono' }, nextRun),
              relNext === undefined ? null : h('span', { className: 'dshgt-status-sub' }, relNext),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dshgt-main' },
          h(
            'header',
            { className: 'dshgt-page-head' },
            h(
              'div',
              { className: 'dshgt-page-heading' },
              h('h1', null, t(`nav.${view}`)),
              h('p', { className: 'dshgt-dek' }, t(`shell.${view}.dek`)),
            ),
            h(
              'div',
              { className: 'dshgt-head-actions', style: showActions ? undefined : { visibility: 'hidden' } },
              showActions
                ? [
                    h(
                      Btn,
                      {
                        key: 'dry',
                        onClick: () => void controller.run(true),
                        disabled: controller.running || controller.busy,
                      },
                      t('run.dryRunShort'),
                    ),
                    h(
                      Btn,
                      {
                        key: 'force',
                        onClick: () => void controller.run(false, { force: true }),
                        disabled: controller.running || controller.busy,
                      },
                      t('run.force'),
                    ),
                    h(
                      Btn,
                      {
                        key: 'run',
                        variant: 'primary',
                        onClick: () => void controller.run(),
                        disabled: controller.running || controller.busy,
                      },
                      controller.running ? t('run.running') : t('run.button'),
                    ),
                    controller.running
                      ? h(Btn, { key: 'cancel', variant: 'danger', onClick: () => void controller.cancel() }, t('run.cancel'))
                      : null,
                  ]
                : null,
            ),
          ),
          h('div', { className: 'dshgt-main-body' }, view === 'settings' ? viewNode : h('div', { className: 'dshgt-scroll' }, viewNode)),
        ),
      ),
      aboutOpen && state !== null ? h(AboutDialog, { t, state, onClose: () => setAboutOpen(false) }) : null,
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
