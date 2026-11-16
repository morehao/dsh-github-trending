/**
 * 通知渠道「是否已配置」的纯判定（无 React / 无宿主依赖，便于单测）。
 *
 * 背景：`webhookURL` / `secret` 按项目硬约束一律以 `${VAR}` 引用形式落盘（插件不存明文）。
 * 因此渠道默认值就是字面量 `${LARK_WEBHOOK}` 这样的占位符——它「非空」，但**不代表用户已填真实地址**。
 * 若直接判 `trim() !== ''`，打开开关就会被误判为「已配置」（用户看到输入框里还是 `${...}`）。
 */

/** 纯 `${VAR}` 占位引用（如 `${LARK_WEBHOOK}`）——是默认值，不代表用户已填真实地址。 */
export const PURE_ENV_PLACEHOLDER = /^\$\{[^}]+\}$/;

export interface WebhookShape {
  enabled: boolean;
  webhookURL: string;
}

/**
 * webhook 是否「真实可用」：非空 **且** 不是纯 `${VAR}` 占位。
 * - 默认值 `${LARK_WEBHOOK}` → false（未填真实地址）；
 * - 用户填真实 URL，或把某 `${VAR}` 改成别的引用值 → true。
 */
export function hasRealWebhook(channel: WebhookShape): boolean {
  const value = channel.webhookURL.trim();
  return value !== '' && !PURE_ENV_PLACEHOLDER.test(value);
}

/** 渠道是否「已配置」：启用且 webhook 是真实可用地址（非空且非默认占位）。 */
export function isChannelConfigured(channel: WebhookShape): boolean {
  return channel.enabled && hasRealWebhook(channel);
}
