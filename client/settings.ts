/**
 * 设置页：内容来源 / 模型 / 仓库 / 认证 / 榜单 / 调度。
 *
 * 编辑在本地 `draft` 里进行，只有点「保存设置」才 POST /config —— 与规格
 * 「禁止静默复制」「保存前预检」一致；快速填充也要用户再点一次「使用这个模型」。
 */
import { Alert, Btn, Card, Chips, Input, KV, Pill, Row, Select, Toggle, duration, h, localTime, React } from './ui.js';
import type { Translate } from './i18n.js';
import { apiCall, type PreflightResult, type ProviderCandidate, type SettingsShape } from './api.js';
import type { StoreValue } from './store.js';

const LANGUAGES = ['all', 'typescript', 'python', 'go', 'rust', 'java', 'c', 'cpp', 'javascript', 'csharp'];

export function SettingsView(props: { t: Translate; store: StoreValue; onClose?: () => void; pickDirectory?: () => Promise<string | undefined> }): any {
  const { t, store } = props;
  const state = store.state;
  const [draft, setDraft] = React.useState<SettingsShape | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [problems, setProblems] = React.useState<Array<{ field: string; message: string }>>([]);
  const [message, setMessage] = React.useState<string | null>(null);
  const [preflight, setPreflight] = React.useState<PreflightResult | null>(null);
  const [preflighting, setPreflighting] = React.useState(false);
  const [rechecking, setRechecking] = React.useState(false);
  const [quickOpen, setQuickOpen] = React.useState(false);

  React.useEffect(() => {
    if (state !== null && !dirty) setDraft(state.settings);
  }, [state, dirty]);

  const update = (mutate: (next: SettingsShape) => void): void => {
    if (draft === null) return;
    const next = JSON.parse(JSON.stringify(draft)) as SettingsShape;
    mutate(next);
    setDraft(next);
    setDirty(true);
    setSaved(false);
  };

  const save = async (): Promise<void> => {
    if (draft === null) return;
    setSaving(true);
    setProblems([]);
    try {
      const result = await apiCall<{ saved: boolean; settings: SettingsShape; problems: Array<{ field: string; message: string }> }>(
        'POST',
        '/config',
        { settings: draft },
      );
      if (result.saved) {
        setDraft(result.settings);
        setDirty(false);
        setSaved(true);
        setMessage(null);
        await store.refresh({ quiet: true });
      } else {
        setProblems(result.problems ?? []);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const runPreflight = async (): Promise<void> => {
    if (draft === null) return;
    setPreflighting(true);
    setPreflight(null);
    try {
      const result = await apiCall<{ preflight: PreflightResult }>('POST', '/preflight', { settings: draft });
      setPreflight(result.preflight);
    } catch (error) {
      setPreflight({ ok: false, message: error instanceof Error ? error.message : String(error), durationMs: 0, mode: draft.model.mode });
    } finally {
      setPreflighting(false);
    }
  };

  const recheck = async (): Promise<void> => {
    setRechecking(true);
    try {
      await apiCall('GET', '/core?fresh=1');
      await store.refresh({ quiet: true });
    } catch {
      // 失败信息由 /state 的 core.message 展示
    } finally {
      setRechecking(false);
    }
  };

  const importCli = async (): Promise<void> => {
    try {
      const result = await apiCall<{ import: { ok: boolean; imported: string[]; skippedSecrets: string[]; problems: string[]; settings?: SettingsShape } }>(
        'POST',
        '/import',
        {},
      );
      const payload = result.import;
      if (payload.ok && payload.settings !== undefined) {
        setDraft(payload.settings);
        setDirty(false);
        setSaved(true);
        setMessage(t('settings.import.done', { fields: payload.imported.join('、') }));
        await store.refresh({ quiet: true });
      } else {
        setMessage(payload.problems[0] ?? t('settings.import.empty'));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const copyConfig = (): void => {
    if (draft === null) return;
    const redacted = JSON.stringify(
      { ...draft, model: { ...draft.model, apiKeyRef: draft.model.apiKeyRef }, github: { ...draft.github } },
      null,
      2,
    );
    void navigator.clipboard?.writeText(redacted).then(() => setMessage(t('settings.copied')));
  };

  if (state === null || draft === null) {
    return h('div', { className: 'dshgt-root' }, h('p', { className: 'dshgt-hint' }, store.error ?? t('quickfill.loading')));
  }

  const providers = state.core.supportedProviders.length > 0 ? state.core.supportedProviders : ['deepseek', 'openai-compatible'];
  const coreKind = state.core.state === 'ready' ? 'ok' : state.core.state === 'incompatible' ? 'warn' : 'err';

  return h(
    'div',
    { className: 'dshgt-root' },
    h(
      'div',
      { className: 'dshgt-head' },
      h('span', { className: 'dshgt-title' }, t('section.title')),
      h('span', { className: 'dshgt-sub' }, t('section.subtitle')),
      h('span', { className: 'dshgt-hint', style: { marginLeft: 'auto' } }, `v${state.plugin.version}`),
    ),

    // ---- 来源与核心 ----
    h(
      Card,
      {
        title: t('card.source.title'),
        hint: t('card.source.hint'),
        extra: h(Btn, { small: true, onClick: () => void recheck(), disabled: rechecking }, rechecking ? t('core.checking') : t('core.recheck')),
      },
      h('p', { className: 'dshgt-desc' }, t('card.source.desc')),
      h(
        Row,
        { label: t('card.source.title') },
        h('span', { className: 'dshgt-pill' }, h('span', { className: 'dshgt-dot ok' }), t('source.local')),
        h('span', { className: 'dshgt-hint' }, t('source.local.hint')),
      ),
      h(
        Row,
        { label: t('core.label') },
        h('span', { className: 'dshgt-pill' }, h('span', { className: `dshgt-dot ${coreKind}` }), state.core.version ?? t(`core.${state.core.state}`)),
        state.core.ipcSchema === undefined
          ? null
          : h('span', { className: 'dshgt-hint dshgt-mono' }, `ipc ${state.core.ipcSchema} · digest ${state.core.digestSchema ?? '?'}`),
        h(
          'span',
          { className: 'dshgt-hint dshgt-mono', title: state.core.path ?? '' },
          state.core.source === 'package' ? t('core.package') : state.core.source === 'env' ? 'TRENDING_DIGEST_CORE' : state.core.path ?? '',
        ),
      ),
      state.core.state === 'ready'
        ? null
        : h(Alert, { kind: 'err', title: t('core.label') }, h('div', null, state.core.message ?? ''), h('div', { className: 'dshgt-hint' }, t('core.order'))),
      h('p', { className: 'dshgt-hint' }, t('core.order')),
      state.coexistence.found
        ? h(Alert, { kind: 'warn', title: t('coexist.title') }, h('div', { className: 'dshgt-mono', style: { fontSize: 12 } }, `${state.coexistence.path ?? ''} ${state.coexistence.version ?? ''}`), h('div', null, state.coexistence.message ?? ''), h('div', { className: 'dshgt-hint' }, t('coexist.hint')))
        : null,
      h(Row, { label: 'TRENDING_DIGEST_CORE' }, h(Input, { mono: true, width: 420, value: draft.corePath, placeholder: '/path/to/trendradar', onInput: (value: string) => update((next) => { next.corePath = value; }) })),
    ),

    // ---- 模型 ----
    h(
      Card,
      {
        title: t('card.model.title'),
        hint: t('card.model.hint'),
        extra: h(Btn, { small: true, variant: 'primary', onClick: () => setQuickOpen(true) }, t('model.quickfill')),
      },
      h('p', { className: 'dshgt-desc' }, t('model.quickfill.desc')),
      h(
        Row,
        { label: t('model.provider') },
        h(Select, {
          value: draft.model.provider,
          options: providers.map((provider) => ({ value: provider, label: provider })),
          onChange: (value: string) => update((next) => { next.model.provider = value; }),
        }),
        h('span', { className: 'dshgt-hint' }, state.model.mode === 'proxy' ? t('model.mode.proxy') : t('model.mode.direct')),
      ),
      h(Row, { label: t('model.baseURL') }, h(Input, {
        mono: true,
        width: 420,
        value: draft.model.baseURL,
        placeholder: t('model.baseURL.placeholder'),
        onInput: (value: string) => update((next) => { next.model.baseURL = value; }),
      })),
      h(
        Row,
        { label: t('model.model') },
        h(Input, {
          mono: true,
          width: 260,
          value: draft.model.model,
          placeholder: t('model.model.placeholder'),
          onInput: (value: string) => update((next) => { next.model.model = value; }),
        }),
        h(Btn, { small: true, onClick: () => void runPreflight(), disabled: preflighting }, preflighting ? t('model.preflighting') : t('model.preflight')),
      ),
      h(
        Row,
        { label: t('model.keyRef') },
        h(Input, { mono: true, width: 220, value: draft.model.apiKeyRef, onInput: (value: string) => update((next) => { next.model.apiKeyRef = value; }) }),
        h(Pill, { kind: state.model.credential.configured ? 'ok' : 'err' },
          state.model.credential.configured ? `${t('auth.configured')}${state.model.credential.source === null ? '' : ` · ${state.model.credential.source}`}` : t('auth.missing'),
        ),
      ),
      h(
        Row,
        { label: t('model.params') },
        h(Input, { mono: true, width: 70, value: String(draft.model.temperature), onInput: (value: string) => update((next) => { next.model.temperature = Number(value) || 0; }) }),
        h(Input, { mono: true, width: 90, value: String(draft.model.maxTokens), onInput: (value: string) => update((next) => { next.model.maxTokens = Math.round(Number(value) || 0); }) }),
        h(Toggle, { checked: draft.model.allowDegraded, label: t('model.allowDegraded'), onChange: (value: boolean) => update((next) => { next.model.allowDegraded = value; }) }),
      ),
      preflight === null
        ? null
        : h(
            Alert,
            { kind: preflight.ok ? 'ok' : 'err', title: preflight.ok ? t('state.ok') : t('error.prefix') },
            h('div', null, `${preflight.mode} · ${duration(preflight.durationMs)}${preflight.endpoint === undefined ? '' : ` · ${preflight.endpoint}`}`),
            preflight.message === undefined ? null : h('div', null, preflight.message),
            preflight.hint === undefined ? null : h('div', { className: 'dshgt-hint' }, preflight.hint),
          ),
    ),

    // ---- 仓库 ----
    h(
      Card,
      { title: t('card.repo.title'), hint: t('card.repo.hint') },
      h(
        Row,
        { label: t('repo.path') },
        h(Input, {
          mono: true,
          width: 380,
          value: draft.repo.path,
          placeholder: t('repo.path.placeholder'),
          onInput: (value: string) => update((next) => { next.repo.path = value; }),
        }),
        props.pickDirectory === undefined
          ? null
          : h(Btn, {
              small: true,
              onClick: () => {
                void props.pickDirectory?.().then((picked) => {
                  if (typeof picked === 'string' && picked !== '') update((next) => { next.repo.path = picked; });
                });
              },
            }, t('repo.pick')),
      ),
      h(
        Row,
        { label: t('repo.baseBranch') },
        h(Input, { mono: true, width: 120, value: draft.repo.baseBranch, onInput: (value: string) => update((next) => { next.repo.baseBranch = value; }) }),
        h('span', { className: 'dshgt-hint' }, t('repo.remote')),
        h(Input, { mono: true, width: 100, value: draft.repo.remote, onInput: (value: string) => update((next) => { next.repo.remote = value; }) }),
        h('span', { className: 'dshgt-hint' }, t('repo.outputDir')),
        h(Input, { mono: true, width: 140, value: draft.output.dir, onInput: (value: string) => update((next) => { next.output.dir = value; }) }),
      ),
      h(
        Row,
        { label: t('repo.commitMode') },
        h(Select, {
          value: draft.repo.commitMode,
          options: [
            { value: 'branch', label: t('repo.commitMode.branch') },
            { value: 'direct', label: t('repo.commitMode.direct') },
          ],
          onChange: (value: string) => update((next) => { next.repo.commitMode = value === 'direct' ? 'direct' : 'branch'; }),
        }),
        h(Toggle, { checked: draft.pr.autoMerge, label: t('repo.autoMerge'), onChange: (value: boolean) => update((next) => { next.pr.autoMerge = value; }) }),
      ),
      h(Row, { label: t('repo.titleTemplate') }, h(Input, {
        mono: true,
        width: 360,
        value: draft.pr.titleTemplate,
        onInput: (value: string) => update((next) => { next.pr.titleTemplate = value; }),
      })),
    ),

    // ---- 认证 ----
    h(
      Card,
      { title: t('card.auth.title'), hint: t('card.auth.hint') },
      h(
        Row,
        { label: t('auth.mode') },
        h(Select, {
          value: draft.github.authMode,
          options: [
            { value: 'device', label: t('auth.device') },
            { value: 'pat', label: t('auth.pat') },
            { value: 'gh', label: t('auth.gh') },
          ],
          onChange: (value: string) => update((next) => { next.github.authMode = value === 'pat' ? 'pat' : value === 'gh' ? 'gh' : 'device'; }),
        }),
        h('span', { className: 'dshgt-hint' }, t('auth.tokenRef')),
        h(Input, { mono: true, width: 180, value: draft.github.tokenRef, onInput: (value: string) => update((next) => { next.github.tokenRef = value; }) }),
        h(Pill, { kind: state.github.configured ? 'ok' : 'warn' }, state.github.configured ? `${t('auth.configured')} · ${state.github.source}` : t('auth.missing')),
      ),
      state.github.configured
        ? null
        : h('p', { className: 'dshgt-hint' }, '未配置 token 时 push / 开 PR 会以 GITHUB_AUTH 失败；试跑（dryRun）不受影响。'),
    ),

    // ---- 榜单 ----
    h(
      Card,
      { title: t('card.scope.title') },
      h(
        Row,
        { label: t('scope.period') },
        h(Select, {
          value: draft.trending.since,
          options: [
            { value: 'daily', label: t('scope.daily') },
            { value: 'weekly', label: t('scope.weekly') },
          ],
          onChange: (value: string) => update((next) => { next.trending.since = value === 'weekly' ? 'weekly' : 'daily'; }),
        }),
        h('span', { className: 'dshgt-hint' }, t('scope.topN')),
        h(Input, { mono: true, width: 70, value: String(draft.trending.topN), onInput: (value: string) => update((next) => { next.trending.topN = Math.round(Number(value) || 0); }) }),
      ),
      h(
        Row,
        { label: t('scope.languages') },
        h(Chips, {
          values: LANGUAGES,
          selected: draft.trending.languages,
          onChange: (next: string[]) => update((draftNext) => { draftNext.trending.languages = next; }),
        }),
      ),
    ),

    // ---- 调度 ----
    h(
      Card,
      { title: t('card.schedule.title'), hint: state.schedule.nextRunAt === undefined ? undefined : `${t('schedule.next')} ${localTime(state.schedule.nextRunAt)}` },
      h(
        Row,
        { label: t('schedule.enabled') },
        h(Toggle, { checked: draft.schedule.enabled, onChange: (value: boolean) => update((next) => { next.schedule.enabled = value; }) }),
        h('span', { className: 'dshgt-hint' }, t('schedule.time')),
        h(Input, { mono: true, width: 110, value: draft.schedule.time, onInput: (value: string) => update((next) => { next.schedule.time = value; }) }),
        h('span', { className: 'dshgt-hint' }, t('schedule.timezone')),
        h(Input, { mono: true, width: 170, value: draft.schedule.timezone, onInput: (value: string) => update((next) => { next.schedule.timezone = value; }) }),
      ),
      h('p', { className: 'dshgt-hint' }, t('schedule.source')),
    ),

    // ---- 保存 / 排障 ----
    problems.length > 0
      ? h(Alert, { kind: 'err', title: t('error.prefix') }, h('ul', { style: { margin: 0, paddingLeft: 16 } }, problems.map((problem, index) => h('li', { key: index }, `${problem.field}：${problem.message}`))))
      : null,
    message === null ? null : h(Alert, { kind: 'ok' }, message),
    h(
      'div',
      { className: 'dshgt-footer' },
      h(Btn, { variant: 'primary', onClick: () => void save(), disabled: saving || !dirty }, saving ? t('settings.saving') : dirty ? t('settings.save') : saved ? t('settings.saved') : t('settings.save')),
      h(Btn, { onClick: () => void importCli() }, t('settings.import')),
      h(Btn, { onClick: copyConfig }, t('settings.copyConfig')),
      state.status.lastRunAt === null ? null : h('span', { className: 'dshgt-hint' }, `上次运行 ${localTime(state.status.lastRunAt)}`),
    ),
    quickOpen
      ? h(QuickFillModal, { t, onClose: () => setQuickOpen(false), onApplied: (settings: SettingsShape) => { setDraft(settings); setDirty(false); setSaved(true); void store.refresh({ quiet: true }); } })
      : null,
  );
}

function QuickFillModal(props: { t: Translate; onClose: () => void; onApplied: (settings: SettingsShape) => void }): any {
  const { t } = props;
  const [providers, setProviders] = React.useState<ProviderCandidate[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = React.useState('');
  const [selectedModel, setSelectedModel] = React.useState('');
  const [applying, setApplying] = React.useState(false);

  React.useEffect(() => {
    void (async () => {
      try {
        const result = await apiCall<{ providers: ProviderCandidate[] }>('GET', '/quickfill');
        setProviders(result.providers);
        const first = result.providers[0];
        if (first !== undefined) {
          setSelectedProvider(first.id);
          setSelectedModel(first.models[0]?.id ?? '');
        }
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        setProviders([]);
      }
    })();
  }, []);

  const current = providers?.find((provider) => provider.id === selectedProvider);
  const apply = async (): Promise<void> => {
    if (current === undefined) return;
    setApplying(true);
    try {
      const result = await apiCall<{ settings: SettingsShape }>('POST', '/quickfill', { providerId: current.id, modelId: selectedModel });
      props.onApplied(result.settings);
      props.onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setApplying(false);
    }
  };

  return h(
    'div',
    { className: 'dshgt-modal-mask', onClick: (event: any) => { if (event.target === event.currentTarget) props.onClose(); } },
    h(
      'div',
      { className: 'dshgt-modal' },
      h('h3', { style: { margin: 0, fontSize: 14 } }, t('quickfill.title')),
      h('p', { className: 'dshgt-hint', style: { margin: 0 } }, t('quickfill.hint')),
      error === null ? null : h(Alert, { kind: 'err' }, error),
      providers === null
        ? h('p', { className: 'dshgt-hint' }, t('quickfill.loading'))
        : providers.length === 0
          ? h('p', { className: 'dshgt-hint' }, t('quickfill.empty'))
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              h(Select, {
                value: selectedProvider,
                options: providers.map((provider) => ({ value: provider.id, label: `${provider.name} (${provider.id})` })),
                onChange: (value: string) => {
                  setSelectedProvider(value);
                  const provider = providers.find((item) => item.id === value);
                  setSelectedModel(provider?.models[0]?.id ?? '');
                },
              }),
              current === undefined
                ? null
                : h(Select, {
                    value: selectedModel,
                    options: current.models.map((model) => ({ value: model.id, label: model.name })),
                    onChange: setSelectedModel,
                  }),
              current === undefined
                ? null
                : h(KV, {
                    items: [
                      ['provider', current.coreProvider],
                      ['baseURL', current.baseURL === '' ? t('label.optional') : current.baseURL],
                      ['credential', current.credential.ref ?? '—'],
                      ['mode', t(`quickfill.mode.${current.credential.mode}`)],
                    ],
                  }),
            ),
      h(
        'div',
        { className: 'dshgt-footer', style: { justifyContent: 'flex-end' } },
        h(Btn, { onClick: props.onClose }, t('quickfill.close')),
        h(Btn, { variant: 'primary', disabled: applying || current === undefined || selectedModel === '', onClick: () => void apply() }, t('quickfill.apply')),
      ),
    ),
  );
}
