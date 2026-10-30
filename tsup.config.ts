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
  external: [/^@deepseek-ai\//],
})
