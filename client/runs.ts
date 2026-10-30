/**
 * 运行页：本次（运行入口 / 9 步 / 最近结果 / 错误）+ 历史（最近 30 条）。
 *
 * 进度是**粗粒度**的：核心只在结束时给一个结果信封，所以「抓取/总结/渲染/提交/PR」
 * 这几步在一次运行内只能显示为「进行中」，不能伪造逐段百分比。
 */
import { Alert, Btn, Card, Inline, KV, Pill, Toggle, duration, h, localTime, React, shortHash } from './ui.js';
import type { Translate } from './i18n.js';
import { apiCall, type RunSummary } from './api.js';
import type { StoreValue } from './store.js';

const STEP_KEYS = ['resolve', 'handshake', 'spawn', 'fetch', 'summarize', 'render', 'commit', 'pr', 'state'];
const CORE_STEPS = new Set(['fetch', 'summarize', 'render', 'commit', 'pr']);

export function RunsView(props: { t: Translate; store: StoreValue; page?: boolean }): any {
  const { t, store } = props;
  const [tab, setTab] = React.useState<'now' | 'history'>('now');
  const [dryRun, setDryRun] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [summary, setSummary] = React.useState<RunSummary | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const state = store.state;

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setSummary(null);
    try {
      const result = await apiCall<{ summary: RunSummary }>('POST', '/run', { dryRun });
      setSummary(result.summary);
      await store.refresh({ quiet: true });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (): Promise<void> => {
    try {
      await apiCall('POST', '/run/cancel', {});
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  if (state === null) {
    return h('div', { className: 'dshgt-root' }, h('p', { className: 'dshgt-hint' }, store.error ?? t('quickfill.loading')));
  }

  const running = state.status.running !== null;
  const shown = summary;
  const lastRecord = state.status.history[0] === undefined ? null : state.status.history[0];
  // 摘要（刚跑完）与历史记录字段不同：摘要没有 at，用当前时间兜底展示
  const last = shown === null ? lastRecord : { ...lastRecord, ...shown, at: new Date().toISOString(), model: { provider: state.settings.model.provider, model: state.settings.model.model } };
  const failedStep = shown !== null && !shown.ok ? stepFromError(shown.error?.area) : null;

  return h(
    'div',
    { className: 'dshgt-root' },
    h(
      'div',
      { className: 'dshgt-head' },
      h('span', { className: 'dshgt-title' }, t('section.title')),
      h('span', { className: 'dshgt-sub' }, t('card.source.hint')),
      h('span', { style: { marginLeft: 'auto' } }, h(Pill, { kind: running || busy ? 'warn' : 'ok' }, running || busy ? t('run.running') : t('run.idle'))),
    ),
    h(
      'div',
      { className: 'dshgt-tabs', role: 'tablist' },
      h('button', { type: 'button', className: 'dshgt-tab', role: 'tab', 'aria-selected': tab === 'now' ? 'true' : 'false', onClick: () => setTab('now') }, t('run.now')),
      h('button', { type: 'button', className: 'dshgt-tab', role: 'tab', 'aria-selected': tab === 'history' ? 'true' : 'false', onClick: () => setTab('history') }, t('run.history')),
    ),
    tab === 'now'
      ? h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          h(
            Card,
            { title: t('run.now'), hint: 'spawn → 单次运行 → 退出' },
            h(
              Inline,
              null,
              h(Btn, { variant: 'primary', onClick: () => void run(), disabled: busy || running }, t('run.button')),
              h(Toggle, { checked: dryRun, label: t('run.dryRun'), onChange: setDryRun }),
              running || busy ? h(Btn, { variant: 'danger', onClick: () => void cancel() }, t('run.cancel')) : null,
            ),
            error === null ? null : h(Alert, { kind: 'err' }, error),
            h(
              'ul',
              { className: 'dshgt-steps' },
              STEP_KEYS.map((key) => {
                const stepState = running || busy ? (CORE_STEPS.has(key) ? 'pending' : key === 'resolve' || key === 'handshake' || key === 'spawn' ? 'active' : 'pending') : shown === null ? 'pending' : failedStep === key ? 'failed' : 'done';
                const label = { done: '✓', active: '…', failed: '✗', pending: '—' }[stepState];
                return h('li', { key, className: 'dshgt-step', 'data-state': stepState }, h('span', null, t(`step.${key}`)), h('span', { className: 'st' }, label));
              }),
            ),
          ),
          last === null
            ? h(Card, { title: t('run.last.title') }, h('p', { className: 'dshgt-hint' }, t('run.last.none')))
            : h(
                Card,
                { title: t('run.last.title'), extra: h(Pill, { kind: last.ok ? (last.skipped ? 'warn' : 'ok') : 'err' }, last.skipped ? t('state.skipped') : last.ok ? t('state.ok') : t('state.failed')) },
                h(KV, {
                  items: [
                    [t('col.date'), localTime(last.at)],
                    [t('run.usage.core'), last.coreVersion || '—'],
                    [t('run.usage.files'), String(last.files)],
                    [t('run.usage.duration'), duration(last.durationMs)],
                    [t('run.usage.hash'), h('span', { className: 'dshgt-mono' }, shortHash(last.contentHash))],
                    [t('run.usage.branch'), h('span', { className: 'dshgt-mono' }, last.branch ?? '—')],
                    [t('run.usage.pr'), last.prUrl === undefined ? '—' : h('a', { href: last.prUrl, target: '_blank', rel: 'noreferrer' }, last.prUrl)],
                    ['model', `${state.settings.model.provider} / ${state.settings.model.model || '—'}`],
                  ],
                }),
                last.warnings.length === 0 ? null : h('p', { className: 'dshgt-hint' }, last.warnings.join('；')),
              ),
          shown !== null && shown.error !== undefined
            ? h(
                Card,
                { title: t('run.error.title') },
                h(Alert, { kind: 'err', title: `${t('error.prefix')} ${shown.error.code}` },
                  h('div', null, shown.error.message),
                  h('div', { className: 'dshgt-hint' }, shown.error.hint),
                  shown.error.inferred ? h('div', { className: 'dshgt-hint' }, '（错误码由插件按核心 stderr 推断）') : null,
                ),
                shown.logFile === undefined ? null : h('p', { className: 'dshgt-hint' }, `日志：${shown.logFile}`),
              )
            : null,
        )
      : h(HistoryTable, { t, records: state.status.history }),
  );
}

function stepFromError(area: string | undefined): string {
  switch (area) {
    case 'core':
      return 'resolve';
    case 'model':
      return 'summarize';
    case 'repo':
    case 'auth':
      return 'commit';
    default:
      return 'state';
  }
}

function HistoryTable(props: { t: Translate; records: Array<Record<string, any>> }): any {
  const { t, records } = props;
  return h(
    Card,
    { title: t('run.history.title'), hint: t('run.history.hint') },
    records.length === 0
      ? h('p', { className: 'dshgt-hint' }, t('run.history.empty'))
      : h(
          'table',
          { className: 'dshgt-table' },
          h('thead', null, h('tr', null, [t('col.date'), t('col.result'), t('col.files'), t('col.duration'), t('col.commit'), t('col.error')].map((label) => h('th', { key: label }, label)))),
          h(
            'tbody',
            null,
            records.map((record: Record<string, any>) =>
              h(
                'tr',
                { key: String(record.id) },
                h('td', { className: 'dshgt-mono' }, localTime(record.at)),
                h('td', null, h(Pill, { kind: record.ok ? (record.skipped ? 'warn' : 'ok') : 'err' }, record.kind === 'dry-run' ? t('state.dry') : record.skipped ? t('state.skipped') : record.ok ? t('state.ok') : t('state.failed'))),
                h('td', { className: 'dshgt-mono' }, String(record.files ?? 0)),
                h('td', { className: 'dshgt-mono' }, duration(Number(record.durationMs ?? 0))),
                h('td', { className: 'dshgt-mono' }, [record.branch, record.prUrl].filter(Boolean).join(' · ') || '—'),
                h('td', { className: 'dshgt-mono' }, record.errorCode ?? '—'),
              ),
            ),
          ),
        ),
  );
}
