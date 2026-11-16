/**
 * 通知页（WS-E）：独立「通知」页签 —— 左配置（渠道卡可展开 + 内容节奏），右「最近推送」。
 *
 * 数据边界：只读写 Host 的 `/api/morehao/github-trending/*`。配置来自 `state.settings.notify`
 * （`src/config.ts` 的 `NotifySettings`，逐字段对齐核心 `notify` YAML）；推送历史来自运行记录的
 * `notify` 子树（契约 `RunResult.notify`）。本地契约包尚未升到含 notify 的 0.8.0，故 `api.ts`
 * 里按冻结形状手写了最小 TS 类型，这里全部按可选读取，旧核心/未合入时安全降级。
 *
 * 瞬时反馈遵循 AGENTS「前端瞬时反馈」：成功类（已保存/测试成功）用 `useAutoDismiss` 自动退场
 * （useEffect + setTimeout + cleanup 守卫）；错误类常驻，直到用户再次操作或修正。
 */
import { React } from './ui.js';
import { h, Card, Row, Input, Select, Btn, Pill, Alert, Toggle } from './ui.js';
import type { Translate } from './i18n.js';
import type { StoreValue } from './store.js';
import {
  apiCall,
  type NotifyChannelKey,
  type NotifyChannelSettingsShape,
  type NotifyMessage,
  type NotifyReport,
  type NotifySettingsShape,
  type RunRecord,
  type SettingsShape,
} from './api.js';
import { isChannelConfigured } from './notify-webhook.js';

/** 渠道静态元数据（顺序即界面展示顺序：企微 / 钉钉 / 飞书）。 */
interface ChannelMeta {
  key: NotifyChannelKey;
  labelKey: string;
  color: string;
  letter: string;
  msgtypes: string[];
  hasSecret: boolean;
  env: string;
}

const CHANNELS: ChannelMeta[] = [
  { key: 'wecom', labelKey: 'notify.channel.wecom', color: '#07c160', letter: '企', msgtypes: ['markdown', 'text'], hasSecret: false, env: '${WECOM_WEBHOOK}' },
  { key: 'dingtalk', labelKey: 'notify.channel.dingtalk', color: '#1a7cf5', letter: '钉', msgtypes: ['markdown', 'text'], hasSecret: true, env: '${DINGTALK_WEBHOOK}' },
  { key: 'lark', labelKey: 'notify.channel.lark', color: '#3370ff', letter: '飞', msgtypes: ['post', 'text'], hasSecret: true, env: '${LARK_WEBHOOK}' },
];

/** 与 `src/config.ts` `DEFAULT_SETTINGS.notify` 一致的客户端兜底（旧设置缺 notify 时用）。 */
const DEFAULT_NOTIFY: NotifySettingsShape = {
  enabled: false,
  sections: { trending: true, releases: true },
  onSkipped: false,
  onEmptyReleases: false,
  strategy: 'broadcast',
  channels: {
    dingtalk: { enabled: false, webhookURL: '${DINGTALK_WEBHOOK}', secret: '${DINGTALK_SECRET}', msgtype: 'markdown' },
    lark: { enabled: false, webhookURL: '${LARK_WEBHOOK}', secret: '${LARK_SECRET}', msgtype: 'post' },
    wecom: { enabled: false, webhookURL: '${WECOM_WEBHOOK}', secret: '', msgtype: 'markdown' },
  },
  maxReposPerSection: 10,
  maxBodyChars: 0,
  timeoutSeconds: 15,
  summaryMaxChars: 800,
};

const SUCCESS_TTL_MS = 5000;

/**
 * 瞬时成功提示的自动退场（AGENTS 约束：成功类必须能自己消失）。
 * 定时器在 cleanup 里清掉；用「对象相等」守卫，避免新旧两条提示互相误清。
 */
