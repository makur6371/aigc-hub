import { beginDrain, drainState } from '@/lib/drain'

/**
 * 优雅停机的**信号监听**（Node 专属，Q-D62）。
 *
 * ===== 为什么单独一个文件 =====
 * `instrumentation.ts` 会被 Edge runtime 也加载，而 Edge 没有 `process.on`。
 * 运行期其实没问题 —— `register()` 开头就有 `if (process.env.NEXT_RUNTIME !== 'nodejs') return`，
 * Edge 根本走不到挂监听那几行。
 *
 * 但**打包器是静态分析的**：Turbopack 看到 `process.on` 就会报
 * 「A Node.js API is used … which is not supported in the Edge Runtime」，
 * 本批实测**一次构建刷出 75 条同样的警告**（路由图里 instrument 被引一次就放大成 75 处）。
 * 噪音本身会掩盖真正的警告，还会诱导后来人「顺手修一下」而改错。
 *
 * 所以把 Node 专属的部分挪进本文件，由 `instrumentation.ts` 在 **nodejs 分支里动态 import** ——
 * 和它对 `undici` 的处理是同一个套路（动态 import 的模块不进 Edge 产物）。
 */
export function installDrainHandlers(): void {
  // 幂等：register() 在同一进程里可能被调用多次（dev / 多 worker）
  if (process.env.__AIGC_HUB_DRAIN_HOOKED) return
  process.env.__AIGC_HUB_DRAIN_HOOKED = '1'

  const onSignal = (signal: string) => {
    beginDrain(signal)
    const st = drainState()
    console.warn(
      `[drain] 收到 ${signal}：新生成请求将被拒绝；在途 ${st.inFlight} 个；` +
        `等待 stop_grace_period 内跑完，超时则被 SIGKILL`,
    )
  }
  process.on('SIGTERM', () => onSignal('SIGTERM'))
  process.on('SIGINT', () => onSignal('SIGINT'))
}
