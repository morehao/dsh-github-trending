/**
 * 日报预览：按「日榜 / 周榜 / 月榜」三个周期分别回看。
 *
 * 三个周期各有自己的时间线（日按天、周按 ISO 周、月按月），互不吞并。期数列表
 * 只来自 `/state` 的 history；正文只在记录带 `preview` 元数据时按需请求
 * `GET /preview?id=`。快速切换用 AbortController 取消上一个请求，避免旧响应覆盖
 * 新选择。没有预览时显示诚实空状态，不用示例内容兜底。
 */
import { Btn, copyText, h, React } from './ui.js';
import type { Translate } from './i18n.js';
import { getPreview, type DigestTarget, type Period, type PreviewPayload } from './api.js';
import type { StoreValue } from './store.js';
import {
  buildPeriodGroups,
  formatBucketLabel,
  formatBytes,
  type DigestStatus,
  type PeriodDay,
} from './digest-core.js';
import { renderMarkdown, type RenderedMarkdown } from './markdown.js';

export interface DigestProps {
  t: Translate;
  lang: 'zh' | 'en';
  store: StoreValue;
  selected?: DigestTarget;
  onSelect: (target: DigestTarget) => void;
  onOpenRuns: () => void;
}

const STATUS_TAG: Record<DigestStatus, string> = {
  preview: 'digest.tag.preview',
  failed: 'digest.tag.failed',
  skipped: 'digest.tag.skipped',
  dry: 'digest.tag.dry',
  legacy: 'digest.tag.legacy',
  missing: 'digest.tag.missing',
};

const STATUS_LABEL: Record<DigestStatus, string> = {
  preview: 'state.ok',
  failed: 'state.failed',
  skipped: 'state.skipped',
  dry: 'state.dry',
  legacy: 'digest.tag.legacy',
  missing: 'digest.tag.missing',
};

const STATUS_LAMP: Record<DigestStatus, string> = {
  preview: 'ok',
  failed: 'err',
  skipped: 'warn',
  dry: 'warn',
  legacy: 'warn',
  missing: 'warn',
};

const META_KEYS = ['date', 'period', 'languages', 'count', 'degraded', 'coreVersion', 'contentHash', 'generatedAt'];

function EmptyDigest(props: {
  t: Translate;
  lang: 'zh' | 'en';
  day: PeriodDay;
  nearest?: PeriodDay;
  error?: string;
  onOpenRuns: () => void;
  onSelect: (target: DigestTarget) => void;
}): any {
  const { t, lang, day, nearest } = props;
  const status: DigestStatus = props.error === undefined ? day.status : 'missing';
  return h(
    'div',
    { className: 'dshgt-digest-empty' },
    h(
      'div',
      { className: 'dshgt-status-line' },
      h('span', { className: `dshgt-lamp ${STATUS_LAMP[status]}` }),
      h('b', null, t(STATUS_LABEL[status])),
      h('span', { className: 'dshgt-dim' }, formatBucketLabel(day.period, day.bucket, lang)),
    ),
    h('h2', null, t(`digest.empty.${status}.title`)),
    h('p', null, t(`digest.empty.${status}.reason`)),
    day.record.errorCode === undefined && props.error === undefined
      ? null
      : h(
          'p',
          { className: 'dshgt-mono dshgt-digest-error' },
          [day.record.errorCode, day.record.errorMessage ?? props.error].filter((item) => item !== undefined && item !== '').join(' · '),
        ),
    h(
      'div',
      { className: 'dshgt-actions' },
      h(Btn, { small: true, onClick: props.onOpenRuns }, t('digest.empty.viewRuns')),
      nearest === undefined
        ? null
        : h(
            Btn,
            { small: true, onClick: () => props.onSelect({ period: nearest.period, bucket: nearest.bucket }) },
            t('digest.empty.latest', { date: formatBucketLabel(nearest.period, nearest.bucket, lang) }),
          ),
    ),
  );
}

