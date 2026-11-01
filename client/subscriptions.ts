/**
 * 订阅页：命令栏 + 四列表格 + 批量选择 + 发版记录抽屉。
 *
 * 列表本身**不落 settings.json**，也不由插件直接写仓：全部经核心 `subscribe` IPC 读改
 * （add/remove 只写 `.git/pending`，随下次运行落盘并随产物提交）。
 *
 * 抽屉里的正文是数据仓 `releases/<owner>/<repo>-01.md` 的原文：面板只渲染、不改写、
 * 不二次总结——「看到的就是仓库里那份」是这一页的硬约束，所以这里既不做摘要也不
 * 重排段落，卷切换时按 `volume` 重新取一次，不缓存跨周内容。
 */
import { Alert, Btn, h, shortTime, React } from './ui.js';
import type { Translate } from './i18n.js';
import {
  getSubscriptionDoc,
  getSubscriptions,
  lastReleaseAtOf,
  postSubscriptions,
  releaseRunsOf,
  type SubscriptionDoc,
  type SubscriptionItem,
  type SubscriptionList,
  type SubscriptionStatus,
} from './api.js';
import { renderMarkdown } from './markdown.js';
import { addDays, zonedDateString } from './digest-core.js';
import type { StoreValue } from './store.js';

export interface SubscriptionsProps {
  t: Translate;
  /** 跳转到设置页「发版订阅」分区。 */
  onOpenSettings: () => void;
  /** `/state` 快照：meta 行要用调度与发版运行记录；缺省时只显示仓库数与「每周一次」。 */
  store?: StoreValue;
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const KNOWN_STATUSES: readonly SubscriptionStatus[] = ['baseline', 'ok', 'no_change', 'rate_limited', 'failed'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type SortKey = 'name' | 'tag' | 'summary';

interface SortState {
  key: SortKey;
  /** 1 = 升序，-1 = 降序。 */
  dir: 1 | -1;
}

/** 表格一行：`item` 缺省说明核心只回了仓库名（旧核心），此时其余列显示「—」。 */
interface RepoRow {
  name: string;
  item?: SubscriptionItem;
}

interface MetaInfo {
  cadence: string;
  next?: string;
  lastWeek?: string;
  lastCheck?: string;
}

function errorText(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/** `2026-10-25` → `10-25`；不是日期就原样返回。 */
function monthDay(value: string | undefined): string {
  if (value === undefined || value === '') return '—';
  return DATE_RE.test(value) ? value.slice(5) : value;
}

/** `08:00:00` → `08:00`。 */
function clock(value: string): string {
  return /^\d{2}:\d{2}/.test(value) ? value.slice(0, 5) : value;
}

function weekdayLabel(t: Translate, weekday: number): string {
  return weekday >= 1 && weekday <= 7 ? t(`weekday.${weekday}`) : String(weekday);
}

function toneOf(status: SubscriptionStatus | undefined): 'ok' | 'warn' | 'err' | 'idle' {
  if (status === 'ok') return 'ok';
  if (status === 'rate_limited') return 'warn';
  if (status === 'failed') return 'err';
  return 'idle';
}

/** 状态文案只认五种 wire 值；未知值（含没有 items 的旧核心）显示「—」。 */
function statusLabel(t: Translate, status: SubscriptionStatus | undefined): string {
  if (status === undefined) return '—';
  return KNOWN_STATUSES.includes(status) ? t(`subs.status.${status}`) : '—';
}

/** `repos` 是权威顺序；`items` 里多出来的仓库（不该出现）也补到末尾，宁可多一行也不吞数据。 */
function mergeRows(list: SubscriptionList | null): RepoRow[] {
  if (list === null) return [];
  const byName = new Map<string, SubscriptionItem>();
  for (const item of list.items) byName.set(item.fullName, item);
  const names: string[] = [...list.repos];
  for (const item of list.items) {
    if (!names.includes(item.fullName)) names.push(item.fullName);
  }
  return names.map((name) => {
    const item = byName.get(name);
    return item === undefined ? { name } : { name, item };
  });
}

function sortValue(row: RepoRow, key: SortKey): string {
  if (key === 'name') return row.name.toLowerCase();
  if (key === 'tag') return row.item?.latestTag ?? '';
  return row.item?.latestSummaryAt ?? '';
}

/** 缺值永远排在最后，同一列再按仓库名兜底，保证顺序稳定。 */
function sortRows(rows: RepoRow[], sort: SortState): RepoRow[] {
  return [...rows].sort((a, b) => {
    const av = sortValue(a, sort.key);
    const bv = sortValue(b, sort.key);
    if (av === bv) return a.name.localeCompare(b.name);
    if (av === '') return 1;
    if (bv === '') return -1;
    return (av < bv ? -1 : 1) * sort.dir;
  });
}

/** 命中片段高亮：只切文本、不拼 HTML，交给 React 转义。 */
function highlight(text: string, needle: string): any {
  if (needle === '') return text;
  const lower = text.toLowerCase();
  const parts: any[] = [];
  let index = 0;
  let found = lower.indexOf(needle);
  let key = 0;
  while (found >= 0) {
    if (found > index) parts.push(text.slice(index, found));
    parts.push(h('mark', { key: `m${key}` }, text.slice(found, found + needle.length)));
    key += 1;
    index = found + needle.length;
    found = lower.indexOf(needle, index);
  }
  if (index === 0) return text;
  if (index < text.length) parts.push(text.slice(index));
  return parts;
}

/** 某一日历日期所在 ISO 周的周一（纯 UTC 日历运算，避免 DST 把日期挪一天）。 */
function weekStart(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return date;
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const dayIndex = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - dayIndex);
  return value.toISOString().slice(0, 10);
}

/**
 * meta 行要的数据：仓库数之外的节奏、下次运行、上次发版检查、上周变化。
 *
 * 发版调度字段是这次新增的，Host 可能还没提供：优先读 `state.schedule.release*`，
 * 缺了就退回 `settings.releases.schedule`，再缺只写「每周一次」。
 * 「上周」只在上一 ISO 周确实有发版运行记录时才写，避免把三周前的数字说成上周。
 */
function metaOf(t: Translate, store: StoreValue | undefined): MetaInfo {
  const state = store?.state ?? null;
  const schedule = state?.schedule;
  const releaseSchedule = state?.settings?.releases?.schedule;

  const weekday = typeof schedule?.releaseWeekday === 'number' ? schedule.releaseWeekday : releaseSchedule?.weekday;
  const time = typeof schedule?.releaseTime === 'string' && schedule.releaseTime !== '' ? schedule.releaseTime : releaseSchedule?.time;
  const timezone =
    (typeof schedule?.releaseTimezone === 'string' && schedule.releaseTimezone !== '' ? schedule.releaseTimezone : releaseSchedule?.timezone) ??
    schedule?.timezone ??
    'Asia/Shanghai';

  const cadence =
    weekday === undefined || time === undefined || time === ''
      ? t('subs.meta.cadence')
      : t('subs.meta.cadence.full', { weekday: weekdayLabel(t, weekday), time: clock(time) });

  const nextAt = typeof schedule?.nextReleaseAt === 'string' && schedule.nextReleaseAt !== '' ? schedule.nextReleaseAt : undefined;
  const next = nextAt === undefined ? undefined : shortTime(nextAt);

  const runs = releaseRunsOf(state);
  const newest =
    runs.length === 0
      ? undefined
      : runs.reduce((a, b) => (Date.parse(b.finishedAt || b.startedAt) > Date.parse(a.finishedAt || a.startedAt) ? b : a));

  const lastCheckAt = newest?.finishedAt ?? lastReleaseAtOf(state);
  const lastCheck = typeof lastCheckAt === 'string' && lastCheckAt !== '' ? shortTime(lastCheckAt) : undefined;

  let lastWeek: string | undefined;
  if (newest !== undefined) {
    const today = zonedDateString(new Date(), timezone);
    const currentFrom = weekStart(today);
    const lastFrom = addDays(currentFrom, -7);
    const at = newest.finishedAt !== '' ? newest.finishedAt : newest.startedAt;
    const runDate = zonedDateString(new Date(at), timezone);
    // 只描述「上一次周检查真正覆盖到的那一周」：落在上周写「上周」，落在本周写「本周」，
    // 更早就不写——把三周前的数字说成「上周」比不显示更糟。
    if (runDate >= lastFrom && runDate <= addDays(lastFrom, 6)) {
      lastWeek = t('subs.meta.lastWeek', { from: monthDay(lastFrom), to: monthDay(addDays(lastFrom, 6)), changed: newest.changed });
    } else if (runDate >= currentFrom && runDate <= addDays(currentFrom, 6)) {
      lastWeek = t('subs.meta.thisWeek', { from: monthDay(currentFrom), to: monthDay(addDays(currentFrom, 6)), changed: newest.changed });
    }
  }

  const info: MetaInfo = { cadence };
  if (next !== undefined) info.next = next;
  if (lastWeek !== undefined) info.lastWeek = lastWeek;
  if (lastCheck !== undefined) info.lastCheck = lastCheck;
  return info;
}

/**
 * 抽屉错误 → 空态：核心对「还没生成过文档」是当作业务错误报出来的
 * （`repo "o/r" has no release document yet`，HTTP 侧包成 SUBSCRIBE_FAILED），
 * 这不是故障，不该用红色错误条吓用户。
 */
function isMissingDoc(code: string | undefined, message: string): boolean {
  if (code !== undefined && /NOT_?FOUND|MISSING|NO_?DOC/i.test(code)) return true;
  return /not\s*found|no such file|enoent|404|不存在|no release document|has no release|无发版记录/i.test(message);
}

/**
 * 数据仓里的文件路径。优先用核心返回的卷索引（`volumes[].file` 是权威值，
 * 命名规则变了面板也不用跟着改），拿不到时按 `<repo>-0N.md` 兜底——每册都带
 * 两位序号，第 1 册也是 `-01`。
 */
function docPath(repo: string, volume: number, volumes?: SubscriptionDoc['volumes']): string {
  const entry = volumes?.find((item) => item.index === volume);
  if (entry !== undefined && entry.file !== '') return `releases/${entry.file}`;
  return `releases/${repo}-${String(volume).padStart(2, '0')}.md`;
}

interface DocDrawerProps {
  t: Translate;
  repo: string;
  status?: SubscriptionStatus;
  onClose: () => void;
}

/** 右侧 460 px 抽屉：仓库名 + 文档原文 + 卷切换 + 写入位置说明。 */
function DocDrawer(props: DocDrawerProps): any {
  const { t, repo } = props;
  const [volume, setVolume] = React.useState<number | undefined>(undefined);
  const [doc, setDoc] = React.useState<SubscriptionDoc | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [missing, setMissing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const closeRef = React.useRef<any>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setMissing(false);
    getSubscriptionDoc(repo, volume, controller.signal)
      .then((payload) => {
        if (controller.signal.aborted) return;
        setDoc(payload);
        setMissing(payload.markdown.trim() === '');
        setLoading(false);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        const message = errorText(failure);
        const code = (failure as { code?: string }).code;
        if (isMissingDoc(code, message)) setMissing(true);
        else setError(message);
        setLoading(false);
      });
    return () => controller.abort();
  }, [repo, volume, attempt]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props]);

