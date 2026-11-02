/**
 * 浏览器侧最小本地存储：只服务「刚点过更新」这一件跨进程存活的小事，与 Host 的 state.json 完全无关。
 *
 * 一键更新会先卸载运行中的插件、面板随之消失，把记号记进 localStorage，重开的新进程读回来
 * 渲染不随面板消失的恢复提示。这里只做**本插件的 key 前缀绑定 + 对外函数包装**，凭证与清理
 * 语义都收敛在共享包 `@morehao/dsh-plugin-kit/update/restore` 的 `createPendingStore` 里。
 *
 * 边界（硬性）：全程 fail-open——localStorage 不存在（SSR / 测试 vm）/ 隐私模式抛错 / JSON 损坏
 * 一律当空处理，绝不影响插件正常挂载；只做前端展示，不碰 Host 权威状态。
 */
import { createPendingStore, type PendingUpdate, PENDING_TTL_MS } from '@morehao/dsh-plugin-kit/update/restore';

/** 用本仓包名前缀，与旧键（若有）互不覆盖。 */
const PREFIX = 'dsh-github-trending:';

export { PENDING_TTL_MS };
export type { PendingUpdate };

/** 取浏览器 localStorage；拿不到（无 window / 抛错）返回 undefined，交由 kit fail-open。 */
function browserStorage() {
  try {
    const w: any = typeof window !== 'undefined' ? window : undefined;
    return w?.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** 本插件的 pending store 单例：key = `dsh-github-trending:update-pending`。 */
const pendingStore = createPendingStore({ keyPrefix: PREFIX, storage: browserStorage() });

/** 写入「刚点了更新」的记号。 */
export function writePendingUpdate(from: string, to: string): void {
  pendingStore.write(from, to);
}

/** 读取「刚点了更新」的记号。结构不符 / 过期 / 损坏返回 null（并清理）。 */
export function readPendingUpdate(): PendingUpdate | null {
  return pendingStore.read();
}

/** 清除记号（用户点「知道了」或已确认重开）。 */
export function clearPendingUpdate(): void {
  pendingStore.clear();
}
