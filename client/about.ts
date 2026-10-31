/**
 * 关于弹层：包名、版本、GitHub 仓库、许可、核心与运行环境，以及**插件自更新**。
 *
 * 数据全部来自 `/state.plugin` / `/state.core` / `/update`，不从客户端猜版本；仓库缺失时
 * 隐藏外链，不拼一个可能 404 的地址。外链一律 `target=_blank rel=noreferrer`。
 *
 * 更新区不再有标题与说明句，压缩成与右上角身份条同构的一行（状态 + 按钮）；状态的判定与
 * 更新控制器来自 `update-panel.ts` 的 `usePluginUpdate`（模块级单例），所以关于弹层、
 * 概览页与身份条读的是同一份状态，不会重复打网络。
 */
import type { StatePayload } from './api.js';
import type { Translate } from './i18n.js';
import type { UpdateClientState, UpdateController } from '@morehao/dsh-plugin-kit/update/client';
import { Btn, KV, copyText, h, React } from './ui.js';
import { usePluginUpdate } from './update-panel.js';

/** GitHub 图标（16×16，`currentColor`），与身份条用同一个 path。 */
function githubIcon(): any {
  return h('svg', {
    className: 'dshgt-gh',
    viewBox: '0 0 16 16',
    'aria-hidden': 'true',
    dangerouslySetInnerHTML: {
      __html:
        '<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>',
    },
  });
}

/** 更新行的一行文案 + 状态色，文案与身份条（`identity-bar.ts`）保持一致。 */
function updateLine(t: Translate, state: UpdateClientState, fallbackVersion: string): { text: string; kind: 'muted' | 'ok' | 'new' | 'err' } {
  const { status, view, error } = state;
  if (status === 'checking' || view === null) return { text: t('shell.update.checking'), kind: 'muted' };
  if (status === 'applying') return { text: t('shell.update.applying', { version: view.latestVersion ?? '' }), kind: 'muted' };
  if (status === 'restart-required' || status === 'applied') return { text: t('shell.update.done', { version: view.latestVersion ?? '' }), kind: 'ok' };
  if (status === 'failed') return { text: error?.code === 'CHECK_FAILED' ? t('shell.update.checkFailed') : t('shell.update.failed'), kind: 'err' };
  if (view.checkFailed) return { text: t('shell.update.checkFailed'), kind: 'err' };
  if (view.updateAvailable) return { text: t('shell.update.available', { latest: view.latestVersion ?? '' }), kind: 'new' };
  return { text: t('shell.update.latest', { version: view.currentVersion ?? fallbackVersion }), kind: 'ok' };
}

/** 更新行右侧的单个按钮：状态机与身份条一致（更新/确认/复制命令/检查）。 */
function UpdateRow(props: { t: Translate; update: UpdateClientState; controller: UpdateController; fallbackVersion: string }): any {
  const { t, update, controller, fallbackVersion } = props;
  const [confirming, setConfirming] = React.useState(false);
  const [cmdCopied, setCmdCopied] = React.useState(false);

  React.useEffect(() => {
    if (update.status === 'applying' || update.status === 'restart-required' || update.status === 'applied') setConfirming(false);
  }, [update.status]);

  const view = update.view;
  const status = update.status;
  const busy = status === 'checking' || status === 'applying';
  const settled = status === 'restart-required' || status === 'applied';
  const latestVersion = view === null ? '' : view.latestVersion ?? '';
  const actionable = view !== null && view.updateAvailable && view.canApply && !settled && !busy;
  const manual = view !== null && (!view.canApply || view.checkFailed) ? view.manualCommand ?? null : null;
  const line = updateLine(t, update, fallbackVersion);

  const copyCmd = (): void => {
    if (manual === null) return;
    void copyText(manual).then((ok) => {
      if (!ok) return;
      setCmdCopied(true);
      setTimeout(() => setCmdCopied(false), 1400);
    });
  };

  function action(): any {
    if (status === 'applying') return h(Btn, { small: true, disabled: true }, t('shell.update.applyingShort'));
    if (actionable) {
      if (confirming) {
        return [
          h(Btn, { key: 'yes', small: true, variant: 'danger', onClick: () => { setConfirming(false); void controller.apply(); } }, t('shell.update.confirmYes')),
          h(Btn, { key: 'no', small: true, onClick: () => setConfirming(false) }, t('shell.update.cancel')),
        ];
      }
      return h(Btn, { small: true, variant: 'primary', onClick: () => setConfirming(true) }, t('shell.update.apply', { version: latestVersion }));
    }
    if (manual !== null) return h(Btn, { small: true, onClick: copyCmd }, cmdCopied ? t('shell.update.copied') : t('shell.update.copyCmd'));
    return h(Btn, { small: true, disabled: busy, onClick: () => void controller.check({ fresh: true }) }, t('shell.update.check'));
  }

  return h(
    'div',
    { className: 'dshgt-about-upd' },
    h(
      'span',
      { className: `dshgt-about-status ${confirming ? 'new' : line.kind}` },
      confirming ? t('shell.update.confirmHint') : line.text,
    ),
    h('span', { className: 'dshgt-about-actions' }, action()),
  );
}

export function AboutDialog(props: { t: Translate; state: StatePayload; onClose: () => void }): any {
  const { t, state } = props;
  const [copied, setCopied] = React.useState(false);
  const [updateState, updateController] = usePluginUpdate();
  const plugin = state.plugin;
  const fullName = `${plugin.name}@v${plugin.version}`;
  const repository = plugin.repository;
  const ownerRepo = repository === undefined ? undefined : repository.replace(/^https?:\/\/github\.com\//, '');
  const repoVersion = ownerRepo === undefined ? undefined : `${ownerRepo}@v${plugin.version}`;
  const core = state.core;
  const coreVersion = core.version === undefined ? '' : `trendradar ${core.version}`;
  const coreRepo = core.repository;

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props]);

  // 没有「可复制」文字提示：整行点击即复制；复制成功后整行边框短暂转绿示意。
  const copy = (): void => {
    void copyText(fullName).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  // 核心值的展示：有仓库地址时版本号可点 + 尾部 GitHub 图标，两个都是外链；
  // 没地址、也没版本号时给占位符。
  const coreValue = (): any => {
    if (coreVersion === '') return '—';
    if (coreRepo === undefined) return coreVersion;
    return h(
      'span',
      { className: 'dshgt-about-core' },
      h('a', { href: coreRepo, target: '_blank', rel: 'noreferrer' }, coreVersion),
      h(
        'a',
        { className: 'dshgt-about-gh', href: coreRepo, target: '_blank', rel: 'noreferrer', title: t('about.core.repo'), 'aria-label': t('about.core.repo') },
        githubIcon(),
      ),
    );
  };

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
        { type: 'button', className: `dshgt-about-pkg${copied ? ' is-copied' : ''}`, onClick: copy },
        h('span', { className: 'dshgt-mono' }, fullName),
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
          [t('about.core'), coreValue()],
          [t('about.env'), t('about.env.value')],
        ],
      }),
      h(UpdateRow, { t, update: updateState, controller: updateController, fallbackVersion: plugin.version }),
    ),
  );
  return h('div', { className: 'dshgt-root' }, dialog);
}
