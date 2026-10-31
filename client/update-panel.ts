/**
 * 插件更新区块：关于弹层与概览页共用同一份状态机与交互。
 *
 * 状态机来自 `@morehao/dsh-plugin-kit/update/client`；这里持有**唯一**的 controller
 * （模块级单例），所以「关于」里的检查和「概览」里的检查不会各打一次网络，侧栏红点
 * 也能直接读同一份状态。首次挂载静默检查一次，之后复用 Host 侧 5 分钟缓存。
 */
import { createUpdateController, type UpdateClientState, type UpdateController } from '@morehao/dsh-plugin-kit/update/client';

import { applyPluginUpdate, getPluginUpdate } from './api.js';
import type { Translate } from './i18n.js';
import { Btn, copyText, h, React } from './ui.js';

let singleton: UpdateController | null = null;

export function getUpdateController(): UpdateController {
  if (singleton === null) {
    singleton = createUpdateController({
      request: {
        check: (options) => getPluginUpdate(options.fresh === true ? { fresh: true } : {}),
        apply: () => applyPluginUpdate(),
      },
    });
  }
  return singleton;
}

/** 订阅共享更新状态；首个订阅者挂载时静默检查一次。 */
export function usePluginUpdate(): [UpdateClientState, UpdateController] {
  const controller = getUpdateController();
  const [state, setState] = React.useState<UpdateClientState>(() => controller.getState());
  React.useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    if (controller.getState().status === 'idle') void controller.check();
    return unsubscribe;
  }, [controller]);
  return [state, controller];
}

/** 有新版时的小红点（侧栏包名旁）。 */
export function UpdateDot(props: { t: Translate }): any {
  const [state] = usePluginUpdate();
  if (state.view?.updateAvailable !== true) return null;
  return h('span', { className: 'dshgt-update-dot', title: props.t('update.badge') });
}

export interface PluginUpdateSectionProps {
  t: Translate;
  /** 嵌在卡片里时去掉自身的分隔线，并隐藏说明行。 */
  bare?: boolean;
}

export function PluginUpdateSection(props: PluginUpdateSectionProps): any {
  const { t } = props;
  const [state, controller] = usePluginUpdate();
  const [confirming, setConfirming] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (state.status === 'applying' || state.status === 'restart-required' || state.status === 'applied') setConfirming(false);
  }, [state.status]);

  const copyCommand = (): void => {
    const command = state.view?.manualCommand;
    if (command === undefined) return;
    void copyText(command).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  const view = state.view;
  const status = state.status;
  const target = view !== null && view.updateAvailable ? (view.latestVersion ?? '') : '';
  const busy = status === 'checking' || status === 'applying';
  const settled = status === 'restart-required' || status === 'applied';
  const actionable = view !== null && view.updateAvailable && view.canApply && !settled && !busy;
  const manual = view !== null && (!view.canApply || view.checkFailed) ? view.manualCommand : null;

  const statusLine = (): string => {
    if (status === 'checking' || view === null) return t('about.update.checking');
    if (status === 'applying') return t('about.update.applying', { version: target });
    if (status === 'restart-required') return t('about.update.done', { version: view.latestVersion ?? target });
    if (status === 'applied') return t('about.update.applied', { version: view.latestVersion ?? target });
    if (status === 'failed') {
      if (state.error?.code === 'CHECK_FAILED') return t('about.update.checkFailed');
      return t('about.update.failed', { message: state.error?.message ?? '' });
    }
    if (view.checkFailed) return t('about.update.checkFailed');
    if (view.updateAvailable) return t('about.update.available', { latest: view.latestVersion ?? '', current: view.currentVersion });
    return t('about.update.current', { version: view.currentVersion });
  };

  const actions = [
    h(Btn, { key: 'check', small: true, disabled: busy, onClick: () => void controller.check({ fresh: true }) }, t('about.update.check')),
    manual === null
      ? null
      : h(Btn, { key: 'copy', small: true, onClick: copyCommand }, copied ? t('about.update.copied') : t('about.update.copy')),
    actionable
      ? confirming
        ? [
            h(
              Btn,
              {
                key: 'confirm',
                small: true,
                variant: 'danger',
                onClick: () => {
                  setConfirming(false);
                  void controller.apply();
                },
              },
              t('about.update.confirmYes'),
            ),
            h(Btn, { key: 'cancel', small: true, onClick: () => setConfirming(false) }, t('about.update.cancel')),
          ]
        : h(Btn, { key: 'apply', small: true, variant: 'primary', onClick: () => setConfirming(true) }, t('about.update.apply', { version: target }))
      : null,
  ].filter((item) => item !== null);

  return h(
    'div',
    { className: `dshgt-update${props.bare === true ? ' dshgt-update-bare' : ''}` },
    props.bare === true
      ? null
      : h(
          'div',
          { className: 'dshgt-update-head' },
          h('h4', null, t('about.update.title')),
          h('span', { className: 'dshgt-hint' }, t('about.update.hint')),
        ),
    h('p', { className: `dshgt-update-line${status === 'failed' ? ' dshgt-update-err' : ''}` }, statusLine()),
    confirming ? h('p', { className: 'dshgt-update-warn' }, t('about.update.confirm', { version: target })) : null,
    h('div', { className: 'dshgt-update-actions' }, actions),
    manual === null
      ? null
      : h(
          'div',
          { className: 'dshgt-update-manual' },
          h('p', { className: 'dshgt-update-warn' }, t('about.update.manual', { kind: view?.installKind ?? 'unknown' })),
          h('code', { className: 'dshgt-update-cmd' }, manual),
        ),
  );
}
