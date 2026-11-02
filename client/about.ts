/**
 * 关于弹层：包名@版本、GitHub 仓库、许可、核心仓库与运行环境。
 *
 * 数据全部来自 `/state.plugin` / `/state.core`，不从客户端猜版本；仓库缺失时
 * 隐藏外链，不拼一个可能 404 的地址。外链一律 `target=_blank rel=noreferrer`。
 *
 * 这里不再承载「检查更新」：更新入口只在顶部身份条，避免关于弹层既当信息页
 * 又当更新操作页。包名行没有独立复制按钮，整行点击即复制 `包名@版本`。
 */
import type { StatePayload } from './api.js';
import type { Translate } from './i18n.js';
import { Btn, KV, copyText, h, React } from './ui.js';

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

export function AboutDialog(props: { t: Translate; state: StatePayload; onClose: () => void }): any {
  const { t, state } = props;
  const [copied, setCopied] = React.useState(false);
  const plugin = state.plugin;
  const fullName = `${plugin.name}@${plugin.version}`;
  const repository = plugin.repository;
  const ownerRepo = repository === undefined ? undefined : repository.replace(/^https?:\/\/github\.com\//, '');
  const core = state.core;
  const coreVersion = core.version === undefined ? '' : `trendradar ${core.version}`;
  const coreRepo = core.repository;
  const coreOwnerRepo = coreRepo === undefined ? undefined : coreRepo.replace(/^https?:\/\/github\.com\//, '');

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props]);

  // 没有独立的复制按钮：整行点击即复制「包名@版本」（与身份条的包名点击行为一致），
  // 复制成功后整行边框短暂转绿并出现「已复制」字样。
  const copy = (): void => {
    void copyText(fullName).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  // 核心仓库：与插件仓库同一风格，展示 owner/repo + 版本；没有仓库地址时
  // 退回版本号（或占位符），不拼可能 404 的链接。
  const coreValue = (): any => {
    if (coreRepo !== undefined && coreOwnerRepo !== undefined) {
      const label = core.version === undefined ? coreOwnerRepo : `${coreOwnerRepo}@${core.version}`;
      return h(
        'span',
        { className: 'dshgt-about-core' },
        h('a', { href: coreRepo, target: '_blank', rel: 'noreferrer' }, label),
        h(
          'a',
          { className: 'dshgt-about-gh', href: coreRepo, target: '_blank', rel: 'noreferrer', title: t('about.core.repo'), 'aria-label': t('about.core.repo') },
          githubIcon(),
        ),
      );
    }
    return coreVersion === '' ? '—' : coreVersion;
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
        {
          type: 'button',
          className: `dshgt-about-pkg${copied ? ' is-copied' : ''}`,
          title: copied ? t('about.copied') : t('about.copy'),
          'aria-label': `${t('about.copy')}: ${fullName}`,
          onClick: copy,
        },
        h('span', { className: 'dshgt-about-pkg-name dshgt-mono' }, fullName),
        copied ? h('span', { className: 'dshgt-about-pkg-done' }, t('about.copied')) : null,
      ),
      h(KV, {
        items: [
          [
            t('about.repo'),
            repository === undefined || ownerRepo === undefined
              ? h('span', { className: 'dshgt-hint' }, t('about.repo.missing'))
              : h('a', { href: repository, target: '_blank', rel: 'noreferrer' }, ownerRepo),
          ],
          [t('about.license'), 'MIT'],
          [t('about.core'), coreValue()],
          [t('about.env'), t('about.env.value')],
        ],
      }),
    ),
  );
  return h('div', { className: 'dshgt-root' }, dialog);
}
