/**
 * Next.js 服务器启动钩子：全局放宽 Node 内置 fetch（undici）的响应头等待上限。
 *
 * ===== 为什么必须做（2026-10-03 实测根因）=====
 *
 * 我们自己的生图超时是 IMAGE_TIMEOUT_MS = 900_000（15 分钟），
 * 但 Node 内置 fetch 用的 undici 有**自己的默认值**：
 *   headersTimeout = 300_000（5 分钟）、bodyTimeout = 300_000（5 分钟）
 * 这两个是**独立于 AbortController 的**底层限制 —— 上游慢到 5 分钟还没吐第一个
 * 响应头，undici 会先抛 UND_ERR_HEADERS_TIMEOUT 把连接掐了，
 * 我们的 15 分钟超时根本来不及生效。
 *
 * 生产日志实锤（api_usage_logs，2026-10-03）：
 *   大量失败 durationMs 集中在 301_000 ~ 327_000，errorMessage =
 *   「服务端响应超时，请稍后重试 (UND_ERR_HEADERS_TIMEOUT)」——
 *   包括「全家福合影」这类多图合成（慢）+ Agent 第 1/2 轮规划。
 *   这正是用户反馈的「生图等 5 分钟就断」。
 *
 * 修法：启动时替换全局 dispatcher，把这两个值抬到与业务超时同量级（15 分钟），
 * 让**我们的 AbortController 成为唯一裁判**，避免两套超时打架、
 * 且表现成「错误原因和实际不符」（报"服务端超时"，其实模型还在算）。
 *
 * ⚠️ 只改超时，不动连接池/管道等其它参数 —— undici 默认值经过调优，
 * 我们只覆盖这两个与本问题直接相关的阈值。
 *
 * 注意：Node 内置的 undici 无法直接 require，必须装 `undici` 包才能拿到
 * setGlobalDispatcher / Agent（二者共享同一套 global dispatcher 符号）。
 */

export async function register() {
  // 只在 Node.js runtime 生效（Edge runtime 没有 undici）
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  // ===== 优雅停机（Q-D62）=====
  //
  // Next.js 收到 SIGTERM 后会 `await server.close()`（等在途请求跑完），
  // 这个行为是对的；问题是 **Docker 默认只给 10 秒 stop_grace_period**，
  // 而生图超时是 15 分钟 —— 于是在途生成会在 10 秒后被 SIGKILL 掐断。
  //
  // 真正决定「能等多久」的是 docker-compose.yml 里的 stop_grace_period。
  //
  // 监听放在**动态 import** 的 `@/lib/drain-node` 里：instrumentation.ts 会被 Edge
  // runtime 也加载，而 `process.on` 是 Node 专属 API —— 打包器静态看到就会报 Edge 不兼容，
  // 本批实测一次构建刷出 75 条同样的警告。动态 import 的模块不进 Edge 产物
  //（与下面 undici 是同一个套路）。运行期安全由这个 nodejs 分支保证。
  await import('@/lib/drain-node').then((m) => m.installDrainHandlers())
  const HEADERS_TIMEOUT_MS = 900_000 // 15 分钟，与 IMAGE_TIMEOUT_MS 对齐
  const BODY_TIMEOUT_MS = 900_000
  const CONNECT_TIMEOUT_MS = 60_000 // 建连给 1 分钟足够（慢的是上游推理，不是握手）

  try {
    const { setGlobalDispatcher, Agent } = await import('undici')
    setGlobalDispatcher(new Agent({ headersTimeout: HEADERS_TIMEOUT_MS, bodyTimeout: BODY_TIMEOUT_MS, connectTimeout: CONNECT_TIMEOUT_MS }))
    console.log(
      `[instrumentation] undici dispatcher 已放宽：headersTimeout=${HEADERS_TIMEOUT_MS / 1000}s ` +
        `bodyTimeout=${BODY_TIMEOUT_MS / 1000}s connectTimeout=${CONNECT_TIMEOUT_MS / 1000}s`,
    )
  } catch (err) {
    // 装不上 undici 不能让服务起不来 —— 退化成 Node 默认（5 分钟），
    // 至少日志里留下明确线索，而不是静默变慢。
    console.error('[instrumentation] 放宽 undici 超时失败（将退回 Node 默认 5 分钟）:', err)
  }
}
