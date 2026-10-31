/**
 * 插件更新状态：顶部身份条与「关于」弹层共用同一份状态机。
 *
 * 状态机来自 `@morehao/dsh-plugin-kit/update/client`；这里持有**唯一**的 controller
 * （模块级单例），所以身份条的检查和关于弹层的检查不会各打一次网络。首次挂载静默检查
 * 一次，之后复用 Host 侧 5 分钟缓存。概览页不再展示更新卡片，只剩这两个消费方。
 */
import { createUpdateController, type UpdateClientState, type UpdateController } from '@morehao/dsh-plugin-kit/update/client';

import { applyPluginUpdate, getPluginUpdate } from './api.js';
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
