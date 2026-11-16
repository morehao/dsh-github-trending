/**
 * 推送通知：配置 section（设置页「推送通知」） + 共享推送结果卡片。
 *
 * 历史变更：原为独立「通知」页签（左配置 + 右「最近推送」7 天汇总）。现按方案 A 拆分：
 *  - 配置（渠道卡 + 内容节奏）→ 设置页 `notify` section，经 `NotifySettingsSection` 渲染；
 *  - 推送结果 → 回到它真正所属的那一次运行，在运行记录详情里用 `NotifyPushRecord` 渲染；
 *  - 跨运行「最近推送」汇总已下线。
 *
 * 数据边界：只读写 Host 的 `/api/morehao/github-trending/*`。配置来自 `state.settings.notify`
 * （`src/config.ts` 的 `NotifySettings`，逐字段对齐核心 `notify` YAML）；推送结果来自运行记录的
 * `notify` 子树（契约 `RunResult.notify`）。本地契约包尚未升到含 notify 的 0.8.0，故 `api.ts`
 * 里按冻结形状手写了最小 TS 类型，这里全部按可选读取，旧核心/未合入时安全降级。
 *
 * 瞬时反馈遵循 AGENTS「前端瞬时反馈」：成功类（已保存/测试成功）用 `useAutoDismiss` 自动退场
 * （useEffect + setTimeout + cleanup 守卫）；错误类常驻，直到用户再次操作或修正。
 */
import { React } from './ui.js';
import { h, Card, Row, Input, Select, Btn, Pill, Alert, Toggle } from './ui.js';
import type { Translate } from './i18n.js';
import {
  apiCall,
  type NotifyChannelKey,
  type NotifyChannelSettingsShape,
  type NotifyMessage,
  type NotifyReport,
  type NotifyTestResult,
  type NotifySettingsShape,
} from './api.js';
import { hasRealWebhook, isChannelConfigured } from './notify-webhook.js';

/**
 * 渠道静态元数据（顺序即界面展示顺序：企微 / 钉钉 / 飞书）。
 *
 * `icon` 是官方 logo 的内联 SVG 内容（只含 `<path>`，用 currentColor 上色），来源为 MIT 开源图标包，
 * 非手绘：企业微信 = Tencent/tdesign-icons `logo-wecom`；钉钉 = ant-design/ant-design-icons `dingtalk`；
 * 飞书 = DouyinFE/semi-icons `feishu_logo`。渠道卡 badge 用官方品牌色底 + 白色 logo。
 * （客户端只允许依赖 react，故内联而非引外部图片。）
 */
interface ChannelMeta {
  key: NotifyChannelKey;
  labelKey: string;
  color: string;
  icon: string;
  msgtypes: string[];
  hasSecret: boolean;
  env: string;
}