export function DigestView(props: DigestProps): any {
  const { t, lang, store, selected } = props;
  const [mode, setMode] = React.useState<'render' | 'raw'>('render');
  const [payload, setPayload] = React.useState<PreviewPayload | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const state = store.state;
  const history = state?.status.history ?? [];
  const timeZone = state?.schedule.timezone ?? 'UTC';
  const groups = buildPeriodGroups(history, { timeZone });
  const groupMap = new Map(groups.map((group) => [group.period, group] as const));
  const activePeriod: Period = selected?.period ?? 'daily';
  const activeGroup = groupMap.get(activePeriod) ?? { period: activePeriod, days: [], previewCount: 0 };
  const days = activeGroup.days;
  // 打开时默认该周期最近一期「有预览」的期数；没有预览才回落到最近一条记录。
  const fallbackBucket = days.find((item) => item.status === 'preview')?.bucket ?? days[0]?.bucket;
  const requestedBucket = selected?.period === activePeriod ? selected.bucket : undefined;
  const effectiveBucket =
    requestedBucket !== undefined && days.some((day) => day.bucket === requestedBucket) ? requestedBucket : fallbackBucket;
  const day = days.find((item) => item.bucket === effectiveBucket);
  const index = day === undefined ? -1 : days.indexOf(day);
  const previewRunId =
    day !== undefined && day.status === 'preview' && day.record.preview !== undefined ? day.record.id : undefined;

  React.useEffect(() => {
    if (effectiveBucket === undefined) return;
    if (selected?.period !== activePeriod || selected?.bucket !== effectiveBucket) {
      props.onSelect({ period: activePeriod, bucket: effectiveBucket });
    }
  }, [activePeriod, effectiveBucket, selected?.period, selected?.bucket, props.onSelect]);

  React.useEffect(() => {
    setMode('render');
  }, [activePeriod, effectiveBucket]);

  React.useEffect(() => {
    if (previewRunId === undefined) {
      setPayload(null);
      setError(null);
      setLoading(false);
      return () => undefined;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setPayload(null);
    getPreview(previewRunId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setPayload(result);
        setLoading(false);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : String(failure));
        setLoading(false);
      });
    return () => controller.abort();
  }, [previewRunId]);

  if (state === null) {
    return h('div', { className: 'dshgt-empty' }, store.error ?? t('quickfill.loading'));
  }

  const nearest = day === undefined ? undefined : days.find((item) => item.status === 'preview' && item.bucket !== day.bucket);

  let rendered: RenderedMarkdown | null = null;
  let parseFailed = false;
  if (payload !== null) {
    try {
      rendered = renderMarkdown(payload.preview.text);
    } catch {
      parseFailed = true;
    }
  }

  const periodSeg = h(
    'div',
    { className: 'dshgt-period-seg', role: 'tablist', 'aria-label': t('digest.selectPeriod') },
    groups.map((group) => {
      const on = group.period === activePeriod;
      const firstBucket = group.days.find((item) => item.status === 'preview')?.bucket ?? group.days[0]?.bucket;
      return h(
        'button',
        {
          key: group.period,
          type: 'button',
          role: 'tab',
          'aria-selected': on ? 'true' : 'false',
          className: on ? 'on' : '',
          onClick: () => props.onSelect({ period: group.period, bucket: firstBucket ?? '' }),
        },
        h('span', null, t(`period.${group.period}`)),
        h('span', { className: 'dshgt-period-count' }, String(group.days.length)),
      );
    }),
  );

  const periodBar = h(
    'div',
    { className: 'dshgt-digest-subbar' },
    periodSeg,
    h(
      'span',
      { className: 'dshgt-dim' },
      days.length === 0
        ? t('digest.window.empty')
        : t('digest.window.period', { count: days.length, previews: activeGroup.previewCount }),
    ),
    h('span', { className: 'dshgt-grow' }),
    h(Btn, { small: true, onClick: props.onOpenRuns }, t('digest.allRuns')),
  );

  const bucketBar = h(
    'div',
    { className: 'dshgt-digest-subbar' },
    h(
      'div',
      { className: 'dshgt-datenav' },
      h(
        'button',
        {
          type: 'button',
          className: 'dshgt-icon-btn',
          'aria-label': t('digest.prev'),
          title: t('digest.prev'),
          disabled: index < 0 || index >= days.length - 1,
          onClick: () => {
            const target = days[index + 1];
            if (target !== undefined) props.onSelect({ period: activePeriod, bucket: target.bucket });
          },
        },
        '‹',
      ),
      h(
        'select',
        {
          className: 'dshgt-dateselect',
          'aria-label': t('digest.selectBucket'),
          value: effectiveBucket ?? '',
          onChange: (event: any) => props.onSelect({ period: activePeriod, bucket: event.target.value }),
          disabled: days.length === 0,
        },
        days.length === 0
          ? h('option', { value: '' }, t('digest.window.empty'))
          : days.map((item) =>
              h(
                'option',
                { key: item.bucket, value: item.bucket },
                `${formatBucketLabel(activePeriod, item.bucket, lang)} · ${t(STATUS_TAG[item.status])}`,
              ),
            ),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'dshgt-icon-btn',
          'aria-label': t('digest.next'),
          title: t('digest.next'),
          disabled: index <= 0,
          onClick: () => {
            const target = days[index - 1];
            if (target !== undefined) props.onSelect({ period: activePeriod, bucket: target.bucket });
          },
        },
        '›',
      ),
    ),
    h('span', { className: 'dshgt-dim' }, t('digest.bucketNavHint')),
  );

  if (day === undefined) {
    return h(
      'div',
      { className: 'dshgt-view dshgt-digest' },
      periodBar,
      bucketBar,
      h(
        'div',
        { className: 'dshgt-digest-empty' },
        h('h2', null, t('digest.empty.none.title')),
        h('p', null, t('digest.empty.none.reason')),
        h('div', { className: 'dshgt-actions' }, h(Btn, { small: true, onClick: props.onOpenRuns }, t('digest.empty.viewRuns'))),
      ),
    );
  }

  const showEmpty = day.status !== 'preview' || error !== null;
  const record = day.record;

  return h(
    'div',
    { className: 'dshgt-view dshgt-digest' },
    periodBar,
    bucketBar,
    h(
      'div',
      { className: 'dshgt-digest-sheet' },
      showEmpty
        ? h(EmptyDigest, {
            t,
            lang,
            day,
            ...(nearest === undefined ? {} : { nearest }),
            ...(error === null ? {} : { error }),
            onOpenRuns: props.onOpenRuns,
            onSelect: props.onSelect,
          })
        : h(
            'div',
            { className: 'dshgt-digest-body' },
            h(
              'div',
              { className: 'dshgt-digest-bar' },
              h('span', { className: `dshgt-pchip ${activePeriod}` }, t(`period.${activePeriod}`)),
              h(
                'span',
                { className: 'dshgt-filechip dshgt-filechip-static' },
                h('span', { className: 'dshgt-mono' }, record.preview?.file ?? '—'),
              ),
              h('span', { className: 'dshgt-dim' }, record.preview === undefined ? '—' : formatBytes(record.preview.bytes)),
              payload?.preview.truncated === true ? h('span', { className: 'dshgt-tag' }, t('digest.truncated')) : null,
              h('span', { className: 'dshgt-grow' }),
              h(
                'div',
                { className: 'dshgt-seg', role: 'group', 'aria-label': t('digest.mode') },
                h(
                  'button',
                  {
                    type: 'button',
                    'aria-pressed': mode === 'render' ? 'true' : 'false',
                    className: mode === 'render' ? 'on' : '',
                    onClick: () => setMode('render'),
                  },
                  t('digest.render'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    'aria-pressed': mode === 'raw' ? 'true' : 'false',
                    className: mode === 'raw' ? 'on' : '',
                    onClick: () => setMode('raw'),
                  },
                  t('digest.raw'),
                ),
              ),
              h(
                Btn,
                {
                  small: true,
                  onClick: () => {
                    const file = record.preview?.file;
                    if (file === undefined) return;
                    void copyText(file).then((okResult) => {
                      if (!okResult) return;
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1600);
                    });
                  },
                },
                copied ? t('digest.copied') : t('digest.copyPath'),
              ),
              record.prUrl === undefined
                ? null
                : h(
                    'a',
                    { className: 'dshgt-btn dshgt-btn-sm', href: record.prUrl, target: '_blank', rel: 'noreferrer' },
                    t('digest.openPr'),
                  ),
            ),
            loading || payload === null
              ? h('div', { className: 'dshgt-digest-loading' }, t('digest.loading'))
              : mode === 'raw' || parseFailed
                ? h('pre', { className: 'dshgt-digest-raw' }, payload.preview.text)
                : h(
                    'div',
                    { className: 'dshgt-digest-doc' },
                    rendered === null
                      ? null
                      : h(
                          React.Fragment,
                          null,
                          metaLine(rendered),
                          h('div', { className: 'dshgt-md' }, rendered.nodes),
                        ),
                  ),
          ),
    ),
  );
}

function metaLine(rendered: RenderedMarkdown): any {
  const entries = META_KEYS.filter((key) => rendered.meta[key] !== undefined && rendered.meta[key] !== '');
  if (entries.length === 0) return null;
  return h(
    'div',
    { className: 'dshgt-doc-meta' },
    entries.map((key) => {
      const value = rendered.meta[key] ?? '';
      if (key === 'contentHash') {
        const short = value.replace(/^sha256:/, '').slice(0, 10);
        return h('span', { key, title: value }, `${key}: ${short}`);
      }
      return h('span', { key }, `${key}: ${value}`);
    }),
  );
}
