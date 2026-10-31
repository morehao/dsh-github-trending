/**
 * 设置页：内容来源 / 模型 / 仓库 / 认证 / 榜单 / 调度。
 *
 * 版式是「左侧纵向 tab + 右侧可滚动分区」，避免整页一长条、宿主裁掉且不出滚动条。
 * 编辑在本地 `draft` 里进行，只有点「保存设置」才 POST /config —— 与规格
 * 「禁止静默复制」「保存前预检」一致；快速填充也要用户再点一次确认。
 *
 * 只暴露普通用户需要的字段：「内容来源」是状态与核心操作（重新检查 / 下载），
 * 没有可编辑项，因此不出现「保存本页」；`TRENDING_DIGEST_CORE` 不提供界面入口
 * （需要时用环境变量或直接改 settings.json），手动 `凭据引用` 也不露出（由快速
 * 填充自动带入）。避免把开发/排障概念摊在首屏，也避免出现「点了没反应」的开关。
 */
import { Alert, Btn, Card, Chips, Input, KV, Pill, Row, Select, Toggle, duration, h, localTime, React } from './ui.js';
import type { Translate } from './i18n.js';
import {
  apiCall,
  type DefaultSelection,
  type GithubProbeResult,
  type Period,
  type PreflightResult,
  type QuickfillResponse,
  type RepoBranchResult,
  type SettingsShape,
} from './api.js';
import type { StoreValue } from './store.js';
import { credentialView } from './credential.js';

const LANGUAGES = ['all', 'typescript', 'python', 'go', 'rust', 'java', 'c', 'cpp', 'javascript', 'csharp'];

type SectionId = 'source' | 'model' | 'repo' | 'auth' | 'scope' | 'schedule';

/** 分区顺序，与左侧 tab 一致；用于「是否还有未保存改动」的判定。 */
const SECTIONS: SectionId[] = ['source', 'model', 'repo', 'auth', 'scope', 'schedule'];

const EMPTY_DIRTY: Record<SectionId, boolean> = { source: false, model: false, repo: false, auth: false, scope: false, schedule: false };

function cloneSettings(settings: SettingsShape): SettingsShape {
  return JSON.parse(JSON.stringify(settings)) as SettingsShape;
}

/** 一个分区实际包含的设置字段（repo 分区同时承载输出目录与 PR 自动合并开关）。 */
function sectionSlice(settings: SettingsShape, section: SectionId): Record<string, unknown> {
  switch (section) {
    case 'source':
      return { corePath: settings.corePath };
    case 'model':
      return { model: settings.model };
    case 'repo':
      return { repo: settings.repo, pr: settings.pr, output: settings.output };
    case 'auth':
      return { github: settings.github };
    case 'scope':
      return { trending: settings.trending };
    case 'schedule':
      return { schedule: settings.schedule };
  }
}

function sectionEquals(a: SettingsShape, b: SettingsShape, section: SectionId): boolean {
  return JSON.stringify(sectionSlice(a, section)) === JSON.stringify(sectionSlice(b, section));
}

/** 只把 `section` 的字段从 `source` 覆盖到 `target`，保留其它分区里尚未保存的编辑。 */
function applySection(target: SettingsShape, source: SettingsShape, section: SectionId): SettingsShape {
  const next = cloneSettings(target);
  Object.assign(next, sectionSlice(source, section));
  return next;
}

