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

export interface CredentialServices {
  describe?: (ref: string) => Promise<CredentialDescription> | CredentialDescription;
  resolve?: (ref: string) => Promise<ResolvedSecret | undefined | null> | ResolvedSecret | undefined | null;
  set?: (ref: string, value: string) => Promise<unknown> | unknown;
}

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

/** GitHub token：按 authMode 取，`gh` 模式读本机 gh 的登录态。 */
export async function resolveGithubToken(
  services: CredentialServices | undefined,
  authMode: 'device' | 'pat' | 'gh',
  tokenRef: string,
  deps: { env?: NodeJS.ProcessEnv; execGh?: () => Promise<string | undefined> } = {},
): Promise<{ token?: string; source: string }> {
  const env = deps.env ?? process.env;
  if (authMode === 'gh') {
    const execGh = deps.execGh ?? defaultGhToken;
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

async function defaultGhToken(): Promise<string | undefined> {
  const { execCapture } = await import('../core/exec.js');
  const result = await execCapture('gh', ['auth', 'token'], { timeoutMs: 5000 });
  if (result.code !== 0) return undefined;
  const token = result.stdout.trim();
  return token === '' ? undefined : token;
}
