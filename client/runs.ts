/**
 * 运行记录：最近 30 条列表 + 展开详情 + 只读日志抽屉。
 *
 * 日志不是实时流：按需 `GET /log?id=`，Host 只回最后 64 KB。运行入口统一走
 * `useRunController`，运行中禁用重复触发。
 */
import { Alert, Btn, copyText, duration, h, shortHash, shortTime, React } from './ui.js';
import type { Translate } from './i18n.js';
import { getLog, type RunRecord, type StatePayload } from './api.js';
import type { StoreValue } from './store.js';
import type { RunController } from './run-controller.js';
import { LiveRun } from './live-run.js';
import { reasonHint, skipHint } from './error-copy.js';

type Filter = 'all' | 'failed' | 'dry';
const FILTERS: Array<{ id: Filter; key: string }> = [
  { id: 'all', key: 'runs.filter.all' },
  { id: 'failed', key: 'runs.filter.failed' },
  { id: 'dry', key: 'runs.filter.dry' },
];

export interface RunsProps {
  t: Translate;
  store: StoreValue;
  controller: RunController;
  onOpenDigest: (date?: string) => void;
}

function recordSummary(t: Translate, record: RunRecord): string {
  if (!record.ok) {
    return [record.errorCode, record.errorMessage].filter((item) => item !== undefined && item !== '').join(' · ') || t('state.failed');
  }
  if (record.skipped) return skipHint(t, record.skipReason, t('runs.noChange'));
  if (record.kind === 'dry-run') return t('runs.dryHint');
  if (record.branch !== undefined) return record.branch;
  if (record.commit !== undefined) return record.commit;
  if (record.prUrl !== undefined) return t('runs.prCreated');
  return '—';
}

function prStatus(t: Translate, state: StatePayload, record: RunRecord): { label: string; kind: 'warn' | 'ok' } | null {
  if (record.prUrl === undefined) return null;
  const pending = state.status.pendingPr;
  if (pending !== null && pending.url === record.prUrl) {
    return { label: state.status.pendingPrState === 'unknown' ? t('runs.prUnknown') : t('runs.pendingPr'), kind: 'warn' };
  }
  return { label: t('runs.prCreated'), kind: 'ok' };
}

function LogDrawer(props: { t: Translate; runId: string; onClose: () => void }): any {
  const { t, runId } = props;
  const [loading, setLoading] = React.useState(true);
  const [text, setText] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setText('');
    getLog(runId, controller.signal)
      .then((payload) => {
        if (controller.signal.aborted) return;
        setText(payload.text);
        setLoading(false);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : String(failure));
        setLoading(false);
      });
    return () => controller.abort();
  }, [runId]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props]);

  return h(
    'div',
    { className: 'dshgt-modal-mask', onClick: (event: any) => { if (event.target === event.currentTarget) props.onClose(); } },
    h(
      'div',
      { className: 'dshgt-modal dshgt-log-modal', role: 'dialog', 'aria-modal': 'true' },
      h(
        'div',
        { className: 'dshgt-log-head' },
        h('h3', { className: 'dshgt-log-title' }, t('log.title')),
        h('span', { className: 'dshgt-hint dshgt-mono' }, runId),
        h(Btn, { small: true, onClick: () => props.onClose() }, t('log.close')),
      ),
      loading ? h('p', { className: 'dshgt-hint' }, t('log.loading')) : null,
      error === null ? null : h(Alert, { kind: 'err' }, error),
      loading || error !== null ? null : text === '' ? h('p', { className: 'dshgt-hint' }, t('log.empty')) : h('pre', { className: 'dshgt-log-pre' }, text),
      h(
        'div',
        { className: 'dshgt-log-foot' },
        h(
          Btn,
          {
            small: true,
            disabled: text === '',
            onClick: () => {
              void copyText(text).then((okResult) => {
                if (!okResult) return;
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              });
            },
          },
          copied ? t('log.copied') : t('log.copy'),
        ),
        h('span', { className: 'dshgt-hint' }, t('log.truncated')),
      ),
    ),
  );
}