  React.useEffect(() => {
    closeRef.current?.focus?.();
  }, []);

  const total = doc?.volumes !== undefined && doc.volumes.length > 0 ? doc.volumes.length : 1;
  const current = doc?.volume ?? volume ?? 1;
  const stale = props.status === 'rate_limited' || props.status === 'failed';

  let nodes: any[] | null = null;
  let parseFailed = false;
  if (doc !== null && !missing && error === null) {
    try {
      nodes = renderMarkdown(doc.markdown).nodes;
    } catch {
      parseFailed = true;
    }
  }

  const content = loading
    ? h('p', { className: 'dshgt-hint' }, t('subs.drawer.loading'))
    : missing
      ? h('div', { className: 'dshgt-subs-empty' }, h('span', null, t('subs.drawer.empty')))
      : error !== null
        ? h(
            Alert,
            { kind: 'err', title: t('subs.drawer.title', { repo }) },
            h('div', null, error),
            h('div', { style: { marginTop: 8 } }, h(Btn, { small: true, onClick: () => setAttempt((current) => current + 1) }, t('subs.drawer.retry'))),
          )
        : parseFailed || nodes === null
          ? h('pre', { className: 'dshgt-subs-drawer-raw' }, doc?.markdown ?? '')
          : h('div', { className: 'dshgt-md' }, nodes);

