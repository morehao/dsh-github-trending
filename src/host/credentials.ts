/**
 * 凭据解析：一律「按操作解析」，不缓存明文（ADR D-04 约束 2）。
 *
 * 宿主的凭据服务只回答被问到的引用，**没有枚举**——所以这里的 ref 只来自两处：
 * 设置里用户选定的 `model.apiKeyRef` / `github.tokenRef`，以及 provider 目录声明的
 * `nativeAuth.env`。不存在「猜一个 ref 试试」。
 */
export interface CredentialDescription {
  configured: boolean;
  source?: string;
  writable: boolean;
}

export interface ResolvedSecret {
  value?: string;
  source?: string;
}

export interface CredentialRecord {
  kind: string;
  payload: unknown;
}

export interface CredentialServices {
  describe?: (ref: string) => Promise<CredentialDescription> | CredentialDescription;
  resolve?: (ref: string) => Promise<ResolvedSecret | undefined | null> | ResolvedSecret | undefined | null;
  set?: (ref: string, value: string) => Promise<unknown> | unknown;
  /**
   * record 半边（`<scope>/<id>` 键）：只读，用于 `authMode=browser` 读 GitHub 登录记录。
   * 由核心 `dsh-credentials-local` 的同一对象提供（与 ref 半边并存）；缺失时 browser 模式退回 ref/env。
   */
  readRecord?: (key: string) => Promise<CredentialRecord | undefined> | CredentialRecord | undefined;
}

/** 浏览器登录写入核心凭据记录的键（与核心 `@deepseek-ai/dsh-github-auth` 提案同名同构）。 */
export const GITHUB_RECORD_KEY = 'github/default';

export function credentialServices(get: (name: string) => unknown): CredentialServices | undefined {
  const service = get('credentials') as CredentialServices | undefined;
  return service !== undefined && typeof service?.resolve === 'function' ? service : undefined;
}

/** 环境变量回退：宿主凭据服务没有该 ref 时，用同名环境变量（与 dsh-credentials-local 的语义一致）。 */
function fromEnv(ref: string, env: NodeJS.ProcessEnv): string | undefined {
  const raw = env[ref];
  return typeof raw === 'string' && raw.trim() !== '' ? raw : undefined;
}

export async function describeRef(
  services: CredentialServices | undefined,
  ref: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialDescription> {
  if (ref.trim() === '') return { configured: false, writable: false };
  if (services?.describe !== undefined) {
    try {
      const described = await services.describe(ref);
      if (described?.configured === true) {
        return { configured: true, source: described.source, writable: described.writable === true };
      }
    } catch {
      // 描述失败按未配置处理，下面继续看环境变量
    }
  }
  const envValue = fromEnv(ref, env);
  return envValue === undefined
    ? { configured: false, writable: services?.set !== undefined }
    : { configured: true, source: 'env', writable: false };
}

export async function resolveRef(
  services: CredentialServices | undefined,
  ref: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedSecret> {
  if (ref.trim() === '') return {};
  if (services?.resolve !== undefined) {
    try {
      const resolved = await services.resolve(ref);
      const value = resolved?.value;
      if (typeof value === 'string' && value.trim() !== '') return { value, source: resolved?.source ?? 'credentials' };
    } catch {
      // 解析失败继续走环境回退
    }
  }
  const envValue = fromEnv(ref, env);
  return envValue === undefined ? {} : { value: envValue, source: 'env' };
}

/** 读核心凭据记录里的 GitHub grant；服务缺失 / 未登录 / 形态不符一律返回 undefined（不抛）。 */
async function readGithubRecord(services: CredentialServices | undefined): Promise<CredentialRecord | undefined> {
  if (typeof services?.readRecord !== 'function') return undefined;
  try {
    return (await services.readRecord(GITHUB_RECORD_KEY)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** 从 grant 记录里取 access token；非 grant 或 payload 无 token 返回 undefined。 */
function grantToken(record: CredentialRecord | undefined): string | undefined {
  if (record === undefined || record.kind !== 'grant') return undefined;
  const payload = record.payload as { token?: unknown } | null | undefined;
  const token = payload?.token;
  return typeof token === 'string' && token.trim() !== '' ? token : undefined;
}

/** GitHub token：按 authMode 取，`gh` 读本机 gh 登录态，`browser` 读核心凭据记录，`pat` 读 ref/env。 */
export async function resolveGithubToken(
  services: CredentialServices | undefined,
  authMode: 'pat' | 'gh' | 'browser',
  tokenRef: string,
  deps: { env?: NodeJS.ProcessEnv; execGh?: () => Promise<string | undefined>; freshGh?: boolean } = {},
): Promise<{ token?: string; source: string }> {
  const env = deps.env ?? process.env;
  if (authMode === 'browser') {
    // 浏览器登录：token 由 `ctx.authorization` 的 flow 提交到核心凭据记录（grant.payload.token）。
    const record = await readGithubRecord(services);
    const token = grantToken(record);
    if (token !== undefined) return { token, source: 'github-browser' };
    // 未登录：如实降级到 ref/env 兜底（与 gh 模式一致的策略），由调用方决定是否提示去登录。
  }
  if (authMode === 'gh') {
    const execGh = deps.execGh ?? (() => defaultGhToken(deps.freshGh === true));
    try {
      const token = await execGh();
      if (token !== undefined && token !== '') return { token, source: 'gh' };
    } catch {
      // 没有 gh 或未登录：退到凭据/环境，但如实标注来源
    }
  }
  const resolved = await resolveRef(services, tokenRef, env);
  if (resolved.value !== undefined) return { token: resolved.value, source: resolved.source ?? 'credentials' };
  return { source: 'none' };
}

/** 本机 gh token 短缓存：`/state` 每 5 s 轮询、每次运行都会解析，不能每次都 spawn 一次 gh。 */
let ghTokenCache: { value: string | undefined; at: number } | undefined;
const GH_TOKEN_TTL_MS = 30_000;

async function defaultGhToken(fresh = false): Promise<string | undefined> {
  if (!fresh && ghTokenCache !== undefined && Date.now() - ghTokenCache.at < GH_TOKEN_TTL_MS) {
    return ghTokenCache.value;
  }
  const { spawnCollect: execCapture } = await import('@morehao/dsh-plugin-kit/exec');
  const result = await execCapture('gh', ['auth', 'token'], { timeoutMs: 2000 });
  const token = result.code === 0 ? result.stdout.trim() : '';
  const value = token === '' ? undefined : token;
  ghTokenCache = { value, at: Date.now() };
  return value;
}
