/**
 * 自更新后的「恢复提示」：横跨面板顶部的一条醒目提示条（不自动消失）。
 *
 * 插件一键更新会先卸载自己，面板随之消失，「请重启」的提示也会一起没掉。把「我刚点了更新」
 * 记进 localStorage（见 update-store 的 pending 记号），重开的新进程读到它就在这里渲染一句
 * 「更新已安装、请彻底退出 DSH 再打开生效」——这是唯一能承载这句话的位置。
 *
 * 设计约定：
 *   - **醒目、放在正文顶部**：它是一条需要用户照做的操作指令，不该缩在右下角被忽略；
 *   - **不常驻**：只有点「知道了」（或点面板里的「退出并重启」）才收起并清掉记号，
 *     避免用户没读懂就被自动收走、下次又悄无声息地出现。
 */
import { Btn, h } from './ui.js';
import type { Translate } from './i18n.js';

export interface RestoreNoticeProps {
  t: Translate;
  /** 目标版本（展示用）；空则只说「已更新」。 */
  version?: string;
  /** 点「知道了」：收起提示并清除记号。 */
  onDismiss: () => void;
  /** 点「退出并重启」：宿主可用时尝试一键重启；不可用时退回 onDismiss。 */
  onRestart?: () => void;
}

export function RestoreNotice({ t, version, onDismiss, onRestart }: RestoreNoticeProps): any {
  const title = version !== undefined && version !== '' ? t('restoreNotice.title', { version }) : t('restoreNotice.titleBare');
  return h(
    'div',
    { className: 'dshgt-restore', role: 'status', 'aria-live': 'polite' },
    h('span', { className: 'dshgt-restore-icon', 'aria-hidden': 'true' }, '⟳'),
    h(
      'div',
      { className: 'dshgt-restore-text' },
      h('div', { className: 'dshgt-restore-title' }, title),
      h('div', { className: 'dshgt-restore-body' }, t('restoreNotice.body')),
    ),
    h(
      'div',
      { className: 'dshgt-restore-actions' },
      onRestart === undefined ? null : h(Btn, { small: true, variant: 'primary', onClick: () => onRestart() }, t('restoreNotice.restart')),
      h(Btn, { small: true, onClick: () => onDismiss() }, t('restoreNotice.dismiss')),
    ),
  );
}
