/**
 * 顶部身份条（A 方案定稿）：插件名称 / 版本 / 完整包名 / GitHub / 检查更新。
 *
 * 替换旧左侧 rail 底部的「包名 + 版本 + GitHub + 关于」块：把元信息抬到第一行，
 * 主 tab 落到第二行（见 index.ts 的 `.dshgt-tabsbar`）。点击版本号仍可打开「关于」
 * 弹层（许可 / 核心 / 运行环境 + 完整更新区）。更新状态复用 update-panel 的共享
 * controller，与「关于」弹层、概览页是同一份，不会重复打网络。
 */
import { Btn, copyText, h, React } from './ui.js';
import type { Translate } from './i18n.js';
import { usePluginUpdate } from './update-panel.js';

export interface IdentityBarProps {
  t: Translate;
  plugin: { name: string; version: string; repository?: string };
  onOpenAbout: () => void;
}

function logo(): any {
  return h(
    'svg',
    { width: 22, height: 22, viewBox: '0 0 64 64', 'aria-hidden': 'true' },
    h('rect', { x: 4, y: 4, width: 56, height: 56, rx: 14, fill: '#0d1117' }),
    h('path', { d: 'M18 46V22l14 12 14-12v24', fill: 'none', stroke: '#58a6ff', strokeWidth: 4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
    h('circle', { cx: 32, cy: 45, r: 3, fill: '#3fb950' }),
  );
}

function githubIcon(): any {
  return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' }, h('path', {
    d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z',
  }));
}

export function IdentityBar(props: IdentityBarProps): any {
  const { t, plugin } = props;
  const [copied, setCopied] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [cmdCopied, setCmdCopied] = React.useState(false);
  const [updateState, controller] = usePluginUpdate();
  const view = updateState.view;
  const status = updateState.status;

  React.useEffect(() => {
    if (status === 'applying' || status === 'restart-required' || status === 'applied') setConfirming(false);
  }, [status]);

  const copyPkg = (): void => {
    void copyText(plugin.name).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  const busy = status === 'checking' || status === 'applying';
  const settled = status === 'restart-required' || status === 'applied';
  const latestVersion = view === null ? '' : view.latestVersion ?? '';
  const updateAvailable = view !== null && view.updateAvailable;
  const actionable = updateAvailable && view !== null && view.canApply && !settled && !busy;
  const manual = view !== null && (!view.canApply || view.checkFailed) ? view.manualCommand ?? null : null;
  const currentVersion = view === null ? plugin.version : view.currentVersion ?? plugin.version;

  const copyCmd = (): void => {
    if (manual === undefined || manual === null) return;
    void copyText(manual).then((ok) => {
      if (!ok) return;
      setCmdCopied(true);
      setTimeout(() => setCmdCopied(false), 1400);
    });
  };

  function statusLine(): { text: string; kind: string } {
    if (status === 'checking' || view === null) return { text: t('shell.update.checking'), kind: 'muted' };
    if (status === 'applying') return { text: t('shell.update.applying', { version: latestVersion }), kind: 'muted' };
    if (status === 'restart-required' || status === 'applied') return { text: t('shell.update.done', { version: latestVersion }), kind: 'ok' };
    if (status === 'failed') return { text: updateState.error?.code === 'CHECK_FAILED' ? t('shell.update.checkFailed') : t('shell.update.failed'), kind: 'err' };
    if (view.checkFailed) return { text: t('shell.update.checkFailed'), kind: 'err' };
    if (view.updateAvailable) return { text: t('shell.update.available', { latest: view.latestVersion ?? '' }), kind: 'new' };
    return { text: t('shell.update.latest', { version: currentVersion }), kind: 'ok' };
  }

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

  const line = statusLine();

  return h(
    'div',
    { className: 'dshgt-idbar' },
    h('div', { className: 'dshgt-brand' }, logo(), h('span', { className: 'dshgt-brand-name' }, t('section.title'))),
    h('button', { type: 'button', className: 'dshgt-id-ver', title: t('about.title'), onClick: () => props.onOpenAbout() }, `v${plugin.version}`),
    h('span', { className: 'dshgt-id-sep' }),
    h(
      'button',
      { type: 'button', className: 'dshgt-id-pkg dshgt-mono', title: updatedCopyTitle(t, copied), onClick: copyPkg },
      copied ? t('about.copied') : plugin.name,
    ),
    h(
      'div',
      { className: 'dshgt-idbar-right' },
      plugin.repository === undefined
        ? null
        : h('a', { className: 'dshgt-id-gh', href: plugin.repository, target: '_blank', rel: 'noreferrer', title: t('about.repo'), 'aria-label': t('about.repo') }, githubIcon()),
      h(
        'span',
        { className: 'dshgt-id-upd' },
        confirming ? h('span', { className: 'dshgt-id-status new' }, t('shell.update.confirmHint')) : h('span', { className: `dshgt-id-status ${line.kind}` }, line.text),
        h('span', { className: 'dshgt-id-actions' }, action()),
      ),
    ),
  );
}

function updatedCopyTitle(t: Translate, copied: boolean): string {
  return copied ? t('about.copied') : t('about.copy');
}
