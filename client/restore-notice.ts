/**
 * 自更新后的「恢复提示」：一条出现在右下角、约 6 秒后自动消失的提示条。
 *
 * 插件一键更新会先卸载自己，面板随之消失，「请重启」的提示也会一起没掉。把「我刚点了更新」
 * 记进 localStorage（见 update-store 的 pending 记号），重开的新进程读到它就在这里渲染一句
 * 「更新已安装、请彻底退出 DSH 再打开生效」——这是唯一能承载这句话的位置。
 *
 * 它**不常驻**：出现约 6 秒后自动收起（同时清除记号）；用户也可点「知道了」立即收起。
 * trending 没有 react-dom / portal，宿主里现有弹层都用 fixed 定位内联渲染，这里沿用同一做法。
 */
import { Btn, h, React } from './ui.js';
import type { Translate } from './i18n.js';

/** 自动收起前的停留时长（毫秒）。 */
const AUTO_DISMISS_MS = 6000;

export interface RestoreNoticeProps {
  t: Translate;
  /** 目标版本（展示用）；空则只说「已更新」。 */
  version?: string;
  onDismiss: () => void;
}

export function RestoreNotice({ t, version, onDismiss }: RestoreNoticeProps): any {
  React.useEffect(() => {
    const timer = setTimeout(() => onDismiss(), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  const title = version !== undefined && version !== '' ? t('restoreNotice.title', { version }) : t('restoreNotice.titleBare');
  return h(
    'div',
    { className: 'dshgt-restore', role: 'status', 'aria-live': 'polite' },
    h(
      'div',
      { className: 'dshgt-restore-text' },
      h('div', { className: 'dshgt-restore-title' }, title),
      h('div', { className: 'dshgt-restore-body' }, t('restoreNotice.body')),
    ),
    h(
      'div',
      { className: 'dshgt-restore-actions' },
      h(Btn, { small: true, variant: 'primary', onClick: () => onDismiss() }, t('restoreNotice.dismiss')),
    ),
  );
}
