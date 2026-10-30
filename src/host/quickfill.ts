/**
 * 从宿主的 provider 目录快速填充模型配置（FR-P-03 / AC-P-03）。
 *
 * 三种认证形态的判定，只用宿主公开的两个目录：
 *   - `listProviders()`：当前**活着**的路由（id + 名称）；
 *   - `listConfigurableProviders()`：连**休眠**路由一起，带 `defaultBaseURL` 与 `nativeAuth`
 *     （认证读哪些环境变量、是否支持已存的 OAuth 登录）。
 *
 * 由此得到三种形态：
 *   1. `nativeAuth.env` 里有已配置的引用 → `direct`（密钥可解析，经配置通道直传）；
 *   2. `nativeAuth.oauth === true` 且无可导出密钥 → `proxy`（回环代理转发 `ctx.llm`）；
 *   3. 都没有 → `missing`（界面要求用户手动填）。
 *
 * 这里**不写任何配置**：只产出候选，由用户确认后 `/config` 落盘（禁止静默复制）。
 */
import type { ModelSettings, Settings } from '../config.js';
import { PROVIDER_BASE_URLS } from '../config.js';
import { describeRef, resolveRef, credentialServices, type CredentialServices } from './credentials.js';

export interface LlmModelCandidate {
  id: string;
  name: string;
}

export interface LlmProviderCandidate {
  /** 宿主 provider 路由 id。 */
  id: string;
  name: string;
  /** 该路由的默认端点（宿主声明，可能为空）。 */
  baseURL: string;
  models: LlmModelCandidate[];
  credential: {
    /** 选中的凭据引用名（`direct` 时非空）。 */
    ref?: string;
    /** 该路由声明的环境变量名。 */
    env: string[];
    configured: boolean;
    oauth: boolean;
    mode: 'direct' | 'proxy' | 'missing';
    source?: string;
  };
  /** 映射到核心能接受的 provider 名。 */
  coreProvider: string;
}

interface LlmProviderInfo {
  id: string;
  name: string;
}

interface LlmConfigurableProvider {
  provider: string;
  displayName?: string;
  defaultBaseURL?: string;
  nativeAuth?: { env?: readonly string[]; oauth?: boolean };
}

export interface LlmServices {
  listProviders?: () => LlmProviderInfo[];
  listModels?: (provider: string) => Promise<Array<{ id?: string; name?: string }>>;
  listConfigurableProviders?: () => LlmConfigurableProvider[];
}

export function llmServices(get: (name: string) => unknown): LlmServices | undefined {
  const service = get('llm') as LlmServices | undefined;
  return service !== undefined && typeof service?.listProviders === 'function' ? service : undefined;
}

/** 宿主 provider → 核心 provider。核心只认 deepseek / openai-compatible。 */
export function coreProviderFor(providerId: string): string {
  return /deepseek/i.test(providerId) ? 'deepseek' : 'openai-compatible';
}

/** 在 3 s 内拿到模型目录；超时就返回空（界面仍可让用户手填模型名）。 */
async function listModelsWithTimeout(llm: LlmServices, provider: string): Promise<LlmModelCandidate[]> {
  if (llm.listModels === undefined) return [];
  try {
    const models = await Promise.race([
      llm.listModels(provider),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('listModels timeout')), 3000)),
    ]);
    return models
      .filter((model): model is { id: string; name?: string } => typeof model?.id === 'string' && model.id !== '')
      .map((model) => ({ id: model.id, name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id }));
  } catch {
    return [];
  }
}

export interface CandidateOptions {
  llm: LlmServices | undefined;
  credentials: CredentialServices | undefined;
  env?: NodeJS.ProcessEnv;
}

export async function listProviderCandidates(options: CandidateOptions): Promise<LlmProviderCandidate[]> {
  const { llm, credentials } = options;
  const env = options.env ?? process.env;
  if (llm === undefined) return [];
  const live = llm.listProviders?.() ?? [];
  const configurable = llm.listConfigurableProviders?.() ?? [];
  const declared = new Map(configurable.map((entry) => [entry.provider, entry]));

  // 只列「活着或可配置」的并集，按 listProviders 的顺序优先。
  const ids: string[] = [];
  for (const provider of live) if (!ids.includes(provider.id)) ids.push(provider.id);
  for (const entry of configurable) if (!ids.includes(entry.provider)) ids.push(entry.provider);

  const candidates: LlmProviderCandidate[] = [];
  for (const id of ids) {
    const entry = declared.get(id);
    const name = live.find((provider) => provider.id === id)?.name ?? entry?.displayName ?? id;
    const envNames = [...(entry?.nativeAuth?.env ?? [])];
    const oauth = entry?.nativeAuth?.oauth === true;
    let ref: string | undefined;
    let source: string | undefined;
    let mode: 'direct' | 'proxy' | 'missing' = 'missing';
    for (const candidateRef of envNames) {
      const described = await describeRef(credentials, candidateRef, env);
      if (described.configured) {
        ref = candidateRef;
        source = described.source;
        mode = 'direct';
        break;
      }
    }
    if (mode !== 'direct' && oauth) mode = 'proxy';
    const models = await listModelsWithTimeout(llm, id);
    candidates.push({
      id,
      name,
      baseURL: entry?.defaultBaseURL ?? '',
      models,
      credential: {
        ...(ref === undefined ? {} : { ref }),
        env: envNames,
        configured: mode === 'direct',
        oauth,
        mode,
        ...(source === undefined ? {} : { source }),
      },
      coreProvider: coreProviderFor(id),
    });
  }
  return candidates;
}

/**
 * 把候选落成模型设置。`mode: 'proxy'` 时清空 baseURL 与 apiKeyRef——
 * 端点由插件在运行时注入回环代理地址，留存旧值只会误导。
 */
export function applyCandidate(settings: Settings, candidate: LlmProviderCandidate, modelId: string): Settings {
  const model: ModelSettings = {
    ...settings.model,
    provider: candidate.coreProvider,
    mode: candidate.credential.mode === 'proxy' ? 'proxy' : 'direct',
    hostProvider: candidate.credential.mode === 'proxy' ? candidate.id : '',
    baseURL: candidate.credential.mode === 'proxy' ? '' : candidate.baseURL || PROVIDER_BASE_URLS[candidate.coreProvider] || '',
    model: modelId,
    apiKeyRef:
      candidate.credential.mode === 'direct' && candidate.credential.ref !== undefined
        ? candidate.credential.ref
        : settings.model.apiKeyRef,
  };
  return { ...settings, model };
}

/** 运行前解析模型密钥：`direct` 走凭据，`proxy` 不需要密钥。 */
export async function resolveModelKey(
  settings: Settings,
  credentials: CredentialServices | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ apiKey?: string; mode: 'direct' | 'proxy'; source?: string }> {
  if (settings.model.mode === 'proxy') return { mode: 'proxy' };
  const resolved = await resolveRef(credentials, settings.model.apiKeyRef, env);
  return {
    mode: 'direct',
    ...(resolved.value === undefined ? {} : { apiKey: resolved.value }),
    ...(resolved.source === undefined ? {} : { source: resolved.source }),
  };
}

export { credentialServices };
