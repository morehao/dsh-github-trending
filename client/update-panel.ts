/**
 * 插件更新状态：顶部身份条与「关于」弹层共用同一份状态机。
 *
 * 状态机来自 `@morehao/dsh-plugin-kit/update/client`；这里持有**唯一**的 controller
 * （模块级单例），所以身份条的检查和关于弹层的检查不会各打一次网络。首次挂载静默检查
 * 一次，之后复用 Host 侧 5 分钟缓存。概览页不再展示更新卡片，只剩这两个消费方。
 */
import { createUpdateController, type UpdateClientState, type UpdateController } from '@morehao/dsh-plugin-kit/update/client';

import { applyPluginUpdate, getPluginUpdate } from './api.js';
import type { PendingUpdate } from './update-store.js';
import { React } from './ui.js';

let singleton: UpdateController | null = null;

export function getUpdateController(): UpdateController {
  if (singleton === null) {
    singleton = createUpdateController({
      request: {
        check: (options) => getPluginUpdate(options.fresh === true ? { fresh: true } : {}),
        apply: () => applyPluginUpdate(),
      },
    });
  }
  return singleton;
}

/** 订阅共享更新状态；首个订阅者挂载时静默检查一次。 */
export function usePluginUpdate(): [UpdateClientState, UpdateController] {
  const controller = getUpdateController();
  const [state, setState] = React.useState<UpdateClientState>(() => controller.getState());
  React.useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    if (controller.getState().status === 'idle') void controller.check();
    return unsubscribe;
  }, [controller]);
  return [state, controller];
}

/** 「更新已装上、待重启生效」的两个终态：控制器落到这两个就应给用户恢复提示。 */
export function isUpdateSettled(state: UpdateClientState): boolean {
  return state.status === 'applied' || state.status === 'restart-required';
}

/**
 * 由已落定的更新状态推导要展示的恢复提示。
 *
 * 面板内点「确认更新」成功后不会重挂载，只在挂载时读一次 localStorage 的旧逻辑拿不到
 * 刚写下的记号——这正是「更新成功却像点了没反应」的根因。这里给出纯逻辑：优先用记号
 * （onConfirmUpdate 已写入 from/to）；记号缺失（如只观察到 settled）时用状态里的版本兜底，
 * 保证更新成功后一定有可见的「请重启」提示。未落定或没有可用版本时返回 null。
 */
export function deriveSettledNotice(
  state: UpdateClientState,
  stored: PendingUpdate | null,
  now: number = Date.now(),
): PendingUpdate | null {
  if (!isUpdateSettled(state)) return null;
  if (stored !== null) return stored;
  const from = state.view?.currentVersion ?? '';
  const to = state.view?.latestVersion ?? from;
  if (to === '') return null;
  return { from, to, at: now };
}
