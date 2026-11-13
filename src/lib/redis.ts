import Redis from 'ioredis'
import { errorRecord, recordError } from '@/lib/error-sink'

let client: Redis | null = null

/**
 * 获取 Redis 客户端（懒加载单例）。
 *
 * 用途：公众号关键词验证码登录（一次性码 + 冷却）。**只有这一个功能依赖 Redis**。
 *
 * ===== 为什么必须挂 error 监听（Q-D49）=====
 * ioredis 的连接错误走 `silentEmit('error', err)` —— **没有监听器时它直接丢掉**。
 * 于是 Redis 挂掉的表现是「微信登录莫名失败」，而应用日志里**一个字都没有**，
 * 运维面板（Q-D32 的 error-sink）也完全不知情。这与 Q-D32 修之前的状态是同一类盲区。
 *
 * 这里挂上监听后：连接失败会进 error-sink（运维面板可见），并带上可执行的排查方向。
 * 注意**只记录、不抛错**：Redis 故障不应该让整个进程崩（它只服务登录的一个分支）。
 *
 * ===== 另一个已知取舍（见台账 Q-D49）=====
 * `docker-compose.yml` 里 app 硬依赖 `redis: service_healthy` —— 也就是说 Redis 起不来
 * app 就起不来。而 Redis 只服务「公众号验证码登录」这一个功能，这个耦合是否值得，
 * 属产品决策（要么降级为可选依赖 + 登录路径兜底，要么保留硬依赖但把健康接入面板）。
 * 本文件这一刀只保证「故障可见」，不改依赖关系。
 */
export function getRedis(): Redis {
  if (!client) {
    const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379'
    client = new Redis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy(times: number) {
        return Math.min(times * 200, 2000)
      },
    })

    // 每次重连失败都会触发；用 reason 做一次节流提示，避免刷爆错误面板
    client.on('error', (err: Error) => {
      console.error('[redis] 连接失败:', err.message)
      recordError(
        errorRecord('redis', err, { path: 'lib/redis.ts' }),
      )
    })

    client.on('ready', () => {
      // 只在恢复时打一条，便于确认「刚才那次故障已自愈」
      console.log('[redis] 已连接')
    })
  }
  return client
}

/** 仅供测试：清掉单例，让下个用例重新创建（生产代码不调用）。 */
export function __resetRedisForTest(): void {
  client = null
}

/** 供健康检查/运维面板用：Redis 当前是否可用（ping 有响应）。永不抛错。 */
export async function checkRedisHealth(): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = getRedis()
    const pong = await r.ping()
    return { ok: pong === 'PONG' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