  return h(
    'div',
    {
      className: 'dshgt-subs-drawer-mask',
      onClick: (event: any) => {
        if (event.target === event.currentTarget) props.onClose();
      },
    },
    h(
      'aside',
      { className: 'dshgt-subs-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('subs.drawer.title', { repo }) },
      h(
        'header',
        { className: 'dshgt-subs-drawer-head' },
        h(
          'div',
          { className: 'dshgt-subs-drawer-main' },
          h('div', { className: 'dshgt-subs-drawer-repo' }, repo),
          doc === null
            ? null
            : h(
                'div',
                { className: 'dshgt-subs-drawer-sub' },
                doc.updatedAt === undefined ? t('subs.drawer.volume', { index: current, total }) : t('subs.drawer.updated', { date: doc.updatedAt }),
              ),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dshgt-subs-drawer-close',
            'aria-label': t('subs.drawer.close'),
            title: t('subs.drawer.close'),
            ref: closeRef,
            onClick: () => props.onClose(),
          },
          '×',
        ),
      ),
      h(
        'div',
        { className: 'dshgt-subs-drawer-body' },
        stale ? h(Alert, { kind: 'warn' }, t(`subs.drawer.warn.${props.status ?? 'failed'}`)) : null,
        total > 1
          ? h(
              'div',
              { className: 'dshgt-subs-vol' },
              h('span', { className: 'label' }, t('subs.drawer.volume', { index: current, total })),
              h(
                Btn,
                {
                  small: true,
                  disabled: loading || current <= 1,
                  title: t('subs.drawer.prevVolume'),
                  onClick: () => setVolume(current - 1),
                },
                t('subs.drawer.prevVolume'),
              ),
              h(
                Btn,
                {
                  small: true,
                  disabled: loading || current >= total,
                  title: t('subs.drawer.nextVolume'),
                  onClick: () => setVolume(current + 1),
                },
                t('subs.drawer.nextVolume'),
              ),
            )
          : null,
        content,
        loading
          ? null
          : h(
              'div',
              { className: 'dshgt-subs-drawer-note' },
              t('subs.drawer.note', { path: docPath(repo, current, doc?.volumes) }),
            ),
      ),
    ),
  );
}

