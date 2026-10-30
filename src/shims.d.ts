/**
 * 宿主侧可选依赖的**类型声明**。
 *
 * `@deepseek-ai/dsh-tools` 只在有人装了 tools 服务的宿主里存在，因此运行时是
 * 动态 `import()`、类型上只有一个最小契约。不把它写进 dependencies：
 * 插件不安装它、也不该替宿主决定版本。
 */
declare module '@deepseek-ai/dsh-tools' {
  export function defineTool<T extends { name: string }>(definition: T): T;
}
