/**
 * 订阅页：一个列表 + 列表上方工具条（搜索 / 添加仓库 / 选择 / 生成变更分析）+ 发版记录抽屉。
 *
 * 列表本身**不落 settings.json**，也不由插件直接写仓：全部经核心 `subscribe` IPC 读改
 * （add/remove 只写 `.git/pending`，随下次运行落盘并随产物提交）。
 *
 * 「生成变更分析」走 `POST /releases/run`：不给 repo = 跑全部订阅；给了 repo = 单仓分析。
 * 两者共用后端同一把运行锁，同一时刻最多一个发版运行（并发由后端拒绝）。
 *
 * 抽屉里的正文是数据仓 `releases/<owner>/<repo>-01.md` 的原文：面板只渲染、不改写、
 * 不二次总结——「看到的就是仓库里那份」是这一页的硬约束，所以这里既不做摘要也不
 * 重排段落，卷切换时按 `volume` 重新取一次，不缓存跨周内容。
 */
import { Alert, Btn, h, React } from './ui.js';
import type { Translate } from './i18n.js';
import {
  getSubscriptionDoc,
  getSubscriptions,
  postReleasesRun,
  postSubscriptions,
  type SubscriptionDoc,
  type SubscriptionItem,
  type SubscriptionList,
  type SubscriptionStatus,
} from './api.js';
import { renderMarkdown } from './markdown.js';
import type { StoreValue } from './store.js';