export function SubscriptionsView(props: SubscriptionsProps): any {
  const { t } = props;
  const [list, setList] = React.useState<SubscriptionList | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [sort, setSort] = React.useState<SortState>({ key: 'name', dir: 1 });
  const [selecting, setSelecting] = React.useState(false);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [confirming, setConfirming] = React.useState<string[] | null>(null);
  const [openRepo, setOpenRepo] = React.useState<string | null>(null);
  const [focus, setFocus] = React.useState(-1);

  const load = React.useCallback((signal?: AbortSignal): void => {
    getSubscriptions(signal)
      .then((next) => {
        if (signal?.aborted === true) return;
        setList(next);
        setError(null);
      })
      .catch((failure: unknown) => {
        if (signal?.aborted === true) return;
        setError(errorText(failure));
        setList({ repos: [], items: [] });
      });
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // 命令栏里写着 ⌘K，就真的给一个：否则这行提示只是装饰。
  const inputRef = React.useRef<any>(null);
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      inputRef.current?.focus?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const rows = mergeRows(list);
  const needle = query.trim().toLowerCase();
  const matched = needle === '' ? rows : rows.filter((row) => row.name.toLowerCase().includes(needle));
  const sorted = sortRows(matched, sort);

  const candidate = needle !== '' && REPO_PATTERN.test(query.trim()) ? query.trim() : undefined;
  const subscribed = candidate !== undefined && rows.some((row) => row.name.toLowerCase() === candidate.toLowerCase());
  const activeFocus = focus >= 0 && focus < sorted.length ? focus : -1;

  const toggleSelect = (repo: string): void => {
    setSelected((current) => (current.includes(repo) ? current.filter((item) => item !== repo) : [...current, repo]));
  };

  const addRepo = (repo: string): void => {
    setBusy('add');
    setError(null);
    setNote(null);
    postSubscriptions('add', [repo])
      .then((next) => {
        setList(next);
        setQuery('');
        setFocus(-1);
        setNote(t('subs.add.queued', { repo }));
      })
      .catch((failure: unknown) => setError(errorText(failure)))
      .finally(() => setBusy(null));
  };

  const removeOne = (repo: string): void => {
    setBusy(`remove:${repo}`);
    setError(null);
    setNote(null);
    postSubscriptions('remove', [repo])
      .then((next) => {
        setList(next);
        setSelected((current) => current.filter((item) => item !== repo));
        setNote(t('subs.remove.queued', { repo }));
      })
      .catch((failure: unknown) => setError(errorText(failure)))
      .finally(() => setBusy(null));
  };

  // 批量移除：一次 POST 带上全部仓库（Host 侧逐个执行，任一失败如实回错）。
  const removeMany = (repos: string[]): void => {
    setBusy('remove:many');
    setError(null);
    setNote(null);
    postSubscriptions('remove', repos)
      .then((next) => {
        setList(next);
        setSelected([]);
        setSelecting(false);
        setConfirming(null);
        setNote(t('subs.removed.many', { count: repos.length }));
      })
      .catch((failure: unknown) => {
        setError(errorText(failure));
        setConfirming(null);
      })
      .finally(() => setBusy(null));
  };

  const onSort = (key: SortKey): void => {
    setSort((current) => (current.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  };

  const header = (key: SortKey, labelKey: string, right: boolean): any => {
    const active = sort.key === key;
    return h(
      'button',
      {
        key,
        type: 'button',
        role: 'columnheader',
        className: `dshgt-subs-th dshgt-subs-th-${key}${right ? ' right' : ''}`,
        'aria-sort': active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none',
        'aria-label': t('subs.sort.by', { column: t(labelKey) }),
        onClick: () => onSort(key),
      },
      t(labelKey),
      active ? h('span', { className: 'dshgt-subs-ord' }, sort.dir === 1 ? '▲' : '▼') : null,
    );
  };

  const onCommandKey = (event: any): void => {
    // 中文输入法组字时的 Enter / 方向键属于输入法，不该触发添加或移动。
    if (event.isComposing === true) return;
    if (event.key === 'Escape') {
      setQuery('');
      setFocus(-1);
      if (selecting) {
        setSelecting(false);
        setSelected([]);
      }
      return;
    }
    if (event.key === 'Enter') {
      if (candidate !== undefined && !subscribed) {
        event.preventDefault();
        addRepo(candidate);
        return;
      }
      if (activeFocus >= 0) {
        event.preventDefault();
        setOpenRepo(sorted[activeFocus]?.name ?? null);
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setFocus(Math.min(sorted.length - 1, focus + 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setFocus(Math.max(-1, focus - 1));
    }
  };

  const meta = metaOf(t, props.store);
  const metaRight =
    needle !== ''
      ? [t('subs.meta.match', { matched: sorted.length, total: rows.length })]
      : [
          meta.lastCheck === undefined ? undefined : t('subs.meta.lastCheck', { time: meta.lastCheck }),
          meta.lastWeek,
        ].filter((item): item is string => item !== undefined);
  const drawerRow = openRepo === null ? undefined : rows.find((row) => row.name === openRepo);

  const rowNodes = sorted.map((row, index) => {
    const item = row.item;
    const tone = toneOf(item?.status);
    const checkbox = selecting
      ? h(
          'span',
          { key: 'cb', role: 'cell', className: 'dshgt-subs-cbwrap' },
          h('input', {
            type: 'checkbox',
            className: 'dshgt-subs-cb',
            checked: selected.includes(row.name),
            'aria-label': t('subs.sel.check', { repo: row.name }),
            onClick: (event: any) => event.stopPropagation(),
            onChange: () => toggleSelect(row.name),
          }),
        )
      : null;
    return h(
      'div',
      {
        key: row.name,
        role: 'row',
        className: `dshgt-subs-row${index === activeFocus ? ' is-focus' : ''}`,
        onClick: () => {
          if (selecting) toggleSelect(row.name);
          else setOpenRepo(row.name);
        },
      },
      checkbox,
      h('span', { key: 'name', role: 'cell', className: 'dshgt-subs-ident', title: row.name }, highlight(row.name, needle)),
      h('span', { key: 'tag', role: 'cell', className: 'dshgt-subs-ver', title: item?.latestTag ?? '' }, item?.latestTag ?? '—'),
      h(
        'span',
        { key: 'sum', role: 'cell', className: 'dshgt-subs-sum', title: item?.latestSummaryAt ?? '' },
        monthDay(item?.latestSummaryAt),
      ),
      h(
        'span',
        { key: 'status', role: 'cell', className: `dshgt-subs-stat ${tone}` },
        h('span', { className: `dshgt-dot ${tone}` }),
        statusLabel(t, item?.status),
      ),
      h(
        'span',
        { key: 'act', role: 'cell', className: 'dshgt-subs-actions' },
        h(
          'button',
          {
            type: 'button',
            className: 'dshgt-subs-act',
            'aria-label': t('subs.row.changesRepo', { repo: row.name }),
            onClick: (event: any) => {
              event.stopPropagation();
              setOpenRepo(row.name);
            },
          },
          t('subs.row.changes'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dshgt-subs-act rm',
            'aria-label': t('subs.row.removeRepo', { repo: row.name }),
            disabled: busy !== null,
            onClick: (event: any) => {
              event.stopPropagation();
              removeOne(row.name);
            },
          },
          busy === `remove:${row.name}` ? t('subs.removing') : t('subs.remove'),
        ),
      ),
    );
  });

  const tableBody =
    list === null
      ? h('p', { className: 'dshgt-hint' }, t('subs.loading'))
      : rows.length === 0
        ? h(
            'div',
            { className: 'dshgt-subs-empty' },
            h('b', null, t('subs.empty')),
            h('span', null, t('subs.empty.hint')),
          )
        : sorted.length === 0
          ? candidate !== undefined && !subscribed
            ? // 输入完整 owner/repo 时上方已给出「+ 添加」建议，这里不再叠一句「没有匹配」。
              null
            : h(
                'div',
                { className: 'dshgt-subs-empty' },
                h('b', null, t('subs.empty.match')),
                h('span', null, t('subs.empty.match.hint')),
                h(Btn, { small: true, onClick: () => setQuery('') }, t('subs.empty.clear')),
              )
          : h(
              'div',
              { className: `dshgt-subs-table${selecting ? ' is-selecting' : ''}`, role: 'table', 'aria-label': t('subs.title') },
              h(
                'div',
                { className: 'dshgt-subs-thead', role: 'row' },
                selecting
                  ? h('span', { key: 'cb', role: 'columnheader', className: 'dshgt-subs-cbwrap' }, h('span', { className: 'dshgt-hint' }, t('subs.sel.column')))
                  : null,
                header('name', 'subs.col.repo', false),
                header('tag', 'subs.col.tag', true),
                header('summary', 'subs.col.summary', true),
                h('span', { key: 'status', role: 'columnheader', className: 'dshgt-subs-stat' }, t('subs.col.status')),
                h('span', { key: 'act', role: 'columnheader', className: 'dshgt-subs-actions', 'aria-label': t('subs.col.actions') }),
              ),
              h('div', { role: 'rowgroup' }, rowNodes),
            );

  return h(
    'div',
    { className: 'dshgt-view dshgt-subs' },
    h(
      'section',
      { className: 'dshgt-subs-head' },
      h(
        'div',
        { className: 'dshgt-subs-head-main' },
        h('h2', null, t('subs.title')),
        h('p', { className: 'dshgt-subs-dek' }, t('subs.desc')),
      ),
      h(
        'div',
        { className: 'dshgt-subs-head-actions' },
        h(
          Btn,
          {
            small: true,
            onClick: () => {
              if (selecting) setSelected([]);
              setSelecting(!selecting);
            },
          },
          selecting ? t('subs.select.done') : t('subs.select'),
        ),
      ),
    ),

    h(
      'div',
      { className: 'dshgt-subs-cmdwrap' },
      h(
        'div',
        { className: 'dshgt-subs-cmd' },
        h('input', {
          type: 'text',
          ref: inputRef,
          value: query,
          placeholder: t('subs.cmd.placeholder'),
          'aria-label': t('subs.cmd.label'),
          'aria-keyshortcuts': 'Meta+K Control+K',
          autoComplete: 'off',
          spellCheck: false,
          onInput: (event: any) => {
            setQuery(event.target.value);
            setFocus(-1);
          },
          onKeyDown: onCommandKey,
        }),
        h('kbd', { className: 'dshgt-subs-kbd' }, '⌘K'),
      ),
      h(
        'div',
        { className: 'dshgt-subs-meta' },
        h(
          'span',
          null,
          t('subs.meta.count', { count: rows.length }),
          ' · ',
          h(
            'button',
            { type: 'button', className: 'dshgt-subs-linkbtn', title: t('subs.param.link'), onClick: () => props.onOpenSettings() },
            meta.cadence,
          ),
          meta.next === undefined ? null : ` · ${t('subs.meta.next', { time: meta.next })}`,
        ),
        metaRight.length === 0
          ? null
          : h(
              'span',
              { className: 'dshgt-subs-meta-right' },
              metaRight.flatMap((part, index) => (index === 0 ? [part] : [h('span', { key: `sep${index}`, className: 'dshgt-subs-meta-sep' }, '·'), part])),
            ),
      ),
    ),

    candidate === undefined
      ? null
      : h(
          'div',
          { className: 'dshgt-subs-suggest' },
          subscribed
            ? [
                h('span', { key: 'pill', className: 'dshgt-tag' }, t('subs.cmd.subscribed')),
                h('span', { key: 'repo', className: 'repo' }, candidate),
                h('span', { key: 'hint', className: 'hint' }, t('subs.cmd.subscribed.hint')),
              ]
            : [
                h('span', { key: 'plus', className: 'plus' }, '+'),
                h('span', { key: 'add' }, t('subs.cmd.add')),
                h('span', { key: 'repo', className: 'repo' }, candidate),
                h('span', { key: 'hint', className: 'hint' }, t('subs.cmd.add.hint')),
              ],
        ),

    error === null ? null : h(Alert, { kind: 'err' }, error),
    note === null ? null : h(Alert, { kind: 'ok' }, note),

    tableBody,

    h(
      'div',
      { className: 'dshgt-subs-keys' },
      h('span', null, t('subs.keys.move')),
      h('span', null, t('subs.keys.enter')),
      h('span', null, t('subs.keys.esc')),
      h('span', null, t('subs.keys.sort')),
    ),

    selecting && rows.length > 0
      ? h(
          'div',
          { className: 'dshgt-subs-selbar' },
          h('span', null, t('subs.sel.count', { count: selected.length })),
          h(
            'button',
            {
              type: 'button',
              className: 'dshgt-subs-linkbtn',
              onClick: () => setSelected(sorted.map((row) => row.name)),
            },
            t('subs.sel.all', { count: sorted.length }),
          ),
          h(
            'span',
            { className: 'dshgt-subs-selbar-actions' },
            h(
              Btn,
              {
                small: true,
                onClick: () => {
                  setSelected([]);
                  setSelecting(false);
                },
              },
              t('subs.sel.clear'),
            ),
            h(
              Btn,
              { small: true, variant: 'danger', disabled: busy !== null || selected.length === 0, onClick: () => setConfirming(selected) },
              t('subs.sel.remove'),
            ),
          ),
        )
      : null,

    confirming === null
      ? null
      : h(
          'div',
          {
            className: 'dshgt-modal-mask',
            onClick: (event: any) => {
              if (event.target === event.currentTarget) setConfirming(null);
            },
          },
          h(
            'div',
            { className: 'dshgt-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('subs.confirm.title', { count: confirming.length }) },
            h('h3', { style: { margin: 0, fontSize: 14 } }, t('subs.confirm.title', { count: confirming.length })),
            h(
              'ul',
              { className: 'dshgt-subs-confirm-list' },
              confirming.slice(0, 6).map((repo) => h('li', { key: repo }, repo)),
            ),
            confirming.length > 6 ? h('p', { className: 'dshgt-hint', style: { margin: 0 } }, t('subs.confirm.more', { count: confirming.length - 6 })) : null,
            h('p', { className: 'dshgt-hint', style: { margin: 0 } }, t('subs.confirm.body')),
            h(
              'div',
              { className: 'dshgt-footer', style: { justifyContent: 'flex-end' } },
              h(Btn, { small: true, onClick: () => setConfirming(null) }, t('subs.confirm.cancel')),
              h(
                Btn,
                { small: true, variant: 'danger', disabled: busy !== null, onClick: () => removeMany(confirming) },
                t('subs.confirm.ok'),
              ),
            ),
          ),
        ),

    openRepo === null
      ? null
      : h(DocDrawer, {
          key: openRepo,
          t,
          repo: openRepo,
          ...(drawerRow?.item?.status === undefined ? {} : { status: drawerRow.item.status }),
          onClose: () => setOpenRepo(null),
        }),
  );
}
