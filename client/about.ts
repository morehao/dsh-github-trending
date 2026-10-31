/**
 * 关于弹层：包名、版本、GitHub 仓库、许可、核心与运行环境，以及**插件自更新**。
 *
 * 数据全部来自 `/state.plugin` / `/state.core` / `/update`，不从客户端猜版本；仓库缺失时
 * 隐藏外链，不拼一个可能 404 的地址。外链一律 `target=_blank rel=noreferrer`。
 *
 * 更新链路：状态机在共享包 `@morehao/dsh-plugin-kit/update/client`，这里只负责渲染与
 * 二次确认（更新会重装插件、重载面板，必须点两次）。
 */
import { createUpdateController, type UpdateClientState, type UpdateController } from '@morehao/dsh-plugin-kit/update/client';

import { applyPluginUpdate, getPluginUpdate, type StatePayload } from './api.js';
import type { Translate } from './i18n.js';
import { Btn, KV, copyText, h, React } from './ui.js';

export function AboutDialog(props: { t: Translate; state: StatePayload; onClose: () => void }): any {
  const { t, state } = props;
  const [copied, setCopied] = React.useState(false);
  const [copiedCommand, setCopiedCommand] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const controllerRef = React.useRef<UpdateController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createUpdateController({
      request: {
        check: (options) => getPluginUpdate(options.fresh === true ? { fresh: true } : {}),
        apply: () => applyPluginUpdate(),
      },
    });
  }
  const controller = controllerRef.current;
  const [updateState, setUpdateState] = React.useState<UpdateClientState>(() => controller.getState());

  React.useEffect(() => {
    const unsubscribe = controller.subscribe(setUpdateState);
    // 打开弹层静默检查一次（Host 侧有 5 分钟缓存，不会每次开都打网络）。
    if (controller.getState().status === 'idle') void controller.check();
    return unsubscribe;
  }, [controller]);

  React.useEffect(() => {
    if (updateState.status === 'applying' || updateState.status === 'restart-required' || updateState.status === 'applied') {
      setConfirming(false);
    }
  }, [updateState.status]);

  const plugin = state.plugin;
  const fullName = `${plugin.name}@v${plugin.version}`;
  const repository = plugin.repository;
  const ownerRepo = repository === undefined ? undefined : repository.replace(/^https?:\/\/github\.com\//, '');
  const repoVersion = ownerRepo === undefined ? undefined : `${ownerRepo}@v${plugin.version}`;

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props]);

  const copy = (): void => {
    void copyText(fullName).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  const copyCommand = (): void => {
    const command = updateState.view?.manualCommand;
    if (command === undefined) return;
    void copyText(command).then((ok) => {
      if (!ok) return;
      setCopiedCommand(true);
      setTimeout(() => setCopiedCommand(false), 1600);
    });
  };

  const view = updateState.view;
  const status = updateState.status;
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
      if (updateState.error?.code === 'CHECK_FAILED') return t('about.update.checkFailed');
      return t('about.update.failed', { message: updateState.error?.message ?? '' });
    }
    if (view.checkFailed) return t('about.update.checkFailed');
    if (view.updateAvailable) return t('about.update.available', { latest: view.latestVersion ?? '', current: view.currentVersion });
    return t('about.update.current', { version: view.currentVersion });
  };

  const updateActions = [
    h(Btn, { key: 'check', small: true, disabled: busy, onClick: () => void controller.check({ fresh: true }) }, t('about.update.check')),
    manual === null
      ? null
      : h(
          Btn,
          { key: 'copy-command', small: true, onClick: copyCommand },
          copiedCommand ? t('about.update.copied') : t('about.update.copy'),
        ),
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

  // 弹层挂在 .dshgt-root 之外会拿不到 --gt-* 变量（背景/边框会变成透明继承），包一层 root 再进 mask。
  const dialog = h(
    'div',
    { className: 'dshgt-modal-mask', onClick: (event: any) => { if (event.target === event.currentTarget) props.onClose(); } },
    h(
      'div',
      { className: 'dshgt-modal dshgt-about', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('about.title') },
      h(
        'div',
        { className: 'dshgt-about-head' },
        h('h3', { className: 'dshgt-about-title' }, t('about.title')),
        h(Btn, { small: true, onClick: () => props.onClose() }, t('about.close')),
      ),
      h(
        'button',
        { type: 'button', className: 'dshgt-about-pkg', onClick: copy, title: t('about.copy') },
        h('span', { className: 'dshgt-mono' }, fullName),
        h('span', { className: 'dshgt-hint' }, copied ? t('about.copied') : t('about.copy')),
      ),
      h(KV, {
        items: [
          [
            t('about.repo'),
            repository === undefined || repoVersion === undefined
              ? h('span', { className: 'dshgt-hint' }, t('about.repo.missing'))
              : h('a', { href: repository, target: '_blank', rel: 'noreferrer' }, repoVersion),
          ],
          [t('about.license'), 'MIT'],
          [t('about.core'), state.core.version === undefined ? '—' : `trendradar ${state.core.version}`],
          [t('about.env'), t('about.env.value')],
        ],
      }),
      h(
        'div',
        { className: 'dshgt-update' },
        h(
          'div',
          { className: 'dshgt-update-head' },
          h('h4', null, t('about.update.title')),
          h('span', { className: 'dshgt-hint' }, t('about.update.hint')),
        ),
        h('p', { className: `dshgt-update-line${status === 'failed' ? ' dshgt-update-err' : ''}` }, statusLine()),
        confirming ? h('p', { className: 'dshgt-update-warn' }, t('about.update.confirm', { version: target })) : null,
        h('div', { className: 'dshgt-update-actions' }, updateActions),
        manual === null
          ? null
          : h(
              'div',
              { className: 'dshgt-update-manual' },
              h('p', { className: 'dshgt-update-warn' }, t('about.update.manual', { kind: view?.installKind ?? 'unknown' })),
              h('code', { className: 'dshgt-update-cmd' }, manual),
            ),
      ),
    ),
  );
  return h('div', { className: 'dshgt-root' }, dialog);
}
