/**
 * 优雅停机（Q-D50 / Q-D62）。
 *
 * ===== 问题 =====
 * 每次发版 = 容器重启 = `docker compose up -d` 给旧容器发 SIGTERM。
 * Next.js 收到 SIGTERM 后会 `await server.close()` —— 也就是**等在途请求跑完**，
 * 这个行为本身是对的。但 Docker 的默认 `stop_grace_period` 只有 **10 秒**，
 * 而本平台的生图超时是 `IMAGE_TIMEOUT_MS = 900_000`（15 分钟）。
 * 于是实际发生的是：SIGTERM 后 10 秒 SIGKILL，**在途生成全部被掐断**。
 * 用户表现为「转了 5 分钟后失败」，钱虽然会退（Q-D01/03 的事务保证），
 * 但那 5 分钟白等，而且 Agent 任务停在 RUNNING。
 *
 * ===== 这一层做什么、不做什么 =====
 * **做**：
 *   1. 记录「已进入排空」，让**新来的**生成请求**立刻失败**并给出明确原因；
 *   2. 记录在途生成请求数，停机时能报「还有几个在跑」。
 *
 * **不做**：
 *   - 不接管进程退出时机（那是 Next.js 的 `server.close()` 与 Docker 的
 *     `stop_grace_period` 的事，见 docker-compose.yml）。
 *   - 不试图「等所有生成跑完再退出」—— 15 分钟的生图等不起，
 *     而且 Agent 侧有 checkpoint（Q-D13），中断后可以从检查点恢复。
 *
 * ===== 为什么把拒绝点放在 chargeRun =====
 * `chargeRun` 扣费 —— 它是**唯一**能一把拦住所有生成路径的点，
 * 而且拦在**扣钱之前**：不会出现「钱扣了、任务被拒」的脏状态。
 * 在每个路由入口各写一遍检查才是典型的「修一个实例」。
 */

export const DRAIN_MESSAGE = '服务正在发布新版本，暂时无法接收新的生成任务，请稍后重试（已生成的内容不会丢失）'

type DrainState = {
  /** 是否已进入排空 */
  draining: boolean
  /** 进入排空的时间戳 */
  since: number
  /** 触发原因（SIGTERM / SIGINT / 手工） */
  reason: string
  /** 在途生成请求数 */
  inFlight: number
}

const state: DrainState = {
  draining: false,
  since: 0,
  reason: '',
  inFlight: 0,
}

/** 是否正在排空（停机中）。 */
export function isDraining(): boolean {
  return state.draining
}

/** 当前排空状态快照（供 /api/admin/system-status 与停机日志使用）。 */
export function drainState(): DrainState {
  return { ...state }
}

/**
 * 进入排空。**幂等**：重复信号（Docker 一次停机可能同时发 SIGTERM 与 SIGINT）
 * 不会重置计时，也不会重复打印。
 */
export function beginDrain(reason = 'unknown'): void {
  if (state.draining) return
  state.draining = true
  state.since = Date.now()
  state.reason = reason
  console.warn(
    `[drain] 进入排空（${reason}）：不再接受新的生成任务；当前在途 ${state.inFlight} 个`,
  )
}

/** 仅供测试复位。 */
export function __resetDrainForTest(): void {
  state.draining = false
  state.since = 0
  state.reason = ''
  state.inFlight = 0
}

/**
 * 登记一个在途生成请求，返回释放函数。
 *
 * 用途有两个：① 停机时能报「还有几个在跑」（决定能不能立刻退出）；
 * ② 将来若要做「排空完再退出」，这里就是计数的地方。
 */
export function enterGeneration(): () => void {
  state.inFlight++
  let released = false
  return () => {
    if (released) return
    released = true
    state.inFlight = Math.max(0, state.inFlight - 1)
  }
}
