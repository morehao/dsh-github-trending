/**
 * 概览：第一屏回答「下次什么时候跑 / 现在能不能跑 / 上次交付了什么」。
 *
 * 所有状态都来自 `/state`；运行中只显示开始时间、已用时与「核心执行中」，
 * 不伪造九步百分比。PR 不写「已合并」——state 无法区分 merged/closed。
 */
import { Btn, Pill, duration, h, localTime, shortHash } from './ui.js';
import type { Translate } from './i18n.js';
import type { RunRecord, StatePayload } from './api.js';
import type { StoreValue } from './store.js';
import { reasonHint } from './error-copy.js';
import type { RunController } from './run-controller.js';
import { LiveRun } from './live-run.js';
import { credentialView } from './credential.js';
import {
  buildDigestDates,
  formatDayLabel,
  recentDates,
  zonedDateString,
  type DigestDay,
  type DigestStatus,
} from './digest-core.js';

export interface OverviewProps {
  t: Translate;
  lang: 'zh' | 'en';
  store: StoreValue;
  controller: RunController;
  onOpenDigest: (date?: string) => void;
  onOpenRuns: () => void;
  onOpenSettings: () => void;
}

function statusPill(t: Translate, record: RunRecord): any {
  if (!record.ok) return h(Pill, { kind: 'err' }, t('state.failed'));
  if (record.skipped) return h(Pill, { kind: 'warn' }, t('state.skipped'));
  if (record.kind === 'dry-run') return h(Pill, { kind: 'warn' }, t('state.dry'));
  return h(Pill, { kind: 'ok' }, t('state.ok'));
}

const STATUS_LAMP: Record<DigestStatus, string> = {
  preview: 'ok',
  failed: 'err',
  skipped: 'warn',
  dry: 'warn',
  legacy: 'warn',
  missing: 'warn',
};

function dayLabel(t: Translate, day: DigestDay): string {
  switch (day.status) {
    case 'preview':
      return duration(day.record.durationMs);
    case 'failed':
      return t('state.failed');
    case 'skipped':
      return t('state.skipped');
    case 'dry':
      return t('state.dry');
    case 'legacy':
      return t('digest.tag.legacy');
    case 'missing':
      return t('digest.tag.missing');
  }
}

function prLabel(t: Translate, state: StatePayload, record: RunRecord | null): { label: string; url?: string; kind: 'warn' | 'ok' | 'idle' } | null {
  if (record === null || record.prUrl === undefined) {
    if (record !== null && record.ok && !record.skipped && record.kind !== 'dry-run' && state.settings.repo.commitMode === 'direct') {
      return { label: t('overview.last.direct'), kind: 'idle' };
    }
    return null;
  }
  const pending = state.status.pendingPr;
  const matches = pending !== null && pending.url === record.prUrl;
  if (matches && state.status.pendingPrState === 'unknown') {
    return { label: t('overview.last.prUnknown'), url: record.prUrl, kind: 'warn' };
  }
  if (matches) return { label: t('overview.last.prPending'), url: record.prUrl, kind: 'warn' };
  return { label: t('overview.last.prCreated'), url: record.prUrl, kind: 'ok' };
}

function readyRows(t: Translate, state: StatePayload): Array<{ ok: boolean; label: string; value: string; extra?: string }> {
  const core = state.core;
  const credential = credentialView(state.model, t);
  const repo = state.settings.repo;
  return [
    {
      ok: core.state === 'ready',
      label: t('overview.ready.core'),
      value: core.state === 'ready' ? `${core.version ?? '—'} · ${t('core.ready')}` : t(`core.${core.state}`),
      ...(core.ipcSchema === undefined ? {} : { extra: `ipc ${core.ipcSchema} · digest ${core.digestSchema ?? '—'}` }),
    },
    {
      ok: credential.ok,
      label: t('overview.ready.model'),
      value: `${state.settings.model.provider} / ${state.settings.model.model || '—'}`,
      extra: credential.label,
    },
    {
      ok: repo.path.trim() !== '',
      label: t('overview.ready.repo'),
      value: repo.path.trim() === '' ? t('repo.path.empty') : repo.path,
      extra: repo.commitMode === 'direct' ? t('repo.commitMode.direct') : t('repo.commitMode.branch'),
    },
    {
      ok: state.github.configured,
      label: t('overview.ready.github'),
      value: state.github.configured ? t('auth.configured') : t('auth.missing'),
      extra: `${state.github.authMode}${state.github.source === '' ? '' : ` · ${state.github.source}`}`,
    },
  ];
}

