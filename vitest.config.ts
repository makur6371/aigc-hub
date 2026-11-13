import { defineConfig } from 'vitest/config'
import path from 'node:path'

// 单测配置：只覆盖「算错了要赔钱 / 算错了产物就是错的」纯函数。
//
// 为什么不上 Playwright：成本高、收益延后，而当前最大风险是核心算法没回归网。
// 先建最小防线，等 Phase 3 修 bug 时再按需补 E2E。
export default defineConfig({
  test: {
    // 只扫 tests/ 目录下的 *.test.ts，不误抓源码里的同名字符串
    include: ['tests/**/*.test.ts'],
    // 纯函数测试不需要 DOM
    environment: 'node',
    maxWorkers: 2,
    reporters: ['default'],
  },
  resolve: {
    // 与 tsconfig 的 paths 保持一致，让测试能 import '@/lib/xxx'
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