function useAutoDismiss<T>(ttlMs = SUCCESS_TTL_MS): [T | null, (value: T | null) => void] {
  const [value, setValue] = React.useState<T | null>(null);
  React.useEffect(() => {
    if (value === null) return;
    const current = value;
    const timer = setTimeout(() => {
      setValue((existing) => (existing === current ? null : existing));
    }, ttlMs);
    return () => clearTimeout(timer);
  }, [value, ttlMs]);
  return [value, setValue];
}

/** 通知草稿归一：从 store 设置里取 notify，缺省用 DEFAULT_NOTIFY（深拷贝，避免改到 store）。 */
function notifyDraftOf(settings: SettingsShape | undefined): NotifySettingsShape {
  const source = settings?.notify;
  const base = JSON.parse(JSON.stringify(DEFAULT_NOTIFY)) as NotifySettingsShape;
  if (source === undefined || source === null) return base;
  return {
    ...base,
    ...source,
    sections: { ...base.sections, ...(source.sections ?? {}) },
    channels: {
      dingtalk: { ...base.channels.dingtalk, ...(source.channels?.dingtalk ?? {}) },
      lark: { ...base.channels.lark, ...(source.channels?.lark ?? {}) },
      wecom: { ...base.channels.wecom, ...(source.channels?.wecom ?? {}) },
    },
  };
}

function sameNotify(a: NotifySettingsShape, b: NotifySettingsShape): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 纯 `${VAR}` 占位引用与「已配置」判定见 `notify-webhook.ts`（无 React 依赖，便于单测）。 */

/** 推送记录的汇总状态：从逐渠道 status 推导 sent / partial / failed / skipped。 */
type RecordStatus = 'sent' | 'partial' | 'failed' | 'skipped';

function recordStatusOf(message: NotifyMessage): RecordStatus {
  const active = message.channels.filter((channel) => channel.status !== 'disabled');
  if (active.length === 0) return 'skipped';
  const failed = active.filter((channel) => channel.status === 'failed').length;
  if (failed === 0) return 'sent';
  if (failed === active.length) return 'failed';
  return 'partial';
}

interface PushRow {
  key: string;
  at: string;
  message: NotifyMessage;
  tokens?: number;
}

/**
 * 从运行记录里收集推送条目（只取带 `notify` 且 attempted 的记录）。
 * 顺序：先最近一次结果，再历史；按 7 天窗口过滤由调用方负责（这里给全量便于统计）。
 */
function collectPushes(records: Array<RunRecord | null | undefined>): PushRow[] {
  const rows: PushRow[] = [];
  for (const record of records) {
    if (record === null || record === undefined) continue;
    const report: NotifyReport | undefined = record.notify;
    if (report === undefined || !report.attempted) continue;
    const at = record.at;
    report.messages.forEach((message, index) => {
      const tokens = report.usage?.usageKnown === true ? Math.round((report.usage.totalTokens ?? 0) / Math.max(1, report.messages.length)) : undefined;
      rows.push({ key: `${record.id}-${index}`, at, message, ...(tokens === undefined ? {} : { tokens }) });
    });
  }
  return rows;
}

function withinDays(iso: string, days: number): boolean {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return true;
  return Date.now() - time <= days * 24 * 3600 * 1000;
}

