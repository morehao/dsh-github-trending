/**
 * 侧栏卡片：状态、下次运行、上次结果、核心版本 + 立即运行 / 试跑。
 * 与运行页共用 `/state`（同一轮询），点「立即运行」直接 POST /run。
 */
import { Btn, Pill, duration, h, localTime, React } from './ui.js';
import type { Translate } from './i18n.js';
import { apiCall } from './api.js';
import type { StoreValue } from './store.js';

export function Widget(props: { t: Translate; store: StoreValue; onOpen?: () => void }): any {
  const { t, store } = props;
  const state = store.state;
  const [busy, setBusy] = React.useState(false);

  if (state === null) {
    return h('div', { className: 'dshgt-widget dshgt-root' }, h('h4', null, t('widget.title')), h('span', { className: 'dshgt-hint' }, store.error ?? t('quickfill.loading')));
  }

  const running = state.status.running !== null;
  const last = state.status.lastResult;
  const coreKind = state.core.state === 'ready' ? 'ok' : state.core.state === 'incompatible' ? 'warn' : 'err';

  const run = async (dryRun: boolean): Promise<void> => {
    setBusy(true);
    try {
      await apiCall('POST', '/run', { dryRun });
      await store.refresh({ quiet: true });
    } catch {
      // 错误会体现在最后一次记录里
    } finally {
      setBusy(false);
    }
  };

  return h(
    'div',
    { className: 'dshgt-widget dshgt-root' },
    h(
      'div',
      { className: 'dshgt-card-h' },
      h('h4', null, t('widget.title')),
      h('span', { style: { marginLeft: 'auto' } }, h(Pill, { kind: running || busy ? 'warn' : last === null ? 'idle' : last.ok ? 'ok' : 'err' }, running || busy ? t('run.running') : last === null ? t('widget.never') : last.ok ? (last.skipped ? t('state.skipped') : t('state.ok')) : t('state.failed'))),
    ),
    h('div', { className: 'dshgt-hint' }, `${t('widget.next')}：${state.schedule.nextRunAt === undefined ? '—' : localTime(state.schedule.nextRunAt)}`),
    h('div', { className: 'dshgt-hint' }, `${t('widget.last')}：${last === null ? t('widget.never') : `${localTime(last.at)} · ${last.files} ${t('col.files')} · ${duration(last.durationMs)}`}`),
    h('div', { className: 'dshgt-hint dshgt-mono' }, `core ${state.core.version ?? '—'} · ipc ${state.core.ipcSchema ?? '—'}`, h('span', { className: `dshgt-dot ${coreKind}`, style: { marginLeft: 6, display: 'inline-block' } })),
    h(
      'div',
      { className: 'dshgt-inline' },
      h(Btn, { small: true, variant: 'primary', disabled: busy || running, onClick: () => void run(false) }, t('widget.run')),
      h(Btn, { small: true, disabled: busy || running, onClick: () => void run(true) }, t('run.dryRun')),
      props.onOpen === undefined ? null : h(Btn, { small: true, onClick: props.onOpen }, t('widget.open')),
    ),
  );
}
