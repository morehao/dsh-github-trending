/**
 * dsh-github-trending — 插件入口（脚手架）
 *
 * 当前只做最小装配，验证包结构可被宿主加载。
 * 业务模块（fetcher / parser / summarizer / renderer / git / pr）按设计文档分阶段接入。
 */

export const name = 'dsh-github-trending'

export interface PluginLogger {
  info?: (message: string) => void
  warn?: (message: string) => void
}

export interface PluginContext {
  logger?: PluginLogger
}

export const inject: string[] = []

export function apply(ctx: PluginContext): void {
  ctx.logger?.info?.('[dsh-github-trending] loaded (scaffold)')
}

export default { name, inject, apply }