export function RunsView(props: RunsProps): any {
  const { t, store, controller } = props;
  const [filter, setFilter] = React.useState<Filter>('all');
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [logId, setLogId] = React.useState<string | null>(null);
  const state = store.state;

  if (state === null) {
    return h('div', { className: 'dshgt-empty' }, store.error ?? t('quickfill.loading'));
  }

  const history = state.status.history;
  const records = history.filter((record) => {
    if (filter === 'failed') return !record.ok;
    if (filter === 'dry') return record.kind === 'dry-run';
    return true;
  });

  return h(
    'div',
    { className: 'dshgt-view dshgt-runs' },
    controller.running ? h(LiveRun, { t, controller, startedAt: controller.startedAt }) : null,
    controller.error === null ? null : h('div', { className: 'dshgt-alert err' }, controller.error),
    h(
      'div',
      { className: 'dshgt-runs-head' },
      h('span', { className: 'dshgt-hint' }, t('runs.count', { count: history.length })),
      h(
        'div',
        { className: 'dshgt-runs-filter' },
        FILTERS.map((item) =>
          h(
            'button',
            {
              key: item.id,
              type: 'button',
              className: 'dshgt-chip',
              'aria-pressed': filter === item.id ? 'true' : 'false',
              onClick: () => setFilter(item.id),
            },
            t(item.key),
          ),
        ),
      ),
    ),
    records.length === 0
      ? h('div', { className: 'dshgt-empty' }, t('runs.empty'))
      : h(
          'div',
          { className: 'dshgt-run-list' },
          records.map((record) => {
            const open = openId === record.id;
            const pr = prStatus(t, state, record);
            return h(
              'div',
              { className: `dshgt-run-item${open ? ' open' : ''}`, key: record.id },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshgt-run-row',
                  'aria-expanded': open ? 'true' : 'false',
                  onClick: () => setOpenId(open ? null : record.id),
                },
                h('span', { className: `dshgt-lamp ${record.ok ? (record.skipped || record.kind === 'dry-run' ? 'warn' : 'ok') : 'err'}` }),
                h('span', { className: 'dshgt-run-date' }, shortTime(record.at)),
                h(
                  'span',
                  { className: 'dshgt-run-what' },
                  record.kind === 'dry-run' ? t('state.dry') : record.skipped ? t('state.skipped') : record.ok ? t('state.ok') : t('state.failed'),
                  h('span', { className: 'dshgt-run-muted' }, recordSummary(t, record)),
                  record.legacy === true ? h('span', { className: 'dshgt-tag dshgt-inline-tag' }, t('runs.legacy')) : null,
                ),
                h('span', { className: 'dshgt-run-files' }, t('runs.files', { count: record.files })),
                h('span', { className: 'dshgt-run-duration' }, duration(record.durationMs)),
                h('span', { className: 'dshgt-run-chev' }, '›'),
              ),
              open
                ? h(
                    'div',
                    { className: 'dshgt-run-detail' },
                    !record.ok
                      ? h(
                          Alert,
                          { kind: 'err', title: `${t('error.prefix')} ${record.errorCode ?? 'INTERNAL'}` },
                          h('div', null, record.errorMessage ?? t('state.failed')),
                          record.errorReason === undefined
                            ? null
                            : h('div', { className: 'dshgt-hint' }, reasonHint(t, record.errorReason) ?? ''),
                        )
                      : null,
                    h(
                      'div',
                      { className: 'dshgt-detail-grid' },
                      detailItem(t, 'run.usage.commit', record.commit === undefined ? '—' : h('span', { className: 'dshgt-mono' }, record.commit)),
                      detailItem(t, 'run.usage.hash', h('span', { className: 'dshgt-mono' }, shortHash(record.contentHash))),
                      detailItem(t, 'run.usage.branch', record.branch === undefined ? '—' : h('span', { className: 'dshgt-mono' }, record.branch)),
                      detailItem(t, 'runs.detail.coreModel', `${record.coreVersion || '—'} · ${record.model?.model ?? '—'}`),
                      detailItem(t, 'runs.detail.date', record.date ?? '—'),
                      detailItem(
                        t,
                        'run.usage.pr',
                        record.prUrl === undefined
                          ? '—'
                          : h(
                              'span',
                              { className: 'dshgt-inline' },
                              h('a', { href: record.prUrl, target: '_blank', rel: 'noreferrer', title: record.prUrl }, t('digest.openPr')),
                              pr === null ? null : h('span', { className: 'dshgt-tag' }, pr.label),
                            ),
                      ),
                      detailItem(t, 'runs.detail.warnings', record.warnings.length === 0 ? t('runs.detail.none') : record.warnings.join('；')),
                      detailItem(t, 'runs.detail.files', `${record.files} · ${duration(record.durationMs)}`),
                    ),
                    record.legacy === true ? h('div', { className: 'dshgt-hint' }, t('runs.legacyHint')) : null,
                    h(
                      'div',
                      { className: 'dshgt-run-actions' },
                      record.preview === undefined
                        ? h('span', { className: 'dshgt-hint' }, t('runs.detail.noPreview'))
                        : h(Btn, { small: true, onClick: () => props.onOpenDigest(record.date) }, t('runs.detail.readDigest')),
                      h(Btn, { small: true, onClick: () => setLogId(record.id) }, t('runs.detail.log')),
                      record.preview === undefined ? null : h('span', { className: 'dshgt-hint dshgt-mono' }, record.preview.file),
                    ),
                  )
                : null,
            );
          }),
        ),
    logId === null ? null : h(LogDrawer, { t, runId: logId, onClose: () => setLogId(null) }),
  );
}

function detailItem(t: Translate, label: string, value: any): any {
  return h(
    'div',
    { className: 'dshgt-detail-item' },
    h('div', { className: 'dshgt-detail-k' }, t(label)),
    h('div', { className: 'dshgt-detail-v' }, value),
  );
}