export function NotifyView(props: { t: Translate; store: StoreValue }): any {
  const { t, store } = props;
  const state = store.state;
  const settingsNotify = notifyDraftOf(state?.settings);
  const [draft, setDraft] = React.useState<NotifySettingsShape>(settingsNotify);
  const [expanded, setExpanded] = React.useState<Record<NotifyChannelKey, boolean>>({ wecom: true, dingtalk: false, lark: false });
  const [saving, setSaving] = React.useState(false);
  const [savedNotice, setSavedNotice] = useAutoDismiss<string>();
  const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<'all' | 'trending' | 'releases'>('all');

  // 进入页/外部设置刷新时，只要本地没有未保存改动就同步成最新（否则保留用户草稿）。
  const baselineRef = React.useRef<NotifySettingsShape>(settingsNotify);
  React.useEffect(() => {
    const incoming = notifyDraftOf(state?.settings);
    if (sameNotify(draft, baselineRef.current)) {
      baselineRef.current = incoming;
      setDraft(incoming);
    }
    // 只依赖 state 的 notify 变化，避免每次轮询都覆盖草稿。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(state?.settings?.notify ?? null)]);

  const dirty = !sameNotify(draft, baselineRef.current);

  const update = (mutate: (next: NotifySettingsShape) => void): void => {
    setDraft((current) => {
      const next = JSON.parse(JSON.stringify(current)) as NotifySettingsShape;
      mutate(next);
      return next;
    });
    setError(null);
    setSavedNotice(null);
  };

  const save = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setSavedNotice(null);
    try {
      const result = await apiCall<{ saved: boolean; settings: SettingsShape; problems: Array<{ field: string; message: string }> }>(
        'POST',
        '/config',
        { settings: { ...(state?.settings ?? {}), notify: draft }, section: 'notify' },
      );
      if (result.saved) {
        baselineRef.current = notifyDraftOf(result.settings);
        setDraft(baselineRef.current);
        setSavedNotice(t('notify.save.saved'));
        await store.refresh({ quiet: true });
      } else {
        const problems = result.problems ?? [];
        setError(problems.length > 0 ? problems.map((problem) => problem.message).join('；') : t('notify.save.failed', { message: '' }));
      }
    } catch (failure) {
      setError(t('notify.save.failed', { message: failure instanceof Error ? failure.message : String(failure) }));
    } finally {
      setSaving(false);
    }
  };

  // 测试按钮已移除：当前版本没有「试发单渠道」的真实接口，前端的「假测试」只会误导用户
  // （见 AGENTS：不伪装成功）。等契约定义试发接口后再放出。

  const online = CHANNELS.filter((channel) => draft.channels[channel.key].enabled).length;

  // ── 最近推送数据 ──────────────────────────────────────────
  const history = state?.status.history ?? [];
  const lastResult = state?.status.lastResult ?? null;
  // 去重：lastResult 可能也在 history 里（按 id）。
  const seen = new Set<string>();
  const records: Array<RunRecord | null | undefined> = [];
  for (const record of [lastResult, ...history]) {
    if (record === null || record === undefined) continue;
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    records.push(record);
  }
  const pushes = collectPushes(records).filter((row) => withinDays(row.at, 7));
  const shown = pushes.filter((row) => filter === 'all' || row.message.kind === filter);

  const total = pushes.length;
  const activeChannelRows = pushes.flatMap((row) => row.message.channels.filter((channel) => channel.status !== 'disabled'));
  const sentRows = activeChannelRows.filter((channel) => channel.status === 'sent').length;
  const deliveryRate = activeChannelRows.length === 0 ? null : Math.round((sentRows / activeChannelRows.length) * 100);
  const partialCount = pushes.filter((row) => recordStatusOf(row.message) === 'partial' || recordStatusOf(row.message) === 'failed').length;

  return h(
    'div',
    { className: 'dshgt-view', style: { maxWidth: 'none' } },
    // 总开关条
    h(
      'div',
      { className: 'dshgt-card', style: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: '12px 14px', flexWrap: 'wrap' } },
      h(
        'div',
        { style: { minWidth: 0 } },
        h('div', { style: { fontSize: 13.5, fontWeight: 650 } }, draft.enabled ? t('notify.master.on') : t('notify.master.off')),
        h('div', { className: 'dshgt-hint' }, t('notify.master.hint')),
      ),
      h(
        'div',
        { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 } },
        h(Pill, { kind: online > 0 ? 'ok' : 'idle' }, t('notify.master.channelsOn', { n: online })),
        h(Toggle, { checked: draft.enabled, onChange: (next: boolean) => update((d) => { d.enabled = next; }), label: t('notify.master.toggle') }),
      ),
    ),
    // 保存条（脏时出现，含瞬时成功/常驻错误）
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 10, minHeight: 34, flexWrap: 'wrap' } },
      dirty
        ? h(Btn, { variant: 'primary', onClick: () => void save(), disabled: saving }, saving ? t('notify.save.saving') : t('notify.save.save'))
        : null,
      savedNotice !== null ? h(Pill, { kind: 'ok' }, savedNotice) : null,
      error !== null ? h(Alert, { kind: 'err' }, error) : null,
    ),
    h(
      'div',
      { className: `dshgt-notify-2col${draft.enabled ? '' : ' dshgt-notify-dim'}` },
      // ── 左：渠道 + 内容节奏 ──
      h(
        'div',
        { className: 'dshgt-notify-col' },
        h(
          Card,
          { title: t('notify.channels.title'), hint: t('notify.channels.hint') },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 9 } },
            CHANNELS.map((channel) => renderChannelCard({
              t,
              channel,
              cfg: draft.channels[channel.key],
              expanded: expanded[channel.key] === true,
              onToggle: () => update((d) => { d.channels[channel.key].enabled = !d.channels[channel.key].enabled; }),
              onExpand: () => setExpanded((current) => ({ ...current, [channel.key]: !current[channel.key] })),
              onWebhook: (value) => update((d) => { d.channels[channel.key].webhookURL = value; }),
            })),
          ),
        ),
        h(
          Card,
          { title: t('notify.content.title') },
          h(
            Row,
            { label: t('notify.content.trending'), help: t('notify.content.trendingHelp') },
            h(Toggle, { checked: draft.sections.trending, onChange: (next: boolean) => update((d) => { d.sections.trending = next; }), label: t('notify.content.trending') }),
            h('span', { className: 'dshgt-hint' }, t('notify.content.trendingNote')),
          ),
          h(
            Row,
            { label: t('notify.content.releases') },
            h(Toggle, { checked: draft.sections.releases, onChange: (next: boolean) => update((d) => { d.sections.releases = next; }), label: t('notify.content.releases') }),
            h('span', { className: 'dshgt-hint' }, t('notify.content.releasesNote')),
          ),
          h(
            Row,
            { label: t('notify.content.emptyReleases') },
            h(Toggle, { checked: draft.onEmptyReleases, onChange: (next: boolean) => update((d) => { d.onEmptyReleases = next; }), label: t('notify.content.emptyReleases') }),
          ),
          h(
            Row,
            { label: t('notify.content.onSkipped'), help: t('notify.content.onSkippedNote') },
            h(Toggle, { checked: draft.onSkipped, onChange: (next: boolean) => update((d) => { d.onSkipped = next; }), label: t('notify.content.onSkipped') }),
          ),
          h(
            Row,
            { label: t('notify.content.strategy'), help: t('notify.content.strategyHelp') },
            h(Select, {
              value: draft.strategy,
              onChange: (value: string) => update((d) => { d.strategy = value as NotifySettingsShape['strategy']; }),
              options: [
                { value: 'broadcast', label: t('notify.content.strategy.broadcast') },
                { value: 'requireAll', label: t('notify.content.strategy.requireAll') },
                { value: 'firstSuccess', label: t('notify.content.strategy.firstSuccess') },
              ],
            }),
          ),
          h(
            Row,
            { label: t('notify.content.summaryChars') },
            h(Input, {
              mono: true,
              width: 88,
              value: String(draft.summaryMaxChars),
              onInput: (value: string) => update((d) => { d.summaryMaxChars = toInt(value, d.summaryMaxChars); }),
            }),
            h('span', { className: 'dshgt-hint' }, t('notify.content.summaryCharsNote')),
          ),
          h(Alert, { kind: 'warn', title: t('notify.content.noFailure') }, t('notify.content.noFailureBody')),
        ),
      ),
      // ── 右：最近推送 ──
      h(
        'div',
        { className: 'dshgt-notify-col' },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
          h('div', { style: { fontSize: 13.5, fontWeight: 650 } }, t('notify.recent.title')),
          h('span', { className: 'dshgt-hint' }, t('notify.recent.hint')),
          h('span', { className: 'dshgt-hint dshgt-mono', style: { marginLeft: 'auto' } }, t('notify.recent.window')),
        ),
        h(
          'div',
          { className: 'dshgt-statgrid' },
          statCell(String(total), t('notify.stat.total')),
          statCell(deliveryRate === null ? '—' : `${deliveryRate}%`, t('notify.stat.delivery')),
          statCell(String(partialCount), t('notify.stat.partial'), partialCount > 0),
          statCell(String(online), t('notify.stat.channels')),
        ),
        h(
          'div',
          { className: 'dshgt-push-filter' },
          [
            ['all', t('notify.filter.all')],
            ['trending', t('notify.filter.trending')],
            ['releases', t('notify.filter.releases')],
          ].map(([id, label]) =>
            h(
              'button',
              {
                key: id,
                type: 'button',
                onClick: () => setFilter(id as 'all' | 'trending' | 'releases'),
                className: 'dshgt-chip',
                'aria-pressed': filter === id ? 'true' : 'false',
              },
              label,
            ),
          ),
        ),
        pushes.length === 0
          ? h('div', { className: 'dshgt-empty' }, t('notify.recent.noNotify'))
          : shown.length === 0
            ? h('div', { className: 'dshgt-empty' }, t('notify.recent.empty'))
            : h(
                'div',
                { className: 'dshgt-pushlist' },
                shown.map((row) => renderPushRecord(t, row)),
              ),
      ),
    ),
  );
}

function toInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function statCell(value: string, label: string, warn = false): any {
  return h(
    'div',
    { className: 'dshgt-statcell' },
    h('div', { className: `dshgt-statcell-v${warn ? ' warn' : ''}` }, value),
    h('div', { className: 'dshgt-statcell-k' }, label),
  );
}

interface ChannelCardProps {
  t: Translate;
  channel: ChannelMeta;
  cfg: NotifyChannelSettingsShape;
  expanded: boolean;
  onToggle: () => void;
  onExpand: () => void;
  onWebhook: (value: string) => void;
}

function renderChannelCard(props: ChannelCardProps): any {
  const { t, channel, cfg, expanded } = props;
  const on = cfg.enabled;
  const configured = isChannelConfigured(cfg);
  const name = t(channel.labelKey);
  return h(
    'div',
    { key: channel.key, className: `dshgt-chcard${on ? ' on' : ''}` },
    h(
      'div',
      {
        className: 'dshgt-chcard-h clickable',
        onClick: props.onExpand,
      },
      h('span', { className: 'dshgt-chbadge', style: { background: channel.color } }, channel.letter),
      h(
        'div',
        { style: { minWidth: 0 } },
        h(
          'div',
          { className: 'dshgt-chcard-title' },
          name,
          on && configured ? h(Pill, { kind: 'ok' }, t('notify.channels.configured')) : null,
          !on ? h('span', { className: 'dshgt-hint', style: { fontSize: 11 } }, t('notify.channels.disabled')) : null,
        ),
        h('div', { className: 'dshgt-chcard-sub' }, on ? (channel.hasSecret ? t('notify.channels.subtypeSecret') : t('notify.channels.subtype')) : t('notify.channels.subtypeOff')),
      ),
      h(
        'div',
        { className: 'dshgt-chcard-right' },
        h('span', { onClick: (event: any) => event.stopPropagation() }, h(Toggle, { checked: on, onChange: props.onToggle })),
        h('span', { className: `dshgt-chcard-caret${expanded ? ' open' : ''}` }, '▸'),
      ),
    ),
    on && expanded
      ? h(
          'div',
          { className: 'dshgt-chcard-body' },
          h(
            Row,
            { label: t('notify.field.webhook'), help: t('notify.field.webhookHelp', { name, env: channel.env }) },
            h(Input, { mono: true, width: 300, value: cfg.webhookURL, onInput: props.onWebhook }),
            configured ? h(Pill, { kind: 'ok' }, t('notify.channels.configured')) : h(Pill, { kind: 'warn' }, t('notify.channels.unconfigured')),
          ),
          // 加签密钥 / 消息类型改为渠道默认值，不再让用户填写（见设计文档 ④）。
        )
      : null,
  );
}

