/**
 * 自更新后的「恢复提示」：居中的弹层（遮罩 + 卡片），唯一动作是「关闭」。
 *
 * 插件一键更新会先卸载自己，面板随之消失，「请重启」的提示也会一起没掉。把「我刚点了更新」
 * 记进 localStorage（见 update-store 的 pending 记号），重开的新进程读到它就在这里渲染一句
 * 「更新已安装、请彻底退出 DSH 再打开生效」——这是唯一能承载这句话的位置。
 *
 * 设计约定：
 *   - **居中弹层**：`position:fixed` 的遮罩铺满宿主窗口，卡片居中；它是一条需要用户照做的
 *     操作指令，值得挡住面板一次，而不是缩在边上被忽略。
 *   - **只有一个按钮**：卡片里只有「关闭」；点遮罩不关（避免误触把提示弄丢），Esc 关。
 *   - **版本跨栏**：pending 记号里存了 from / to，两枚等宽版本号直接摆出来，标题只说结论；
 *     没有旧版本（首次安装）时整行隐藏，标题退回「已更新到 v{version}」。
 *   - **不常驻**：点「关闭」才收起并清掉记号，不自动消失。
 */
import { h, React } from './ui.js';
import type { Translate } from './i18n.js';

export interface RestoreNoticeProps {
  t: Translate;
  /** 目标版本（展示用）；空则只说「更新已安装」。 */
  version?: string;
  /** 更新前版本（展示用）；空或与目标相同则不显示版本跨栏。 */
  from?: string;
  /** 点「关闭」：收起提示并清除记号。 */
  onDismiss: () => void;
}

/** 版本号统一成 `vX.Y.Z` 的写法；空串 / 纯空白返回 undefined。 */
function vLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (text === '') return undefined;
  return text.startsWith('v') ? text : `v${text}`;
}

const ARROW = h(
  'svg',
  {
    width: 14,
    height: 14,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  },
  h('path', { d: 'M3 8h9' }),
  h('polyline', { points: '8.5 4.5 12 8 8.5 11.5' }),
);

export function RestoreNotice({ t, version, from, onDismiss }: RestoreNoticeProps): any {
  const fromLabel = vLabel(from);
  const toLabel = vLabel(version);
  const pair = fromLabel !== undefined && toLabel !== undefined && fromLabel !== toLabel;

  // 有旧版本时标题只说结论（版本已经在跨栏里）；否则退回带版本号的写法。
  const title = pair
    ? t('restoreNotice.titleInstalled')
    : toLabel !== undefined
      ? t('restoreNotice.title', { version: toLabel.replace(/^v/, '') })
      : t('restoreNotice.titleBare');

  // Esc 关闭：焦点初始在「关闭」按钮上，document 级监听兜住焦点跑到别处的情况。
  React.useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onKeyDown = (event: any): void => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onDismiss]);

  return h(
    'div',
    { className: 'dshgt-restore-mask' },
    h(
      'div',
      {
        className: 'dshgt-restore',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'dshgt-restore-title',
      },
      pair
        ? h(
            'div',
            { className: 'dshgt-restore-versions' },
            h('span', { className: 'dshgt-restore-version' }, fromLabel),
            h('span', { className: 'dshgt-restore-arrow' }, ARROW),
            h('span', { className: 'dshgt-restore-version is-new' }, toLabel),
          )
        : null,
      h('div', { className: 'dshgt-restore-title', id: 'dshgt-restore-title' }, title),
      h('p', { className: 'dshgt-restore-body' }, t('restoreNotice.body')),
      h(
        'div',
        { className: 'dshgt-restore-foot' },
        h(
          'button',
          { type: 'button', className: 'dshgt-restore-close', autoFocus: true, onClick: () => onDismiss() },
          t('restoreNotice.dismiss'),
        ),
      ),
    ),
  );
}