const WECOM_ICON = '\n  ' + '<path d="M17.3261 8.15754L17.3228 8.15069C17.0394 7.56412 16.6404 6.99422 16.1445 6.47713C14.8786 5.17033 13.0776 4.28741 11.0431 4.05986C10.673 4.01979 10.3047 4 9.94957 4C9.62263 4 9.27922 4.0193 8.91865 4.05952L8.91755 4.05965C6.85659 4.28839 5.03568 5.1673 3.77824 6.46538C3.27725 6.98775 2.87802 7.54898 2.58414 8.14712C2.19144 8.95433 2 9.79185 2 10.6574C2 11.7632 2.33191 12.875 2.98788 13.8581L2.99438 13.8678L2.99435 13.8679C3.38549 14.4616 4.08579 15.2583 4.63143 15.6982L5.61433 16.4906L5.40578 17.366L5.93277 17.0993L6.64094 16.7409L7.40215 16.9656C7.86891 17.1034 8.35651 17.1927 8.91862 17.2554L8.9244 17.256C9.26741 17.2953 9.60902 17.3149 9.94957 17.3149C10.3047 17.3149 10.6736 17.295 11.0448 17.2549C11.5031 17.2043 11.955 17.1167 12.3913 16.9973C12.4856 17.6972 12.8215 18.3342 13.3232 18.8066V18.8073H13.3231C12.6647 19.0154 11.9712 19.1649 11.2619 19.243C10.8205 19.2908 10.3791 19.3149 9.94957 19.3149C9.53203 19.3149 9.11448 19.2908 8.69693 19.243C8.05271 19.1712 7.44429 19.0634 6.83585 18.8838L3.99654 20.3207C3.99654 20.3207 3.70563 20.4523 3.55512 20.4523C3.13758 20.4523 2.85357 20.1671 2.85357 19.748C2.85357 19.4959 2.92051 19.1503 2.98248 18.9077L3.37618 17.2552C2.64845 16.6686 1.81334 15.7106 1.32422 14.9682C0.453338 13.663 0 12.1662 0 10.6574C0 9.48394 0.262458 8.34638 0.787376 7.2687C1.18106 6.46641 1.70599 5.73599 2.33827 5.0774C3.94881 3.41297 6.21551 2.34726 8.69693 2.07185C9.1264 2.02395 9.54395 2 9.94957 2C10.3791 2 10.8205 2.02395 11.2619 2.07185C13.7314 2.34726 15.9742 3.42495 17.5847 5.08937C18.217 5.74795 18.7419 6.49037 19.1237 7.28066C19.5895 8.22633 19.8926 9.2182 19.8928 10.2591C19.7117 10.1958 19.5219 10.1488 19.325 10.1201C18.8263 10.0474 18.3382 10.1001 17.8928 10.2544C17.8917 9.60962 17.7043 8.92531 17.3295 8.16436L17.3261 8.15754ZM21.4505 15.1352L21.4266 15.1113C21.4207 15.1053 21.4116 15.0992 21.4026 15.0932C21.3937 15.0873 21.3848 15.0813 21.3788 15.0754L21.2835 14.9796C20.6632 14.3569 20.2693 13.5906 20.1144 12.7883C20.1144 12.7626 20.1109 12.7369 20.1077 12.7131C20.1049 12.6925 20.1023 12.6732 20.1023 12.6566L20.0666 12.5129C20.0069 12.2854 19.8877 12.0698 19.7086 11.9022C19.1719 11.3633 18.2891 11.3633 17.7521 11.9022C17.2153 12.441 17.2153 13.3271 17.7521 13.866C17.943 14.0575 18.1697 14.1773 18.4203 14.2372C18.4442 14.2491 18.48 14.2491 18.5037 14.2491C18.5157 14.2491 18.5306 14.2521 18.5455 14.2551C18.5604 14.2581 18.5753 14.2611 18.5873 14.2611C19.4104 14.4168 20.1859 14.8119 20.8181 15.4465C20.8659 15.4945 20.9136 15.5424 20.9494 15.5902C21.0806 15.722 21.2835 15.722 21.4147 15.5902C21.546 15.4585 21.546 15.267 21.4505 15.1352ZM20.4001 19.5059L20.3762 19.5298C20.257 19.6257 20.0661 19.6257 19.9228 19.4938C19.7916 19.3622 19.7916 19.1586 19.9228 19.027C19.9701 18.9915 20.0171 18.9443 20.0643 18.8969L20.0643 18.8969L20.0661 18.8951C20.6983 18.2605 21.092 17.4823 21.2471 16.656C21.2471 16.6441 21.2501 16.6291 21.2531 16.6142L21.2531 16.6141C21.256 16.5992 21.259 16.5842 21.259 16.5721C21.259 16.5482 21.259 16.5123 21.271 16.4884C21.3307 16.2369 21.4499 16.0093 21.6408 15.8178C22.1776 15.2789 23.0606 15.2789 23.5973 15.8178C24.1341 16.3567 24.1341 17.2427 23.5973 17.7816C23.4303 17.9612 23.2155 18.081 22.9889 18.1408L22.8458 18.1768C22.8292 18.1768 22.8099 18.1793 22.7893 18.1821C22.7656 18.1853 22.74 18.1888 22.7145 18.1888C21.9151 18.3444 21.1517 18.7395 20.5313 19.3622L20.4359 19.4581C20.4299 19.464 20.4239 19.4731 20.4179 19.4821L20.4179 19.4821C20.4119 19.491 20.406 19.4999 20.4001 19.5059ZM16.0095 18.452L16.0334 18.4759C16.0394 18.4819 16.0484 18.488 16.0574 18.494L16.0575 18.4941C16.0663 18.5 16.0752 18.5059 16.081 18.5118L16.1765 18.6075C16.7969 19.2303 17.1905 19.9966 17.3457 20.7989C17.3457 20.8246 17.3491 20.8503 17.3522 20.8741L17.3523 20.8742C17.355 20.8948 17.3575 20.9141 17.3575 20.9307L17.3935 21.0743C17.453 21.3018 17.5723 21.5174 17.7514 21.685C18.2882 22.2239 19.171 22.2239 19.7078 21.685C20.2447 21.1461 20.2447 20.2601 19.7078 19.7212C19.517 19.5296 19.2903 19.4099 19.0397 19.35C19.0158 19.3381 18.9801 19.3381 18.9562 19.3381C18.9443 19.3381 18.9295 19.3351 18.9146 19.3321C18.8997 19.3291 18.8847 19.3261 18.8727 19.3261C18.0496 19.1705 17.2741 18.7753 16.6419 18.1407C16.5941 18.0927 16.5464 18.0448 16.5107 17.997C16.3794 17.8653 16.1765 17.8653 16.0453 17.997C15.9022 18.1286 15.9022 18.3322 16.0095 18.452ZM17.0476 14.0936L17.0715 14.0696C17.2027 13.9619 17.3936 13.9619 17.5248 14.1055C17.6561 14.2373 17.6561 14.4408 17.5248 14.5725C17.4777 14.608 17.4307 14.6551 17.3835 14.7023L17.3816 14.7043C16.7493 15.3389 16.3557 16.1172 16.2005 16.9435C16.2005 16.9554 16.1976 16.9704 16.1946 16.9854C16.1916 17.0003 16.1887 17.0153 16.1887 17.0272C16.1887 17.0513 16.1887 17.0872 16.1768 17.1111C16.1171 17.3626 15.9978 17.59 15.8069 17.7817C15.2701 18.3206 14.3872 18.3206 13.8504 17.7817C13.3135 17.2428 13.3135 16.3567 13.8504 15.8179C14.0174 15.6383 14.2321 15.5185 14.4588 15.4587L14.602 15.4227C14.6186 15.4227 14.6378 15.4201 14.6583 15.4174L14.6583 15.4174H14.6584C14.6821 15.4142 14.7076 15.4107 14.7332 15.4107C15.5325 15.2551 16.296 14.86 16.9163 14.2373L17.0118 14.1415C17.0179 14.1354 17.0239 14.1263 17.0299 14.1173C17.0358 14.1084 17.0417 14.0995 17.0476 14.0936Z" fill="currentColor"/>';
const DINGTALK_ICON = '<path d="M573.7 252.5C422.5 197.4 201.3 96.7 201.3 96.7c-15.7-4.1-17.9 11.1-17.9 11.1-5 61.1 33.6 160.5 53.6 182.8 19.9 22.3 319.1 113.7 319.1 113.7S326 357.9 270.5 341.9c-55.6-16-37.9 17.8-37.9 17.8 11.4 61.7 64.9 131.8 107.2 138.4 42.2 6.6 220.1 4 220.1 4s-35.5 4.1-93.2 11.9c-42.7 5.8-97 12.5-111.1 17.8-33.1 12.5 24 62.6 24 62.6 84.7 76.8 129.7 50.5 129.7 50.5 33.3-10.7 61.4-18.5 85.2-24.2L565 743.1h84.6L603 928l205.3-271.9H700.8l22.3-38.7c.3.5.4.8.4.8S799.8 496.1 829 433.8l.6-1h-.1c5-10.8 8.6-19.7 10-25.8 17-71.3-114.5-99.4-265.8-154.5z" fill="currentColor"/>';
const LARK_ICON = '<path d="M6.13732 3.80654C8.76716 5.98777 11.0232 8.49408 12.7428 11.4327L14.4397 9.75535C15.2458 8.96545 16.2113 8.34129 17.258 7.93496C16.7802 6.31936 16.0033 4.98005 14.9403 3.65376C14.8135 3.49449 14.6185 3.40346 14.4137 3.40346L6.28362 3.40021C6.06906 3.40021 5.9748 3.67001 6.13732 3.80654Z" fill="currentColor"/><path d="M20.5703 14.1922L20.58 14.1793L20.6155 14.1146C20.6026 14.1372 20.5864 14.1631 20.5703 14.1922Z" fill="currentColor"/><path d="M11.0361 14.5567C12.2714 15.0833 13.3766 15.5287 14.6899 15.883C17.0207 16.5136 19.2311 15.5709 20.3234 13.4872L21.6432 10.8541C21.939 10.2105 22.3128 9.6156 22.7647 9.07273C21.9715 8.78016 21.3149 8.63064 20.4534 8.63064C18.5518 8.63064 16.7606 9.36205 15.4018 10.6948L13.3831 12.6875C12.6647 13.3929 11.878 14.0203 11.0361 14.5567Z" fill="currentColor"/><path d="M20.7945 13.7752L20.8039 13.7566L20.8101 13.7473C20.8039 13.7535 20.8007 13.7659 20.7945 13.7752Z" fill="currentColor"/><path d="M1.62519 9.74885C1.47889 9.60906 1.23511 9.70983 1.23511 9.91463L1.23834 17.8724C1.23834 18.1 1.34887 18.3112 1.53416 18.4348C3.66663 19.8521 6.15343 20.5998 8.72151 20.5998C11.166 20.5998 13.5488 19.9171 15.6098 18.6266C16.3867 18.139 16.9979 17.7099 17.6512 17.0792C16.6013 17.388 15.4472 17.4075 14.2835 17.0922C9.37815 15.7594 5.20097 13.2044 1.62519 9.74885Z" fill="currentColor"/>';

