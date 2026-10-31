/**
 * 订阅管理：仓库发版订阅列表（数据仓版本化的 `subscriptions.yaml`）。
 *
 * 列表本身**不落 settings.json**，也不由插件直接写仓：全部经核心 `subscribe` IPC
 * 读改（add/remove 只写 `.git/pending`，随下次运行落盘并随产物提交）。
 * 本页只做「展示列表 + 增删」；行为参数在设置页「发版订阅」分区。
 */
import { Alert, Btn, Input, h, React } from './ui.js';
import type { Translate } from './i18n.js';
import { getSubscriptions, postSubscriptions } from './api.js';

export interface SubscriptionsProps {
  t: Translate;
  /** 跳转到设置页「发版订阅」分区。 */
  onOpenSettings: () => void;
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function SubscriptionsView(props: SubscriptionsProps): any {
  const { t } = props;
  const [repos, setRepos] = React.useState<string[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [input, setInput] = React.useState('');
  const [note, setNote] = React.useState<string | null>(null);

  const load = React.useCallback((): void => {
    setError(null);
    getSubscriptions()
      .then((list) => setRepos(list))
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
        setRepos([]);
      });
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const doAdd = (): void => {
    // 允许一次输入多个：逗号 / 空格分隔。
    const candidates = input
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter((item) => item !== '');
    const valid = candidates.filter((item) => REPO_PATTERN.test(item));
    if (valid.length === 0) {
      setError(t('subs.input.invalid'));
      return;
    }
    setBusy('add');
    setError(null);
    setNote(null);
    postSubscriptions('add', valid)
      .then((list) => {
        setRepos(list);
        setInput('');
        setAdding(false);
        setNote(t('subs.add.queued'));
      })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setBusy(null));
  };

  const doRemove = (repo: string): void => {
    setBusy(`remove:${repo}`);
    setError(null);
    setNote(null);
    postSubscriptions('remove', [repo])
      .then((list) => {
        setRepos(list);
        setNote(t('subs.remove.queued'));
      })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setBusy(null));
  };

  const list = repos ?? [];

  return h(
    'div',
    { className: 'dshgt-view dshgt-subs' },
    h(
      'section',
      { className: 'dshgt-block dshgt-subs-card' },
      h(
        'div',
        { className: 'dshgt-subs-head' },
        h('h2', null, t('subs.title')),
        h(
          'div',
          { className: 'dshgt-subs-head-actions' },
          h(Btn, { small: true, variant: 'primary', onClick: () => setAdding(true), disabled: busy !== null || adding }, t('subs.add')),
        ),
      ),
      h('p', { className: 'dshgt-desc' }, t('subs.desc')),

      error === null ? null : h(Alert, { kind: 'err' }, error),
      note === null ? null : h(Alert, { kind: 'ok' }, note),

      repos === null
        ? h('p', { className: 'dshgt-hint' }, t('subs.loading'))
        : list.length === 0
          ? h('div', { className: 'dshgt-empty' }, t('subs.empty'))
          : h(
              'div',
              { className: 'dshgt-subs-list' },
              h(
                'div',
                { className: 'dshgt-subs-row dshgt-subs-row-head' },
                h('span', null, t('subs.col.repo')),
                h('span', null, ''),
              ),
              list.map((repo) =>
                h(
                  'div',
                  { className: 'dshgt-subs-row', key: repo },
                  h('span', { className: 'dshgt-mono dshgt-subs-repo' }, repo),
                  h(
                    'span',
                    { className: 'dshgt-subs-actions' },
                    h(
                      Btn,
                      { small: true, variant: 'danger', onClick: () => doRemove(repo), disabled: busy !== null },
                      busy === `remove:${repo}` ? t('subs.removing') : t('subs.remove'),
                    ),
                  ),
                ),
              ),
            ),

      adding
        ? h(
            'div',
            { className: 'dshgt-subs-add' },
            h('div', { className: 'dshgt-hint' }, t('subs.add.hint')),
            h(
              'div',
              { className: 'dshgt-subs-add-row' },
              h(Input, {
                mono: true,
                width: 320,
                value: input,
                placeholder: t('subs.add.placeholder'),
                onInput: (value: string) => setInput(value),
              }),
              h(Btn, { small: true, variant: 'primary', onClick: doAdd, disabled: busy !== null }, busy === 'add' ? t('subs.adding') : t('subs.add.confirm')),
              h(Btn, { small: true, onClick: () => { setAdding(false); setInput(''); setError(null); } }, t('subs.cancel')),
            ),
            h('p', { className: 'dshgt-hint' }, t('subs.add.note')),
          )
        : null,
    ),

    h(
      'section',
      { className: 'dshgt-block' },
      h('p', { className: 'dshgt-hint' }, t('subs.param.hint')),
      h(Btn, { small: true, onClick: props.onOpenSettings }, t('subs.param.link')),
    ),
  );
}
