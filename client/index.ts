/**
 * Client half 入口：01 工作台外壳（左轨 + 页头 + 主区）。
 *
 * 四个视图：概览 / 日报 / 运行记录 / 设置。设置继续复用 #13 的 `SettingsView`
 * （本轮不重排，见 execution-plan-final P5）；其余三个是本轮新增。
 *
 * 数据只来自 Host 的 `/api/morehao/github-trending/*`；这里不碰文件、不碰核心。
 * 视图切换用 React state，不读写 `location.hash`（面板在宿主内，改 hash 不礼貌）。
 */
import { buildTranslate, activeLang } from './i18n.js';
import { injectStyles } from './styles.js';
import { useStore } from './store.js';
import { SettingsView } from './settings.js';
import { OverviewView } from './overview.js';
import { RunsView } from './runs.js';
import { DigestView } from './digest.js';
import { AboutDialog } from './about.js';
import { SidebarPanelIcon } from './panel-icon.js';
import { useRunController } from './run-controller.js';
import { credentialView } from './credential.js';
import { Btn, copyText, h, React } from './ui.js';

export const PANEL_ID = 'dsh-github-trending';

export const inject = ['slots', 'locale'];

interface Slots {
  register: (options: Record<string, unknown>, component: any) => void;
  inject: (name: string, factory: () => unknown) => () => void;
}

type ViewId = 'overview' | 'digest' | 'runs' | 'settings';

const NAV: Array<{ id: ViewId; label: string; icon: string }> = [
  { id: 'overview', label: 'nav.overview', icon: 'grid' },
  { id: 'digest', label: 'nav.digest', icon: 'doc' },
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
  return h(
    'svg',
    common,
    h('path', { d: 'M4 7h10M18 7h2M4 17h4M12 17h8' }),
    h('circle', { cx: 16, cy: 7, r: 2.2 }),
    h('circle', { cx: 10, cy: 17, r: 2.2 }),
  );
}

function brandLogo(): any {
  return h(
    'svg',
    { width: 28, height: 28, viewBox: '0 0 64 64', 'aria-hidden': 'true' },
    h('rect', { x: 3, y: 3, width: 58, height: 58, rx: 15, fill: '#0d1117', stroke: 'rgba(255,255,255,.14)', strokeWidth: 1 }),
    h('path', {
      d: 'M18 46V22l14 12 14-12v24',
      fill: 'none',
      stroke: '#58a6ff',
      strokeWidth: 4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
    h('circle', { cx: 32, cy: 45, r: 3, fill: '#3fb950' }),
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
  return date.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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

  /** 面板页：01 外壳 + 四个视图。 */
  function PanelView(): any {
    const value = store();
    const controller = useRunController(value);
    const [view, setView] = React.useState<ViewId>('overview');
    const [digestDate, setDigestDate] = React.useState<string | undefined>(undefined);
    const [aboutOpen, setAboutOpen] = React.useState(false);

    const openDigest = React.useCallback((date?: string): void => {
      if (date !== undefined) setDigestDate(date);
      setView('digest');
    }, []);
    const openRuns = React.useCallback((): void => setView('runs'), []);
    const openSettings = React.useCallback((): void => setView('settings'), []);
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
    const fullName = plugin === undefined ? undefined : `${plugin.name}@v${plugin.version}`;
    const digestTail = digestDate ?? state?.status.lastResult?.date ?? state?.status.history[0]?.date;
    const showActions = view === 'overview' || view === 'runs';

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
              ...(digestDate === undefined ? {} : { selectedDate: digestDate }),
              onSelectDate: setDigestDate,
              onOpenRuns: openRuns,
            })
          : view === 'runs'
            ? h(RunsView, { t, store: value, controller, onOpenDigest: openDigest })
            : h(SettingsView, { t, store: value, pickDirectory });

    return h(
      'div',
      { className: 'dshgt-root dshgt-shell' },
      h(
        'div',
        { className: 'dshgt-app' },
        h(
          'aside',
          { className: 'dshgt-rail' },
          h(
            'div',
            { className: 'dshgt-brand' },
            brandLogo(),
            h(
              'div',
              null,
              h('div', { className: 'dshgt-brand-name' }, t('section.title')),
              h('div', { className: 'dshgt-brand-ver' }, plugin === undefined ? '' : `v${plugin.version}`),
            ),
          ),
          h(
            'nav',
            { className: 'dshgt-nav', 'aria-label': t('shell.nav') },
            NAV.map((item) =>
              h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  className: `dshgt-nav-item${view === item.id ? ' on' : ''}`,
                  'aria-current': view === item.id ? 'page' : undefined,
                  onClick: () => setView(item.id),
                },
                navIcon(item.icon),
                h('span', null, t(item.label)),
                item.id === 'digest' && digestTail !== undefined
                  ? h('span', { className: 'dshgt-nav-tail' }, h('span', { className: 'dshgt-mono' }, digestTail.slice(5)))
                  : item.id === 'runs' && history.length > 0
                    ? h('span', { className: 'dshgt-nav-tail' }, h('span', { className: 'dshgt-mono' }, String(history.length)))
                    : null,
              ),
            ),
          ),
          h('div', { className: 'dshgt-rail-spacer' }),
          h(
            'div',
            { className: 'dshgt-rail-status' },
            h('div', { className: 'dshgt-rail-cap' }, t('shell.nextRun')),
            h(
              'div',
              { className: 'dshgt-rail-time' },
              schedule === undefined || !schedule.enabled
                ? t('shell.scheduleOff')
                : schedule.nextRunAt === undefined
                  ? `${schedule.time} · ${schedule.timezone}`
                  : nextRunText(schedule.nextRunAt),
            ),
            h(
              'div',
              { className: 'dshgt-rail-count' },
              schedule !== undefined && schedule.enabled && schedule.nextRunAt !== undefined
                ? relativeFuture(schedule.nextRunAt, t) ?? ''
                : schedule === undefined
                  ? ''
                  : `${schedule.time} · ${schedule.timezone}`,
            ),
            h(
              'div',
              { className: 'dshgt-rail-ready' },
              h('span', { className: `dshgt-lamp ${ready === 4 ? 'ok' : ready > 0 ? 'warn' : 'err'}` }),
              t('shell.ready', { ready, total: 4 }),
            ),
          ),
          h(
            'div',
            { className: 'dshgt-rail-pkg' },
            h(
              'button',
              {
                type: 'button',
                className: 'dshgt-pkg-name',
                onClick: () => setAboutOpen(true),
                title: plugin === undefined ? '' : fullName,
              },
              plugin?.name ?? t('section.title'),
            ),
            h(
              'div',
              { className: 'dshgt-pkg-sub' },
              h('span', { className: 'dshgt-mono' }, plugin === undefined ? '' : `@v${plugin.version}`),
              plugin?.repository === undefined
                ? null
                : h(
                    'a',
                    { href: plugin.repository, target: '_blank', rel: 'noreferrer' },
                    `${t('shell.github')} ↗`,
                  ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshgt-pkg-copy',
                  title: t('shell.package.copy'),
                  'aria-label': t('shell.package.copy'),
                  disabled: fullName === undefined,
                  onClick: () => {
                    if (fullName !== undefined) void copyText(fullName);
                  },
                },
                navIcon('doc', 13),
              ),
            ),
          ),
        ),
        h(
          'main',
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