const CHANNELS: ChannelMeta[] = [
  { key: 'wecom', labelKey: 'notify.channel.wecom', color: '#07C160', icon: WECOM_ICON, msgtypes: ['markdown', 'text'], hasSecret: false, env: '${WECOM_WEBHOOK}' },
  { key: 'dingtalk', labelKey: 'notify.channel.dingtalk', color: '#0089FF', icon: DINGTALK_ICON, msgtypes: ['markdown', 'text'], hasSecret: true, env: '${DINGTALK_WEBHOOK}' },
  { key: 'lark', labelKey: 'notify.channel.lark', color: '#3370FF', icon: LARK_ICON, msgtypes: ['interactive', 'post', 'text'], hasSecret: true, env: '${LARK_WEBHOOK}' },
];

/** 与 `src/config.ts` `DEFAULT_SETTINGS.notify` 一致的客户端兜底（旧设置缺 notify 时用）。 */
export const DEFAULT_NOTIFY: NotifySettingsShape = {
  enabled: false,
  sections: { trending: true, releases: true },
  onSkipped: false,
  onEmptyReleases: false,
  strategy: 'broadcast',
  channels: {
    dingtalk: { enabled: false, webhookURL: '${DINGTALK_WEBHOOK}', secret: '${DINGTALK_SECRET}', msgtype: 'markdown' },
    lark: { enabled: false, webhookURL: '${LARK_WEBHOOK}', secret: '${LARK_SECRET}', msgtype: 'interactive' },
    wecom: { enabled: false, webhookURL: '${WECOM_WEBHOOK}', secret: '', msgtype: 'markdown' },
  },
  maxReposPerSection: 10,
  maxBodyChars: 0,
  timeoutSeconds: 15,
  summaryMaxChars: 800,
};