function renderPushRecord(t: Translate, row: PushRow): any {
  const { message } = row;
  const status = recordStatusOf(message);
  // 默认只折叠「全部送达」的记录；非全绿默认展开（与原型一致）。
  const [open, setOpen] = React.useState(status !== 'sent');
  const statusMeta: Record<RecordStatus, { kind: 'ok' | 'warn' | 'err' | 'idle'; label: string }> = {
    sent: { kind: 'ok', label: t('notify.status.sent') },
    partial: { kind: 'warn', label: t('notify.status.partial') },
    failed: { kind: 'err', label: t('notify.status.failed') },
    skipped: { kind: 'idle', label: t('notify.status.skipped') },
  };
  const meta = statusMeta[status];
  const kindLabel = message.kind === 'trending' ? t('notify.kind.trending') : t('notify.kind.releases');
  return h(
    'div',
    { key: row.key, className: `dshgt-push${open ? ' open' : ''}` },
    h(
      'div',
      { className: 'dshgt-push-h clickable', onClick: () => setOpen(!open) },
      h('span', { className: 'dshgt-tag' }, kindLabel),
      message.period !== undefined ? h('span', { className: 'dshgt-push-period' }, message.period) : null,
      h('span', { className: 'dshgt-push-time' }, shortStamp(row.at)),
      h(
        'div',
        { className: 'dshgt-push-right' },
        h(Pill, { kind: meta.kind }, meta.label),
        h('span', { className: `dshgt-push-caret${open ? ' open' : ''}` }, '▸'),
      ),
    ),
    open
      ? h(
          'div',
          { className: 'dshgt-push-body' },
          message.channels.length === 0
            ? h('div', { className: 'dshgt-hint', style: { fontSize: 12 } }, status === 'skipped' ? t('notify.status.skipped') : t('notify.recent.empty'))
            : h(
                'div',
                { className: 'dshgt-push-chips' },
                message.channels.map((channel) =>
                  h(
                    'span',
                    { key: channel.channel, className: 'dshgt-pill' },
                    h('span', { className: `dshgt-dot ${channel.status === 'sent' ? 'ok' : channel.status === 'failed' ? 'err' : ''}`.trim() }),
                    channel.channel,
                    channel.status === 'failed' ? h('span', { className: 'dshgt-push-err' }, channel.error ?? t('notify.status.failed')) : null,
                    typeof channel.durationMs === 'number' ? h('span', { className: 'dshgt-push-dur' }, `${channel.durationMs}ms`) : null,
                  ),
                ),
              ),
          h(
            'div',
            { className: 'dshgt-push-meta' },
            h('span', null, t('notify.record.body'), ' ', h('span', { className: 'dshgt-mono' }, t('notify.record.chars', { n: message.bodyChars }))),
            h('span', null, t('notify.record.model'), ' ', h('b', null, message.summarySource === 'model' ? t('notify.record.srcModel') : t('notify.record.srcFallback'))),
            row.tokens === undefined
              ? null
              : h('span', null, t('notify.record.cost'), ' ', h('span', { className: 'dshgt-mono' }, t('notify.record.tokens', { n: row.tokens }))),
          ),
        )
      : null,
  );
}

function shortStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}