export function OverviewView(props: OverviewProps): any {
  const { t, lang, store, controller } = props;
  const state = store.state;
  if (state === null) {
    return h('div', { className: 'dshgt-empty' }, store.error ?? t('quickfill.loading'));
  }

  const last = state.status.lastResult ?? state.status.history[0] ?? null;
  const pr = prLabel(t, state, last);
  const rows = readyRows(t, state);
  const readyCount = rows.filter((row) => row.ok).length;
  const timeZone = state.schedule.timezone;
  const today = zonedDateString(new Date(), timeZone);
  const days = buildDigestDates(state.status.history, { timeZone });
  const byDate = new Map(days.map((day) => [day.date, day]));
  const week = recentDates(today, 7);

  return h(
    'div',
    { className: 'dshgt-view dshgt-overview' },
    controller.running ? h(LiveRun, { t, controller, startedAt: controller.startedAt }) : null,
    controller.error === null ? null : h('div', { className: 'dshgt-alert err' }, controller.error),

    last === null
      ? h(
          'section',
          { className: 'dshgt-delivery' },
          h('div', { className: 'dshgt-delivery-top' }, h('span', { className: 'dshgt-hint' }, t('overview.last.none'))),
        )
      : h(
          'section',
          { className: 'dshgt-delivery' },
          h(
            'div',
            { className: 'dshgt-delivery-top' },
            statusPill(t, last),
            h('span', { className: 'dshgt-hint' }, last.date ?? localTime(last.at)),
            h(
              'span',
              { className: 'dshgt-pill-mini' },
              `${t('overview.last.files', { count: last.files })} · ${duration(last.durationMs)}`,
            ),
            last.legacy === true ? h('span', { className: 'dshgt-tag' }, t('runs.legacy')) : null,
          ),
          h('h2', null, t('overview.last.digest', { date: last.date ?? localTime(last.at) })),
          h(
            'div',
            { className: 'dshgt-when' },
            last.branch === undefined ? null : h('span', null, `${t('run.usage.branch')} `, h('span', { className: 'dshgt-mono' }, last.branch)),
            last.commit === undefined ? null : h('span', null, `${t('run.usage.commit')} `, h('span', { className: 'dshgt-mono' }, last.commit)),
            pr === null
              ? null
              : pr.url === undefined
                ? h('span', { className: 'dshgt-hint' }, pr.label)
                : h('a', { href: pr.url, target: '_blank', rel: 'noreferrer' }, pr.label),
          ),
          last.ok
            ? null
            : h(
                'div',
                { className: 'dshgt-alert err dshgt-delivery-error' },
                h('b', null, `${t('error.prefix')} ${last.errorCode ?? 'INTERNAL'}`),
                h('div', null, last.errorMessage ?? t('state.failed')),
                last.errorReason === undefined
                  ? null
                  : h('div', { className: 'dshgt-hint' }, reasonHint(t, last.errorReason) ?? ''),
              ),
          h(
            'div',
            { className: 'dshgt-artifacts' },
            last.preview === undefined
              ? h('span', { className: 'dshgt-hint' }, t('overview.last.noPreview'))
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshgt-filechip',
                    onClick: () => props.onOpenDigest(last.date),
                  },
                  h('span', { className: 'dshgt-mono' }, last.preview.file),
                ),
            last.preview === undefined
              ? null
              : h(Btn, { small: true, onClick: () => props.onOpenDigest(last.date) }, t('overview.last.read')),
            pr === null || pr.url === undefined ? null : h(
              'a',
              { className: 'dshgt-btn dshgt-btn-sm', href: pr.url, target: '_blank', rel: 'noreferrer' },
              t('digest.openPr'),
            ),
          ),
          h(
            'div',
            { className: 'dshgt-facts' },
            h('div', { className: 'dshgt-fact' }, h('div', { className: 'dshgt-fact-k' }, t('run.usage.commit')), h('div', { className: 'dshgt-fact-v' }, last.commit === undefined ? '—' : last.commit)),
            h('div', { className: 'dshgt-fact' }, h('div', { className: 'dshgt-fact-k' }, t('run.usage.hash')), h('div', { className: 'dshgt-fact-v' }, shortHash(last.contentHash))),
            h('div', { className: 'dshgt-fact' }, h('div', { className: 'dshgt-fact-k' }, t('run.usage.core')), h('div', { className: 'dshgt-fact-v' }, last.coreVersion || '—')),
            h('div', { className: 'dshgt-fact' }, h('div', { className: 'dshgt-fact-k' }, t('overview.model')), h('div', { className: 'dshgt-fact-v' }, last.model?.model ?? '—')),
          ),
        ),

    h(
      'section',
      { className: 'dshgt-block' },
      h(
        'div',
        { className: 'dshgt-section-label' },
        t('overview.ready.title'),
        h('span', { className: 'dshgt-mono dshgt-section-tail' }, `${readyCount} / ${rows.length}`),
      ),
      h(
        'div',
        { className: 'dshgt-ready-list' },
        rows.map((row) =>
          h(
            'div',
            { className: 'dshgt-ready-row', key: row.label },
            h('span', { className: `dshgt-lamp ${row.ok ? 'ok' : 'warn'}` }),
            h('span', { className: 'dshgt-ready-label' }, row.label),
            h(
              'span',
              { className: 'dshgt-ready-value' },
              row.value,
              row.extra === undefined ? null : h('span', { className: 'dshgt-ready-extra' }, `· ${row.extra}`),
            ),
            h('button', { type: 'button', className: 'dshgt-linkbtn', onClick: props.onOpenSettings }, t('overview.ready.view')),
          ),
        ),
      ),
    ),

    h(
      'section',
      { className: 'dshgt-block' },
      h(
        'div',
        { className: 'dshgt-section-label' },
        t('overview.week.title'),
        h('button', { type: 'button', className: 'dshgt-linkbtn dshgt-section-tail', onClick: props.onOpenRuns }, t('overview.week.all')),
      ),
      h(
        'div',
        { className: 'dshgt-week' },
        week.map((date) => {
          const day = byDate.get(date);
          if (day === undefined) {
            const waiting = date === today && state.schedule.enabled;
            return h(
              'div',
              { className: 'dshgt-day', key: date },
              h('div', { className: 'dshgt-day-date' }, date.slice(5).replace('-', '/')),
              h('div', { className: 'dshgt-day-status' }, waiting ? t('overview.week.wait', { time: state.schedule.time }) : t('overview.week.none')),
            );
          }
          return h(
            'button',
            {
              type: 'button',
              className: 'dshgt-day dshgt-day-clickable',
              key: date,
              onClick: () => props.onOpenDigest(date),
              title: day.record.errorCode === undefined ? formatDayLabel(date, lang) : `${formatDayLabel(date, lang)} · ${day.record.errorCode}`,
            },
            h('div', { className: 'dshgt-day-date' }, date.slice(5).replace('-', '/')),
            h(
              'div',
              { className: 'dshgt-day-status' },
              h('span', { className: `dshgt-lamp ${STATUS_LAMP[day.status]}` }),
              dayLabel(t, day),
            ),
          );
        }),
      ),
    ),
  );
}
