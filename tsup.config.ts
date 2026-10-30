import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/internal.ts'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  clean: true,
  outDir: 'lib',
  sourcemap: false,
  // 宿主侧的 @deepseek-ai/* 只在运行时由宿主提供：绝不打包，只做动态 import。
  // 契约包走 dependencies（安装时随包拉取），同样保持 external，避免把 ajv 打进 lib。
  external: [/^@deepseek-ai\//, /^@morehao\/trendradar-contract/],
})
