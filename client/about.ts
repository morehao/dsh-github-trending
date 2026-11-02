/**
 * 关于弹层（居中定稿）：上方居中的应用身份（logo / 名称 / 版本），一条分割线后是
 * 左对齐的信息表（包名 / GitHub 仓库 / 核心 / 许可）。
 *
 * 数据全部来自 `/state.plugin` / `/state.core`，不从客户端猜版本；仓库缺失时
 * 隐藏外链，不拼一个可能 404 的地址。外链一律 `target=_blank rel=noreferrer`。
 *
 * 交互约定（经用户逐版确认）：
 *   - 不承载「检查更新」：更新入口只在顶部身份条；
 *   - 包名行整行点击即复制「包名@版本」，不放独立复制按钮，复制后行尾短暂显示「已复制」；
 *   - 核心只展示 owner/repo 并可点开仓库，不带版本号、不单列 GitHub 图标（避免和仓库行抢图标）；
 *   - 不展示「运行环境」——原「DSH Web · Node 插件」不足以描述双 half 形态，直接省略。
 */
import type { StatePayload } from './api.js';
import type { Translate } from './i18n.js';
import { copyText, h, React } from './ui.js';

/** 应用标识：与身份条（identity-bar）同一个 logo，保证「关于」和顶部是同一种身份感。 */
function logo(): any {
  return h(
    'svg',
    { viewBox: '0 0 64 64', 'aria-hidden': 'true' },
    h('rect', { x: 4, y: 4, width: 56, height: 56, rx: 14, fill: '#0d1117' }),
    h('path', {
      d: 'M18 46V22l14 12 14-12v24',
      fill: 'none',
      stroke: '#58a6ff',
      strokeWidth: 4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
    h('circle', { cx: 32, cy: 45, r: 3, fill: '#3fb950' }),
  );
}

export function AboutDialog(props: { t: Translate; state: StatePayload; onClose: () => void }): any {
  const { t, state } = props;
  const [copied, setCopied] = React.useState(false);
  const plugin = state.plugin;
  const fullName = `${plugin.name}@${plugin.version}`;
  const repository = plugin.repository;
  const ownerRepo = repository === undefined ? undefined : repository.replace(/^https?:\/\/github\.com\//, '');
  const core = state.core;
  const coreRepo = core.repository;
  const coreOwnerRepo = coreRepo === undefined ? undefined : coreRepo.replace(/^https?:\/\/github\.com\//, '');

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props]);

  // 包名整行点击复制「包名@版本」；成功后行尾出现「已复制」，1.4s 后恢复。
  const copy = (): void => {
    void copyText(fullName).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  // 包名行：label「包名」+ 等宽值，整行可点，无独立复制按钮。
  const pkgRow = h(
    'dd',
    { className: 'dshgt-about-pkgrow' },
    h(
      'button',
      {
        type: 'button',
        className: `dshgt-about-pkglink${copied ? ' is-copied' : ''}`,
        title: copied ? t('about.copied') : t('about.copy'),
        'aria-label': `${t('about.copy')}: ${fullName}`,
        onClick: copy,
      },
      h('span', { className: 'dshgt-mono dshgt-about-pkglink-name' }, fullName),
      h('span', { className: 'dshgt-about-copied' }, t('about.copied')),
    ),
  );

  // 核心行：仅展示 owner/repo（无版本），整串是外链；没有仓库地址时退回版本号或占位符。
  const coreValue = (): any => {
    if (coreRepo !== undefined && coreOwnerRepo !== undefined) {
      return h('a', { className: 'dshgt-mono', href: coreRepo, target: '_blank', rel: 'noreferrer' }, coreOwnerRepo);
    }
    return core.version === undefined ? '—' : `trendradar ${core.version}`;
  };

  return h(
    'div',
    { className: 'dshgt-root' },
    h(
      'div',
      { className: 'dshgt-modal-mask', onClick: (event: any) => { if (event.target === event.currentTarget) props.onClose(); } },
      h(
        'div',
        { className: 'dshgt-modal dshgt-about', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('about.title') },
        h(
          'div',
          { className: 'dshgt-about-head' },
          h('h3', { className: 'dshgt-about-title' }, t('about.title')),
          h('button', { type: 'button', className: 'dshgt-about-close', onClick: () => props.onClose() }, t('about.close')),
        ),
        h(
          'div',
          { className: 'dshgt-about-identity' },
          h('div', { className: 'dshgt-about-logo' }, logo()),
          h('div', { className: 'dshgt-about-name' }, t('section.title')),
          h('span', { className: 'dshgt-about-ver dshgt-mono' }, `v${plugin.version}`),
        ),
        h(
          'dl',
          { className: 'dshgt-kv dshgt-about-kv' },
          h('dt', null, t('about.pkg')),
          pkgRow,
          h('dt', null, t('about.repo')),
          h(
            'dd',
            null,
            repository === undefined || ownerRepo === undefined
              ? h('span', { className: 'dshgt-hint' }, t('about.repo.missing'))
              : h('a', { href: repository, target: '_blank', rel: 'noreferrer' }, ownerRepo),
          ),
          h('dt', null, t('about.core')),
          h('dd', null, coreValue()),
          h('dt', null, t('about.license')),
          h('dd', null, 'MIT'),
        ),
      ),
    ),
  );
}
