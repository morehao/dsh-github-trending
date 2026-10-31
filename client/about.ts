/**
 * 关于弹层：包名、版本、GitHub 仓库、许可、核心与运行环境，以及**插件自更新**。
 *
 * 数据全部来自 `/state.plugin` / `/state.core` / `/update`，不从客户端猜版本；仓库缺失时
 * 隐藏外链，不拼一个可能 404 的地址。外链一律 `target=_blank rel=noreferrer`。
 *
 * 更新区块与概览页共用 `update-panel.ts` 里的同一份 controller（模块级单例），
 * 弹层本身只负责布局。
 */
import type { StatePayload } from './api.js';
import type { Translate } from './i18n.js';
import { Btn, KV, copyText, h, React } from './ui.js';
import { PluginUpdateSection } from './update-panel.js';

export function AboutDialog(props: { t: Translate; state: StatePayload; onClose: () => void }): any {
  const { t, state } = props;
  const [copied, setCopied] = React.useState(false);
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
      h(PluginUpdateSection, { t }),
    ),
  );
  return h('div', { className: 'dshgt-root' }, dialog);
}