export interface SubscriptionsProps {
  t: Translate;
  /** 跳转到设置页「发版订阅」分区。 */
  onOpenSettings: () => void;
  /** `/state` 快照（当前仅用于空态提示，可缺省）。 */
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

function errorText(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * 单仓分析「还没纳入/没有记录」是业务前置条件不满足，不是故障：
 * 核心会报 `repo "o/r" is not in the subscription list` 或 `has no release document yet`。
 * 这类错误翻成一句人话，避免把裸核心错误糊到用户脸上。
 */
function isNotReadyMessage(message: string): boolean {
  return /is not in the subscription list|has no release document|no release record|not subscribed/i.test(message);
}

/** `2026-10-25` → `10-25`；不是日期就原样返回。 */
function monthDay(value: string | undefined): string {
  if (value === undefined || value === '') return '—';
  return DATE_RE.test(value) ? value.slice(5) : value;
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
  // 契约里 items 可选（旧核心只回 repos）；归一化后一般都有，这里再兜一次。
  const items = list.items ?? [];
  for (const item of items) byName.set(item.fullName, item);
  const names: string[] = [...list.repos];
  for (const item of items) {
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
          ? h('div', { className: 'dshgt-subs-drawer-doc' }, h('pre', { className: 'dshgt-subs-drawer-raw' }, doc?.markdown ?? ''))
          : h('div', { className: 'dshgt-subs-drawer-doc' }, h('div', { className: 'dshgt-md' }, nodes));

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

/** 一次分析完成后的瞬时结果提示（顶部横幅或行内 flash）。 */
interface AnalyzeResult {
  scope: 'all' | 'one';
  repo?: string;
  ok: boolean;
  /** 核心判定 skipped（无订阅 / 内容无变化）：不生成新分析，但也不是失败。 */
  skipped: boolean;
  changed: number;
  /** 本轮实际检查的仓库数（用于 skipped 时区分「没订阅」和「都无变化」）。 */
  checked: number;
  /** 该周期分支上解析到的订阅仓库总数（缺省表示旧核心/旧记录未提供）。 */
  subscribed?: number;
  /** 本次运行的目标分支（用于「没有订阅列表」提示里指路）。 */
  branch?: string;
  message?: string;
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
  const [addOpen, setAddOpen] = React.useState(false);
  const [addValue, setAddValue] = React.useState('');
  // 添加弹窗内的错误：模态遮住了页面级 error 条，失败原因要就地显示在弹窗里。
  const [addError, setAddError] = React.useState<string | null>(null);
  // 发版分析：全局或单仓，任一进行中时其余触发都禁用（后端同一把运行锁）。
  const [analyzing, setAnalyzing] = React.useState<null | { scope: 'all' | 'one'; repo?: string }>(null);
  const [result, setResult] = React.useState<AnalyzeResult | null>(null);

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

  const rows = mergeRows(list);
  const needle = query.trim().toLowerCase();
  const matched = needle === '' ? rows : rows.filter((row) => row.name.toLowerCase().includes(needle));
  const sorted = sortRows(matched, sort);

  const toggleSelect = (repo: string): void => {
    setSelected((current) => (current.includes(repo) ? current.filter((item) => item !== repo) : [...current, repo]));
  };

  const addRepo = (repo: string): void => {
    setBusy('add');
    setError(null);
    setNote(null);
    setAddError(null);
    postSubscriptions('add', [repo])
      .then((next) => {
        setList(next);
        setAddValue('');
        setAddOpen(false);
        setNote(t('subs.add.queued', { repo }));
      })
      .catch((failure: unknown) => setAddError(errorText(failure)))
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

  // 生成变更分析：scope=all 跑全部；scope=one 只跑该仓库。完成后刷新列表并给出结果提示。
  const runAnalyze = (repo?: string): void => {
    if (analyzing !== null) return;
    setAnalyzing(repo === undefined ? { scope: 'all' } : { scope: 'one', repo });
    setError(null);
    setResult(null);
    postReleasesRun(repo)
      .then((record) => {
        const scope = repo === undefined ? 'all' : 'one';
        setResult({
          scope,
          ...(repo === undefined ? {} : { repo }),
          ok: record.status !== 'failed',
          skipped: record.status === 'skipped',
          changed: record.changed,
          checked: record.checked,
          ...(record.subscribed === undefined ? {} : { subscribed: record.subscribed }),
          ...(record.branch === undefined ? {} : { branch: record.branch }),
        });
        if (record.status === 'failed' && record.errorMessage !== undefined) {
          const notReady = isNotReadyMessage(record.errorMessage);
          setError(notReady ? t('subs.row.triggerFresh') : t('subs.analyze.failed', { message: record.errorMessage }));
        }
        load();
      })
      .catch((failure: unknown) => {
        const message = errorText(failure);
        setError(isNotReadyMessage(message) ? t('subs.row.triggerFresh') : message);
        setResult({ scope: repo === undefined ? 'all' : 'one', ...(repo === undefined ? {} : { repo }), ok: false, skipped: false, changed: 0, checked: 0 });
      })
      .finally(() => setAnalyzing(null));
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

  const canAdd = REPO_PATTERN.test(addValue.trim());
  const alreadySubscribed = canAdd && rows.some((row) => row.name.toLowerCase() === addValue.trim().toLowerCase());
  const drawerRow = openRepo === null ? undefined : rows.find((row) => row.name === openRepo);
  const globalBusy = analyzing !== null;

  const banner =
    result === null
      ? null
      : !result.ok
        ? null
        : result.skipped
          ? h(
              Alert,
              { kind: 'warn' },
              // subscribed === 0 ⇒ 周期分支上根本没有订阅列表（最坑的「不知道发生了什么」场景）；
              // 否则才是「有订阅但都没变化」。
              result.subscribed === 0
                ? result.scope === 'all'
                  ? t('subs.analyze.noSubs', { branch: result.branch ?? '' })
                  : t('subs.analyze.noSubsOne')
                : result.scope === 'all'
                  ? t('subs.analyze.skipped')
                  : t('subs.analyze.skippedOne', { repo: result.repo ?? '' }),
            )
          : h(
              Alert,
              { kind: 'ok' },
              result.scope === 'all'
                ? t('subs.analyze.done', { count: result.changed })
                : t('subs.analyze.doneOne', { repo: result.repo ?? '' }),
            );

  const rowNodes = sorted.map((row) => {
    const item = row.item;
    const tone = toneOf(item?.status);
    const rowAnalyzing = analyzing !== null && analyzing.scope === 'one' && analyzing.repo === row.name;
    // baseline ＝ 从未跑过发版检查（新加 / 待首次分析）：单仓触发必被核心拒绝
    // （--stages releases 不合并 pending），因此禁用按钮并给提示，不放必败请求。
    const fresh = item?.status === 'baseline';
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
        className: `dshgt-subs-row${rowAnalyzing ? ' is-analyzing' : ''}`,
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
        rowAnalyzing
          ? h('span', { className: 'dshgt-subs-rowbusy' }, h('span', { className: 'dshgt-spin' }), t('subs.analyzing'))
          : h(
              'button',
              {
                type: 'button',
                className: 'dshgt-subs-act gen',
                'aria-label': fresh ? t('subs.row.triggerFresh') : t('subs.row.triggerRepo', { repo: row.name }),
                title: fresh ? t('subs.row.triggerFresh') : t('subs.row.triggerRepo', { repo: row.name }),
                disabled: globalBusy || busy !== null || fresh,
                onClick: (event: any) => {
                  event.stopPropagation();
                  if (!fresh) runAnalyze(row.name);
                },
              },
              t('subs.row.trigger'),
            ),
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
          ? h(
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
    // 工具条：搜索 + 添加 + 选择 + 生成变更分析（主操作）
    h(
      'div',
      { className: 'dshgt-subs-toolbar' },
      h(
        'div',
        { className: 'dshgt-subs-search' },
        h(
          'svg',
          { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'aria-hidden': 'true' },
          h('circle', { cx: 11, cy: 11, r: 7 }),
          h('path', { d: 'm20 20-3.5-3.5' }),
        ),
        h('input', {
          type: 'text',
          value: query,
          placeholder: t('subs.search.placeholder'),
          'aria-label': t('subs.search.label'),
          autoComplete: 'off',
          spellCheck: false,
          onInput: (event: any) => setQuery(event.target.value),
        }),
      ),
      h('div', { className: 'dshgt-subs-toolbar-spacer' }),
      h(
        Btn,
        {
          small: true,
          disabled: busy !== null,
          onClick: () => {
            setAddOpen(true);
            setAddValue('');
            setAddError(null);
          },
        },
        t('subs.toolbar.add'),
      ),
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
      h(
        Btn,
        {
          small: true,
          variant: 'primary',
          disabled: globalBusy || busy !== null,
          onClick: () => runAnalyze(),
        },
        analyzing !== null && analyzing.scope === 'all' ? t('subs.analyzing') : t('subs.toolbar.analyze'),
      ),
    ),

    banner,
    error === null ? null : h(Alert, { kind: 'err' }, error),
    note === null ? null : h(Alert, { kind: 'ok' }, note),

    tableBody,

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

    addOpen
      ? h(
          'div',
          {
            className: 'dshgt-modal-mask',
            onClick: (event: any) => {
              if (event.target === event.currentTarget) {
                setAddOpen(false);
                setAddValue('');
                setAddError(null);
              }
            },
          },
          h(
            'div',
            { className: 'dshgt-modal dshgt-addmodal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('subs.add.title') },
            h('h3', { style: { margin: 0, fontSize: 14 } }, t('subs.add.title')),
            h('input', {
              type: 'text',
              className: 'dshgt-input dshgt-addmodal-input',
              value: addValue,
              placeholder: t('subs.add.placeholder'),
              'aria-label': t('subs.add.placeholder'),
              autoComplete: 'off',
              spellCheck: false,
              autoFocus: true,
              onInput: (event: any) => {
                setAddValue(event.target.value);
                if (addError !== null) setAddError(null);
              },
              onKeyDown: (event: any) => {
                if (event.isComposing === true) return;
                if (event.key === 'Enter' && canAdd && !alreadySubscribed && busy === null) addRepo(addValue.trim());
                if (event.key === 'Escape') {
                  setAddOpen(false);
                  setAddValue('');
                  setAddError(null);
                }
              },
            }),
            addValue.trim() !== '' && !canAdd ? h('p', { className: 'dshgt-hint dshgt-addmodal-err', style: { margin: 0 } }, t('subs.input.invalid')) : null,
            alreadySubscribed ? h('p', { className: 'dshgt-hint', style: { margin: 0 } }, t('subs.add.exists', { repo: addValue.trim() })) : null,
            addError === null ? null : h('p', { className: 'dshgt-hint dshgt-addmodal-err', style: { margin: 0 } }, addError),
            h(
              'div',
              { className: 'dshgt-footer', style: { justifyContent: 'flex-end' } },
              h(
                Btn,
                {
                  small: true,
                  onClick: () => {
                    setAddOpen(false);
                    setAddValue('');
                    setAddError(null);
                  },
                },
                t('subs.cancel'),
              ),
              h(
                Btn,
                {
                  small: true,
                  variant: 'primary',
                  disabled: busy !== null || !canAdd || alreadySubscribed,
                  onClick: () => canAdd && !alreadySubscribed && addRepo(addValue.trim()),
                },
                busy === 'add' ? t('subs.adding') : t('subs.add.confirm'),
              ),
            ),
          ),
        )
      : null,

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