/** 纯 `${VAR}` 占位引用与「已配置」判定见 `notify-webhook.ts`（无 React 依赖，便于单测）。 */

/** 推送记录的汇总状态：从逐渠道 status 推导 sent / partial / failed / skipped。 */
export type RecordStatus = 'sent' | 'partial' | 'failed' | 'skipped';

export function recordStatusOf(message: NotifyMessage): RecordStatus {
  const active = message.channels.filter((channel) => channel.status !== 'disabled');
  if (active.length === 0) return 'skipped';
  const failed = active.filter((channel) => channel.status === 'failed').length;
  if (failed === 0) return 'sent';
  if (failed === active.length) return 'failed';
  return 'partial';
}

/**
 * 设置页「推送通知」分区的内容（受控组件，与设置页其它分区一致：编辑 draft，统一由页脚保存）。
 *
 * 只渲染表单；`draft.notify` 由 SettingsView 管理，`update` 回写草稿，`dirty` 决定能否试发
 * （试发走 Host 已保存的设置，草稿未保存时先提示保存）。
 */
export function NotifySettingsSection(props: {
  t: Translate;
  draft: NotifySettingsShape;
  update: (mutate: (next: NotifySettingsShape) => void) => void;
  dirty: boolean;
}): any {
  const { t, draft, update, dirty } = props;
  const [expanded, setExpanded] = React.useState<Record<NotifyChannelKey, boolean>>({ wecom: true, dingtalk: false, lark: false });
  // 逐渠道试发状态：'testing' → 结果（'ok' 或错误文本）。成功自动消失（错误常驻）。
  const [testState, setTestState] = React.useState<Record<string, 'testing' | 'ok' | string>>({});

  // 试发单渠道：调 Host `/notify/test`，由核心真实发送一条测试消息，返回逐渠道 status。
  // 注意：Host 侧 runner 读的是「已保存的设置」，草稿有未保存改动时先让用户保存，避免测的是旧 webhook。
  const testChannel = (channel: ChannelMeta): void => {
    if (dirty) {
      setTestState((current) => ({ ...current, [channel.key]: t('notify.test.needSave') + '|err' }));
      return;
    }
    const cfg = draft.channels[channel.key];
    if (!hasRealWebhook(cfg)) {
      setTestState((current) => ({ ...current, [channel.key]: t('notify.test.empty') + '|err' }));
      return;
    }
    setTestState((current) => ({ ...current, [channel.key]: 'testing' }));
    void (async () => {
      try {
        const result = await apiCall<NotifyTestResult>('POST', '/notify/test', { channel: channel.key });
        const outcome = testOutcomeOf(result.report, channel.key);
        const okText = t('notify.test.ok');
        setTestState((current) => ({ ...current, [channel.key]: outcome.ok ? okText : `${outcome.message}|err` }));
        if (outcome.ok) {
          const key = channel.key;
          setTimeout(() => {
            setTestState((current) => (current[key] === okText ? { ...current, [key]: undefined as never } : current));
          }, 5000);
        }
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure);
        setTestState((current) => ({ ...current, [channel.key]: t('notify.test.failed', { message }) + '|err' }));
      }
    })();
  };

  const online = CHANNELS.filter((channel) => draft.channels[channel.key].enabled).length;

  return h(
    'div',
    { className: `dshgt-notify-stack${draft.enabled ? '' : ' dshgt-notify-dim'}` },
    // 总开关 + 在线渠道
    // 总开关 + 在线渠道数（手写行卡：无独立标题，标题即字段名，避免 Card 必填 title 渲染空 h3）。
    h(
      'section',
      { className: 'dshgt-card' },
      h(
        Row,
        { label: t('notify.master.toggle'), help: t('notify.master.hint') },
        h(Toggle, { checked: draft.enabled, onChange: (next: boolean) => update((d) => { d.enabled = next; }), label: t('notify.master.toggle') }),
        h(Pill, { kind: online > 0 ? 'ok' : 'idle' }, t('notify.master.channelsOn', { n: online })),
      ),
    ),
    // 渠道卡
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
          testState: testState[channel.key],
          onToggle: () => update((d) => { d.channels[channel.key].enabled = !d.channels[channel.key].enabled; }),
          onExpand: () => setExpanded((current) => ({ ...current, [channel.key]: !current[channel.key] })),
          onWebhook: (value) => update((d) => { d.channels[channel.key].webhookURL = value; }),
          onTest: () => testChannel(channel),
        })),
      ),
    ),
    // 内容节奏
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
  );
}


function toInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

interface ChannelCardProps {
  t: Translate;
  channel: ChannelMeta;
  cfg: NotifyChannelSettingsShape;
  expanded: boolean;
  testState: 'testing' | 'ok' | string | undefined;
  onToggle: () => void;
  onExpand: () => void;
  onWebhook: (value: string) => void;
  onTest: () => void;
}

function renderChannelCard(props: ChannelCardProps): any {
  const { t, channel, cfg, expanded, testState } = props;
  const on = cfg.enabled;
  const configured = isChannelConfigured(cfg);
  const testing = testState === 'testing';
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
      // badge：官方品牌色底 + 官方白色 logo（内联 SVG，见 CHANNELS.icon）。
      h('span', { className: 'dshgt-chbadge', style: { background: channel.color }, 'aria-hidden': 'true', dangerouslySetInnerHTML: { __html: channel.icon } }),
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
        // 已配置才给「测试」按钮：真实试发（核心发送一条消息），不是前端假校验。
        on && configured
          ? h('span', { onClick: (event: any) => event.stopPropagation() }, h(Btn, { small: true, onClick: props.onTest, disabled: testing }, testing ? t('notify.test.testing') : t('notify.test.button')))
          : null,
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
          // 试发结果：成功自动消失、失败常驻（错误类不自动退场）。
          testState !== undefined && testState !== 'testing'
            ? h(Alert, { kind: testState.endsWith('|err') ? 'err' : 'ok' }, testState.replace('|err', ''))
            : null,
          // 加签密钥 / 消息类型改为渠道默认值，不再让用户填写（见设计文档 ④）。
        )
      : null,
  );
}

