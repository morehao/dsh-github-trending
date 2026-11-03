/**
 * 顶部身份条（A 方案定稿）：插件名称 / 版本 / 完整包名 / GitHub / 检查更新。
 *
 * 包名后面紧跟 GitHub 图标，二者之间用一条竖杠分隔；点包名打开「关于」弹层
 * （许可 / 核心 / 运行环境 + 完整更新区），版本号只是静态信息，不再承担入口。
 * 更新状态复用 update-panel 的共享 controller，与「关于」弹层、概览页是同一份，
 * 不会重复打网络。
 *
 * 更新入口是右侧一枚纯图标刷新按钮（与 GitHub 图标同一形制）：状态靠图标颜色 +
 * 角标 + 旋转表达，文案走 title；有新版本时图标左侧出现目标版本号徽标，点它或图标
 * 弹出确认气泡（两段确认）。与 dsh-skills-console 的页头刷新保持同一套视觉。
 */
import { Btn, h, React } from './ui.js';
import type { Translate } from './i18n.js';
import { usePluginUpdate } from './update-panel.js';
import { writePendingUpdate } from './update-store.js';
import { deriveUpdateUiState, updateStatusLabel } from '@morehao/dsh-plugin-kit/update/client';

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

/** 刷新图标（与 skills-console 同一形状）：圆弧箭头。 */
function refreshIcon(): any {
  return h(
    'svg',
    { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
    h('path', { d: 'M20 12a8 8 0 1 1-2.34-5.66' }),
    h('path', { d: 'M20 4v5h-5' }),
  );
}

export function IdentityBar(props: IdentityBarProps): any {
  const { t, plugin } = props;
  const [confirming, setConfirming] = React.useState(false);
  const [updateState, controller] = usePluginUpdate();
  const view = updateState.view;

  const latestVersion = view === null ? '' : view.latestVersion ?? '';
  const currentVersion = view === null ? plugin.version : view.currentVersion ?? plugin.version;

  // 跨插件一致的状态派生统一走 plugin-kit（与 dsh-skills-console 同一套）：
  //   visual → data-state；showBadge/badgeVersion → 版本徽标；busy/settled/actionable → 交互。
  const ui = deriveUpdateUiState(updateState);
  const label = updateStatusLabel(updateState);
  const busy = ui.busy;
  const actionable = ui.actionable;

  React.useEffect(() => {
    if (!actionable) setConfirming(false);
  }, [actionable]);

  // 语义 key → 本仓文案（plugin-kit 只给「该显示哪条」，文案留在本仓 i18n）。
  const LABEL_COPY: Record<string, string> = {
    checking: t('shell.update.checking'),
    applying: t('shell.update.applying', { version: label.params.version ?? '' }),
    available: t('shell.update.available', { latest: label.params.latest ?? '' }),
    latest: t('shell.update.latest', { version: label.params.version ?? '' }),
    done: t('shell.update.done', { version: label.params.version ?? '' }),
    checkFailed: t('shell.update.checkFailed'),
    failed: t('shell.update.failed'),
  };
  const st = { state: ui.visual, tip: LABEL_COPY[label.key] ?? t('shell.update.latest', { version: currentVersion }) };

  // 点刷新图标：可更新 → 开确认气泡；失败 → 重试；其余 → 检查。
  function onRefreshClick(): void {
    if (busy) return;
    if (actionable) { setConfirming((v) => !v); return; }
    void controller.check({ fresh: true });
  }

  // 「确认更新」：落「刚点过更新」记号后 apply（面板随插件自卸消失，重开靠记号渲染恢复提示）。
  function onConfirmUpdate(): void {
    setConfirming(false);
    writePendingUpdate(currentVersion, latestVersion);
    void controller.apply();
  }

  const showBadge = ui.showBadge;
  const confirmOpen = confirming && actionable;

  return h(
    'div',
    { className: 'dshgt-idbar' },
    h('div', { className: 'dshgt-brand' }, logo(), h('span', { className: 'dshgt-brand-name' }, t('section.title'))),
    h('span', { className: 'dshgt-id-ver dshgt-mono' }, `v${plugin.version}`),
    h('span', { className: 'dshgt-id-sep dshgt-id-sep-pkg' }),
    h(
      'button',
      { type: 'button', className: 'dshgt-id-pkg dshgt-mono', title: t('about.title'), onClick: () => props.onOpenAbout() },
      plugin.name,
    ),
    // 更新入口：版本徽标 + 纯图标刷新，放在 GitHub 图标左侧、与之一组右对齐。
    h(
      'div',
      { className: 'dshgt-idbar-actions' },
      h(
        'div',
        { className: 'dshgt-upd-unit' },
        showBadge
          ? h(
              'button',
              {
                type: 'button',
                className: 'dshgt-ver-badge',
                title: t('shell.update.badgeTitle', { version: latestVersion }),
                'aria-label': t('shell.update.badgeTitle', { version: latestVersion }),
                onClick: () => setConfirming((v) => !v),
              },
              `v${latestVersion}`,
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            className: 'dshgt-id-gh dshgt-refresh',
            'data-state': st.state,
            disabled: busy,
            title: st.tip,
            'aria-label': st.tip,
            'aria-expanded': confirmOpen ? 'true' : undefined,
            onClick: onRefreshClick,
          },
          refreshIcon(),
        ),
      ),
      plugin.repository === undefined
        ? null
        : [
            h('span', { key: 'gh-sep', className: 'dshgt-id-sep dshgt-id-sep-gh' }),
            h('a', { key: 'gh', className: 'dshgt-id-gh', href: plugin.repository, target: '_blank', rel: 'noreferrer', title: t('about.repo'), 'aria-label': t('about.repo') }, githubIcon()),
          ],
      confirmOpen
        ? h(
            'div',
            { className: 'dshgt-confirm-pop', role: 'dialog', 'aria-label': t('shell.update.confirmHint') },
            h('div', { className: 'dshgt-confirm-title' }, t('shell.update.confirmHint')),
            h('div', { className: 'dshgt-confirm-actions' },
              h(Btn, { small: true, onClick: () => setConfirming(false) }, t('shell.update.cancel')),
              h(Btn, { small: true, variant: 'primary', onClick: onConfirmUpdate }, t('shell.update.confirmYes'))),
          )
        : null,
    ),
  );
}
