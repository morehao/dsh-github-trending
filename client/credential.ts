/**
 * 模型凭据的**展示语义**：把 `model.mode` 与 `credential.configured` 合成一句人能读的话。
 *
 * `configured` 只回答「`apiKeyRef` 能不能解析出密钥」，不等于「模型能不能用」，
 * 更不能直接当「认证明细是否就绪」：
 *   - `proxy` 模式下密钥由宿主经回环代理自己带上，插件本机一个密钥都不需要。
 *     此时显示「未配置」会让人误以为还得再补一项（其实已经复用了 DSH 凭据）；
 *   - 反过来，`proxy` 模式下残留的旧 `apiKeyRef` 仍可能解析成功，
 *     显示「已配置」又会让用户以为那个引用在生效。
 *
 * 所以判断顺序固定为「先看 mode，再看 configured」，设置页、总览、01 外壳的就绪数
 * 都走这里，避免三处各写一套后再次分叉。
 */
import type { StatePayload } from './api.js';
import type { Translate } from './i18n.js';

export interface CredentialView {
  /** 认证是否就绪：`proxy` 恒为 true（宿主负责），`direct` 取决于密钥能否解析。 */
  ok: boolean;
  kind: 'ok' | 'warn' | 'err';
  /** 药丸文案，已含来源（例如「已配置 · env」）。 */
  label: string;
  /** 行内说明，解释「为什么不用填 / 该去哪补」。 */
  hint: string;
}

export interface ModelCredentialInput {
  mode: 'direct' | 'proxy';
  credential: StatePayload['model']['credential'];
}

export function credentialView(model: ModelCredentialInput, t: Translate): CredentialView {
  if (model.mode === 'proxy') {
    return { ok: true, kind: 'ok', label: t('auth.hostProxy'), hint: t('model.credential.proxyHint') };
  }
  const credential = model.credential;
  if (credential.configured) {
    return {
      ok: true,
      kind: 'ok',
      label: `${t('auth.configured')}${credential.source === null ? '' : ` · ${credential.source}`}`,
      hint: t('model.credential.directHint'),
    };
  }
  const missing = t('auth.missing');
  return {
    ok: false,
    kind: 'err',
    label: credential.ref.trim() === '' ? missing : `${missing} · ${credential.ref}`,
    hint: t('model.credential.missingHint'),
  };
}