/**
 * 单条推送结果卡片：标签（榜单/订阅） + 逐渠道状态 + 正文/模型/成本。
 * 运行记录详情里渲染每次运行的推送结果（原「最近推送」页已下线，本组件现仅运行记录用）。
 * `at` 给定时显示时间戳；运行记录详情里时间由外层已知，可省略。
 */
export function NotifyPushRecord(props: { t: Translate; message: NotifyMessage; at?: string; rowKey?: string; tokens?: number }): any {
  const { t, message, at, tokens } = props;
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
    { key: props.rowKey, className: `dshgt-push${open ? ' open' : ''}` },
    h(
      'div',
      { className: 'dshgt-push-h clickable', onClick: () => setOpen(!open) },
      h('span', { className: 'dshgt-tag' }, kindLabel),
      message.period !== undefined ? h('span', { className: 'dshgt-push-period' }, message.period) : null,
      at !== undefined ? h('span', { className: 'dshgt-push-time' }, shortStamp(at)) : null,
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
            tokens === undefined
              ? null
              : h('span', null, t('notify.record.cost'), ' ', h('span', { className: 'dshgt-mono' }, t('notify.record.tokens', { n: tokens }))),
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

/** 从试发报告里取单渠道结果：ok=该渠道 sent；否则带失败原因。 */
function testOutcomeOf(report: NotifyReport, channelKey: NotifyChannelKey): { ok: boolean; message: string } {
  for (const message of report.messages) {
    for (const channel of message.channels) {
      if (channel.channel === channelKey) {
        if (channel.status === 'sent') return { ok: true, message: '' };
        return { ok: false, message: channel.error ?? channel.status };
      }
    }
  }
  return { ok: false, message: 'no-result' };
}