export function SettingsView(props: { t: Translate; store: StoreValue; onClose?: () => void; pickDirectory?: () => Promise<string | undefined> }): any {
  const { t, store } = props;
  const state = store.state;
  const [draft, setDraft] = React.useState<SettingsShape | null>(null);
  const [dirtySections, setDirtySections] = React.useState<Record<SectionId, boolean>>({ ...EMPTY_DIRTY });
  const [savingSection, setSavingSection] = React.useState<SectionId | null>(null);
  const [savedSection, setSavedSection] = React.useState<SectionId | null>(null);
  const [problems, setProblems] = React.useState<Array<{ field: string; message: string }>>([]);
  const [message, setMessage] = React.useState<string | null>(null);
  const [preflight, setPreflight] = React.useState<PreflightResult | null>(null);
  const [preflighting, setPreflighting] = React.useState(false);
  const [rechecking, setRechecking] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);
  const [quickOpen, setQuickOpen] = React.useState(false);
  const [section, setSection] = React.useState<SectionId>('source');
  const [branchInfo, setBranchInfo] = React.useState<RepoBranchResult | null>(null);
  const [branchLoading, setBranchLoading] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [githubTest, setGithubTest] = React.useState<GithubProbeResult | null>(null);

  const anyDirty = SECTIONS.some((id) => dirtySections[id]);
  // 「内容来源」只有状态与核心操作（重新检查 / 下载），没有可保存的字段。
  const sectionEditable = section !== 'source';

  React.useEffect(() => {
    if (state !== null && !anyDirty) setDraft(state.settings);
  }, [state, anyDirty]);

  // 切到别的分区时清掉上一分区残留的校验错误。
  React.useEffect(() => {
    setProblems([]);
  }, [section]);

  const repoPath = draft === null ? '' : draft.repo.path;

  // 读仓库默认分支（只读展示）：路径变化时重新读取，不写任何状态。
  React.useEffect(() => {
    if (repoPath.trim() === '') {
      setBranchInfo(null);
      return () => undefined;
    }
    let cancelled = false;
    setBranchLoading(true);
    apiCall<{ repo: RepoBranchResult }>('GET', `/repo/branch?path=${encodeURIComponent(repoPath)}`)
      .then((result) => {
        if (!cancelled) setBranchInfo(result.repo);
      })
      .catch((error) => {
        if (!cancelled) setBranchInfo({ source: 'none', message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        if (!cancelled) setBranchLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  const update = (mutate: (next: SettingsShape) => void): void => {
    if (draft === null) return;
    const prev = draft;
    const next = cloneSettings(draft);
    mutate(next);
    setDraft(next);
    const changed = SECTIONS.filter((id) => !sectionEquals(prev, next, id));
    if (changed.length > 0) {
      setDirtySections((current) => {
        const merged = { ...current };
        for (const id of changed) merged[id] = true;
        return merged;
      });
      setSavedSection((current) => (current !== null && changed.includes(current) ? null : current));
      setProblems([]);
    }
  };

  const save = async (section: SectionId): Promise<void> => {
    if (draft === null) return;
    setSavingSection(section);
    setProblems([]);
    try {
      const result = await apiCall<{ saved: boolean; settings: SettingsShape; problems: Array<{ field: string; message: string }> }>(
        'POST',
        '/config',
        { settings: draft, section },
      );
      if (result.saved) {
        // 只回填本分区的规范化结果，保留其它分区里尚未保存的编辑。
        setDraft((current) => (current === null ? current : applySection(current, result.settings, section)));
        setDirtySections((current) => ({ ...current, [section]: false }));
        setSavedSection(section);
        setMessage(null);
        await store.refresh({ quiet: true });
      } else {
        setProblems(result.problems ?? []);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingSection(null);
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

  const downloadCore = async (): Promise<void> => {
    setDownloading(true);
    setProblems([]);
    setMessage(null);
    try {
      await apiCall('POST', '/core/download', {});
      setMessage(t('core.downloaded'));
      await store.refresh({ quiet: true });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setDownloading(false);
    }
  };

  const testGithub = async (): Promise<void> => {
    if (draft === null) return;
    setTesting(true);
    setGithubTest(null);
    try {
      const result = await apiCall<{ github: GithubProbeResult }>('POST', '/github/test', { settings: draft });
      setGithubTest(result.github);
    } catch (error) {
      setGithubTest({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
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
        setDirtySections({ ...EMPTY_DIRTY });
        setSavedSection(null);
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

  const branchText = branchLoading
    ? t('branch.loading')
    : branchInfo?.branch !== undefined
      ? branchInfo.branch
      : draft.repo.baseBranch !== ''
        ? draft.repo.baseBranch
        : '—';
  const branchHint =
    branchInfo?.source === 'origin-head'
      ? t('branch.fromOrigin')
      : branchInfo?.source === 'head'
        ? t('branch.fromHead')
        : branchInfo?.message !== undefined
          ? branchInfo.message
          : t('branch.readonlyHint');

  const isGh = draft.github.authMode === 'gh';

  const sections: Array<{ id: SectionId; label: string }> = [
    { id: 'source', label: t('st.source') },
    { id: 'model', label: t('st.model') },
    { id: 'repo', label: t('st.repo') },
    { id: 'auth', label: t('st.auth') },
    { id: 'scope', label: t('st.scope') },
    { id: 'schedule', label: t('st.schedule') },
  ];

  const sourceCard = h(
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
      state.core.release === undefined
        ? null
        : h('span', { className: 'dshgt-hint dshgt-mono' }, `${state.core.release.tag} · ${state.core.release.asset}`),
      h(
        'span',
        { className: 'dshgt-hint' },
        state.core.download.state === 'override'
          ? t('core.override', { path: state.core.override?.path ?? '' })
          : state.core.release?.cached === true
            ? t('core.cached')
            : t('core.notDownloaded'),
      ),
      state.core.download.state === 'override'
        ? null
        : h(Btn, { small: true, onClick: () => void downloadCore(), disabled: downloading },
            downloading ? t('core.downloading') : state.core.release?.cached === true ? t('core.redownload') : t('core.download')),
    ),
    state.core.release === undefined
      ? null
      : h('p', { className: 'dshgt-hint dshgt-mono', style: { fontSize: 11 } }, `${state.core.release.url}  →  ${state.core.release.binaryPath}`),
    state.core.state === 'ready'
      ? null
      : h(Alert, { kind: 'err', title: t('core.label') }, h('div', null, state.core.message ?? ''), h('div', { className: 'dshgt-hint' }, t('core.order'))),
    h('p', { className: 'dshgt-hint' }, t('core.order')),
    state.coexistence.found
      ? h(Alert, { kind: 'warn', title: t('coexist.title') }, h('div', { className: 'dshgt-mono', style: { fontSize: 12 } }, `${state.coexistence.path ?? ''} ${state.coexistence.version ?? ''}`), h('div', null, state.coexistence.message ?? ''), h('div', { className: 'dshgt-hint' }, t('coexist.hint')))
      : null,
  );

  // 用 draft 的 mode + 服务端解析结果合成文案：刚点完「沿用 DSH 配置」还没保存时，
  // 也应该先看到「沿用 DSH 凭据」，而不是旧模式下的「未配置」。
  const modelCredential = credentialView({ mode: draft.model.mode, credential: state.model.credential }, t);
  const modelCard = h(
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
      h('span', { className: 'dshgt-hint' }, draft.model.mode === 'proxy' ? t('model.mode.proxy') : t('model.mode.direct')),
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
      { label: t('model.credential') },
      h(Pill, { kind: modelCredential.kind }, modelCredential.label),
      h('span', { className: 'dshgt-hint' }, modelCredential.hint),
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
  );

  const repoCard = h(
    Card,
    { title: t('card.repo.title'), hint: t('card.repo.hint') },
    h(
      Row,
      { label: t('repo.path') },
      h('span', { className: 'dshgt-mono', style: { wordBreak: 'break-all' } }, draft.repo.path === '' ? t('repo.path.empty') : draft.repo.path),
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
      h('span', { className: 'dshgt-mono' }, branchText),
      h('span', { className: 'dshgt-hint' }, branchHint),
    ),
    h(
      Row,
      { label: t('repo.outputDir') },
      h(Input, { mono: true, width: 200, value: draft.output.dir, onInput: (value: string) => update((next) => { next.output.dir = value; }) }),
      h('span', { className: 'dshgt-hint' }, t('repo.outputDir.hint')),
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
  );

  const authCard = h(
    Card,
    { title: t('card.auth.title'), hint: t('card.auth.hint') },
    h(
      Row,
      { label: t('auth.mode') },
      h(Select, {
        value: draft.github.authMode,
        options: [
          { value: 'gh', label: t('auth.gh') },
          { value: 'pat', label: t('auth.pat') },
        ],
        onChange: (value: string) => update((next) => { next.github.authMode = value === 'pat' ? 'pat' : 'gh'; }),
      }),
      h(Pill, { kind: state.github.configured ? 'ok' : 'warn' }, state.github.configured ? `${t('auth.configured')} · ${state.github.source}` : t('auth.missing')),
    ),
    h('p', { className: 'dshgt-hint' }, isGh ? t('auth.gh.hint') : t('auth.pat.hint')),
    isGh
      ? null
      : h(
          Row,
          { label: t('auth.tokenRef') },
          h(Input, { mono: true, width: 220, value: draft.github.tokenRef, placeholder: 'GITHUB_TOKEN', onInput: (value: string) => update((next) => { next.github.tokenRef = value; }) }),
          h('span', { className: 'dshgt-hint' }, t('auth.tokenRef.hint')),
        ),
    h(
      Row,
      { label: t('auth.test') },
      h(Btn, { small: true, onClick: () => void testGithub(), disabled: testing }, testing ? t('auth.testing') : t('auth.test')),
      githubTest === null
        ? null
        : h(Pill, { kind: githubTest.ok ? 'ok' : 'err' },
            githubTest.ok
              ? `${t('auth.test.ok')}${githubTest.login === undefined ? '' : ` · @${githubTest.login}`}`
              : githubTest.message ?? t('auth.test.fail'),
          ),
    ),
  );

  const scopeCard = h(
    Card,
    { title: t('card.scope.title') },
    h(
      Row,
      { label: t('scope.period') },
      h(
        'div',
        { className: 'dshgt-period-list' },
        ...(['daily', 'weekly', 'monthly'] as Period[]).map((period) =>
          h(
            'div',
            { key: period, className: 'dshgt-period' },
            h('span', { className: 'dshgt-period-check' }, '✓'),
            h('span', null, t(`scope.${period}`)),
          ),
        ),
      ),
    ),
    h(
      Row,
      { label: t('scope.topN') },
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
  );

  const scheduleCard = h(
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
    h(
      Row,
      { label: t('schedule.periods') },
      ...(['daily', 'weekly', 'monthly'] as Period[]).map((period) =>
        h(Toggle, {
          key: period,
          checked: draft.schedule.periods.includes(period),
          onChange: (on: boolean) => update((next) => {
            const set = new Set(next.schedule.periods);
            if (on) set.add(period); else set.delete(period);
            next.schedule.periods = (['daily', 'weekly', 'monthly'] as Period[]).filter((p) => set.has(p));
          }),
          label: t(`scope.${period}`),
        }),
      ),
    ),
    h('p', { className: 'dshgt-hint' }, t('schedule.source')),
  );

  const currentCard =
    section === 'source' ? sourceCard
      : section === 'model' ? modelCard
        : section === 'repo' ? repoCard
          : section === 'auth' ? authCard
            : section === 'scope' ? scopeCard
              : scheduleCard;

  return h(
    'div',
    { className: 'dshgt-settings' },
    h(
      'nav',
      { className: 'dshgt-vtabs', role: 'tablist', 'aria-orientation': 'vertical' },
      sections.map((item) =>
        h(
          'button',
          {
            key: item.id,
            type: 'button',
            className: 'dshgt-vtab',
            role: 'tab',
            'aria-selected': section === item.id ? 'true' : 'false',
            onClick: () => setSection(item.id),
          },
          item.label,
          dirtySections[item.id] ? h('span', { className: 'dshgt-vtab-dirty', title: t('settings.dirty') }) : null,
        ),
      ),
    ),
    h(
      'div',
      { className: 'dshgt-vpanel' },
      currentCard,
      problems.length > 0
        ? h(Alert, { kind: 'err', title: t('error.prefix') }, h('ul', { style: { margin: 0, paddingLeft: 16 } }, problems.map((problem, index) => h('li', { key: index }, `${problem.field}：${problem.message}`))))
        : null,
      message === null ? null : h(Alert, { kind: 'ok' }, message),
      h(
        'div',
        { className: 'dshgt-footer' },
        sectionEditable
          ? h(
              Btn,
              {
                variant: 'primary',
                onClick: () => void save(section),
                disabled: savingSection !== null || !dirtySections[section],
                title: t('settings.saveSection.hint'),
              },
              savingSection === section
                ? t('settings.saving')
                : dirtySections[section]
                  ? t('settings.saveSection')
                  : savedSection === section
                    ? t('settings.saved')
                    : t('settings.saveSection'),
            )
          : null,
        sectionEditable ? h('span', { className: 'dshgt-hint' }, t('settings.saveSection.hint')) : null,
        h(Btn, { onClick: () => void importCli() }, t('settings.import')),
        h(Btn, { onClick: copyConfig }, t('settings.copyConfig')),
      ),
    ),
    quickOpen
      ? h(QuickFillModal, { t, onClose: () => setQuickOpen(false), onApplied: (settings: SettingsShape) => { setDraft(settings); setDirtySections({ ...EMPTY_DIRTY }); setSavedSection(null); void store.refresh({ quiet: true }); } })
      : null,
  );
}

function QuickFillModal(props: { t: Translate; onClose: () => void; onApplied: (settings: SettingsShape) => void }): any {
  const { t } = props;
  const [data, setData] = React.useState<QuickfillResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = React.useState('');
  const [selectedModel, setSelectedModel] = React.useState('');
  const [applying, setApplying] = React.useState<string | null>(null);
  const [showOthers, setShowOthers] = React.useState(false);

  React.useEffect(() => {
    void (async () => {
      try {
        const result = await apiCall<QuickfillResponse>('GET', '/quickfill');
        setData(result);
        const first = result.providers[0];
        if (first !== undefined) {
          setSelectedProvider(first.id);
          setSelectedModel(first.models[0]?.id ?? '');
        }
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        setData({ providers: [], defaultSelection: null });
      }
    })();
  }, []);

  const providers = data?.providers ?? [];
  const defaultSelection: DefaultSelection | null = data?.defaultSelection ?? null;
  const current = providers.find((provider) => provider.id === selectedProvider);

  const finish = (settings: SettingsShape): void => {
    props.onApplied(settings);
    props.onClose();
  };

  const applyDefault = async (): Promise<void> => {
    setApplying('default');
    setError(null);
    try {
      const result = await apiCall<{ settings: SettingsShape }>('POST', '/quickfill', { useDefault: true });
      finish(result.settings);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setApplying(null);
    }
  };

  const applySelected = async (): Promise<void> => {
    if (current === undefined) return;
    setApplying('selected');
    setError(null);
    try {
      const result = await apiCall<{ settings: SettingsShape }>('POST', '/quickfill', { providerId: current.id, modelId: selectedModel });
      finish(result.settings);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setApplying(null);
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
      data === null
        ? h('p', { className: 'dshgt-hint' }, t('quickfill.loading'))
        : h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
            defaultSelection === null
              ? null
              : h(
                  'div',
                  { className: 'dshgt-default' },
                  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                    h('span', { className: 'dshgt-hint' }, t('quickfill.default')),
                    h('span', { className: 'dshgt-mono' }, `${defaultSelection.provider} / ${defaultSelection.model}`),
                  ),
                  h(Btn, { variant: 'primary', small: true, onClick: () => void applyDefault(), disabled: applying !== null }, applying === 'default' ? t('quickfill.applying') : t('quickfill.useDefault')),
                ),
            providers.length === 0
              ? defaultSelection === null
                ? h('p', { className: 'dshgt-hint' }, t('quickfill.empty'))
                : null
              : h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                  h(Btn, { small: true, onClick: () => setShowOthers(!showOthers) }, showOthers ? t('quickfill.others.hide') : t('quickfill.others')),
                  showOthers
                    ? h(
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
                        h(Btn, { variant: 'primary', small: true, disabled: applying !== null || selectedModel === '', onClick: () => void applySelected() }, applying === 'selected' ? t('quickfill.applying') : t('quickfill.apply')),
                      )
                    : null,
                ),
          ),
      h(
        'div',
        { className: 'dshgt-footer', style: { justifyContent: 'flex-end' } },
        h(Btn, { onClick: props.onClose }, t('quickfill.close')),
      ),
    ),
  );
}
