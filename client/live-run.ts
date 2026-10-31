/**
 * 运行中的粗粒度状态条：只显示开始时间 / 已用时 / 「核心执行中」，不伪造九步进度。
 */
import { Btn, h, localTime } from './ui.js';
import type { Translate } from './i18n.js';
import { formatElapsed, useElapsed, type RunController } from './run-controller.js';

export function LiveRun(props: { t: Translate; controller: RunController; startedAt: string | null }): any {
  const { t, controller } = props;
  const elapsed = useElapsed(props.startedAt, true);
  return h(
    'div',
    { className: 'dshgt-live' },
    h(
      'div',
      { className: 'dshgt-live-top' },
      h('span', { className: 'dshgt-dot warn' }),
      h('b', null, t('overview.live.title')),
      h('span', { className: 'dshgt-spinner', 'aria-hidden': 'true' }),
      h('span', { className: 'dshgt-hint' }, t('overview.live.core')),
      h('span', { className: 'dshgt-live-elapsed' }, formatElapsed(elapsed)),
    ),
    h(
      'div',
      { className: 'dshgt-live-note' },
      h('span', null, t('overview.live.note')),
      props.startedAt === null ? null : h('span', { className: 'dshgt-hint' }, `${t('overview.live.started')} ${localTime(props.startedAt)}`),
    ),
    h(
      'div',
      { className: 'dshgt-live-actions' },
      h(Btn, { small: true, variant: 'danger', onClick: () => void controller.cancel() }, t('run.cancel')),
    ),
  );
}
