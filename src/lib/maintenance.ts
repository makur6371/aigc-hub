import { readdir, rm, stat } from 'fs/promises'
import { join, resolve } from 'path'
import { getPrisma } from '@/lib/prisma'
import { cleanupExpiredAssets, cleanupOrphanAssets } from '@/lib/asset-cleanup'
import { cleanupOrphanToolCovers, toolCoverLocalPath } from '@/lib/tool-cover'
import { purgeExpiredMediaRecordsForPlatform } from '@/lib/user-media-records'
import { CANVAS_RUN_STATUS, GENERATION_TASK_STATUS } from '@/lib/status-vocab'
import { settleOrphanedAsyncTasks } from '@/lib/billing/async-settle'
import { reconcileVideoUsageLogs } from '@/lib/reconcile-video-logs'
import { expireDueSubscriptions, reconcileHold } from '@/lib/billing/wallet'
import { errorRecord, recordError } from '@/lib/error-sink'

// ===== 统一维护任务（惰性触发，零运维）=====
//
// 目标：让「会无限增长的资源」都有明确去处，而不是靠人记得去清。
//
// 分三类：
//   1) 临时素材（user_assets 里带 expiresAt 的）—— 过期即删（磁盘 + 记录）
//   2) 运维日志（api_usage_logs / canvas_runs / billing_holds）—— 按保留期删
//   3) 公共缓存（/data/covers）—— 按 TTL 删
//
// 触发方式：应用启动跑一次 + 访问相关接口时惰性触发（带节流）。
// 单进程部署下这套足够；将来多副本时再换成独立定时任务。

/**
 * 维护任务里的失败必须**落到错误面板**，不能只进 stdout。
 *
 * 这里跑的都是兜底对账、预扣退回、订阅回滚、日志清理 —— 一旦静默失守，
 * 表现是「钱没退回来 / 表无限膨胀」，而这两种都只会在几周后才被察觉。
 * 容器日志翻起来又慢又会滚掉，所以统一走 error-sink（运维面板「进程错误」表可见）。
 */
function mlog(message: string, err: unknown): void {
  console.error(`[maintenance] ${message}`, err)
  recordError(errorRecord('maintenance', err))
}

/** 各表的保留天数（超过即删） */
export const LOG_RETENTION_DAYS = {
  /** 模型状态监测只看 72h，90 天足够追溯 */
  apiUsageLogs: 90,
  /** 只用于排查，单行 ~1.6KB（存了完整工作流快照）→ 保留短一些省空间 */
  canvasRuns: 30,
  /** 已结算的预扣账本，对账窗口 7 天足够 */
  billingHolds: 7,
  /** 认证爆破限流的窗口行：窗口最长 15 分钟，留 1 天足够排障，且必须清 —— 否则逐 IP 逐窗口无限增长 */
  rateLimits: 1,
} as const

/**
 * 封面/外链图回源缓存 TTL（天）。
 *
 * 这份缓存（`/data/covers`）是「服务器帮浏览器把外链图拉回来」的**只读中转**，
 * 不写数据库、不改变图片 URL，纯粹为了：① 避免每次冷缓存都回源上游；
 * ② 上游链接过期后还能取到一份。
 *
 * 30 天 → 3 天：按 URL 哈希存，上游每张新图都是新 URL，所以它只增不减
 * （实测 303 个文件 / 603MB，平均 2MB/张）。3 天足够覆盖「用户回头再看一眼」的
 * 绝大多数场景，又能把磁盘占用压到约 1/10。浏览器侧另有 7 天 HTTP 缓存
 * （`max-age=604800, immutable`），真正的热路径不依赖服务器这份。
 */
export const COVER_CACHE_TTL_DAYS = 3

const COVER_CACHE_DIR = process.env.COVER_CACHE_DIR || join(process.env.DATA_DIR || '/data', 'covers')

export interface MaintenanceResult {
  expiredAssets: number
  orphanAssets: number
  apiUsageLogs: number
  /** 清理掉的认证限流窗口行数 */
  rateLimits: number
  canvasRuns: number
  billingHolds: number
  /** 到期回滚的订阅账号数（Q-603：库里 billingType 滞后的平台级兜底） */
  expiredSubs: number
  coverFiles: number
  orphanToolCovers: number
  /** 历史扣费文案归一化条数（一次性任务，之后恒为 0） */
  relabeledLogs: number
  /** 兜底对账退回的僵死预扣笔数 */
  staleHolds: number
  /** 把「超时无更新的 RUNNING」收敛成 FAILED 的条数（画布 + Agent 任务） */
  staleRuns: number
  /** 异步任务兜底结算：扫了多少 / 收口多少 / 退回多少（豆、积分） */
  asyncSettle: Awaited<ReturnType<typeof settleOrphanedAsyncTasks>> | null
  /** 过期生成记录回收（记录 + 本站文件）：image/video/audio 各删多少条 */
  expiredMediaRecords: { image: number; video: number; audio: number }
  skipped: boolean
}

let lastRunAt = 0
const MIN_INTERVAL_MS = 30 * 60 * 1000 // 最多每 30 分钟跑一次

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

/** 清理封面缓存目录里超过 TTL 的文件 */
async function cleanupCoverCache(ttlDays: number): Promise<number> {
  const base = resolve(COVER_CACHE_DIR)
  let removed = 0
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000
  let entries: import('fs').Dirent[]
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch {
    return 0 // 目录不存在（没缓存过）→ 无需清理
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const full = join(base, entry.name)
    try {
      const info = await stat(full)
      if (info.mtimeMs < cutoff) {
        await rm(full, { force: true })
        removed++
      }
    } catch { /* 单个文件失败忽略 */ }
  }
  return removed
}

/**
 * 跑一轮维护。force=true 忽略节流（启动时/后台手动触发用）。
 * 任何一步失败都不影响其他步——维护是尽力而为，不能因为它挂了影响业务。
 */
export async function runMaintenance(force = false): Promise<MaintenanceResult> {
  const now = Date.now()
  if (!force && now - lastRunAt < MIN_INTERVAL_MS) {
    return { expiredAssets: 0, orphanAssets: 0, apiUsageLogs: 0, rateLimits: 0, canvasRuns: 0, billingHolds: 0, expiredSubs: 0, coverFiles: 0, orphanToolCovers: 0, relabeledLogs: 0, staleHolds: 0, staleRuns: 0, asyncSettle: null, expiredMediaRecords: { image: 0, video: 0, audio: 0 }, skipped: true }
  }
  lastRunAt = now

  const prisma = await getPrisma()
  const result: MaintenanceResult = {
    expiredAssets: 0, orphanAssets: 0, apiUsageLogs: 0, rateLimits: 0, canvasRuns: 0, billingHolds: 0, coverFiles: 0, orphanToolCovers: 0, relabeledLogs: 0, staleHolds: 0, staleRuns: 0, asyncSettle: null, expiredMediaRecords: { image: 0, video: 0, audio: 0 }, skipped: false,
    expiredSubs: 0,
  }

  // 1) 过期素材（磁盘 + 记录）
  try {
    const r = await cleanupExpiredAssets(true)
    result.expiredAssets = r.deletedRecords
  } catch (e) { mlog('清理过期素材失败:', e) }

  // 2) 孤儿文件（磁盘有、记录无）
  try {
    result.orphanAssets = await cleanupOrphanAssets()
  } catch (e) { mlog('回收孤儿素材失败:', e) }

  // 2.5) 过期生成记录（记录 + 本站托管文件）：user_assets 的 generated 类此前
  // 只能靠用户手动「清理失效」回收，长期不登录的账号产物会一直占盘（Q-D61 收口）。
  // PENDING 不在清理范围（异步退款依赖它，见 user-media-records 内注释）。
  try {
    result.expiredMediaRecords = await purgeExpiredMediaRecordsForPlatform()
    const m = result.expiredMediaRecords
    if (m.image + m.video + m.audio > 0) {
      console.log(`[maintenance] 过期生成记录回收：image ${m.image} / video ${m.video} / audio ${m.audio}`)
    }
  } catch (e) { mlog('清理过期生成记录失败:', e) }

  // 3) 运维日志按保留期清理
  try {
    const r = await prisma.apiUsageLog.deleteMany({ where: { createdAt: { lt: daysAgo(LOG_RETENTION_DAYS.apiUsageLogs) } } })
    result.apiUsageLogs = r.count
  } catch (e) { mlog('清理用量日志失败:', e) }

  try {
    // 限流窗口行按 windowAt 清理：历史窗口没有判定价值，留着只会占盘
    const r = await prisma.rateLimit.deleteMany({ where: { windowAt: { lt: daysAgo(LOG_RETENTION_DAYS.rateLimits) } } })
    result.rateLimits = r.count
  } catch (e) { mlog('清理限流窗口失败:', e) }

  try {
    // 只删终态 run。RUNNING/PAUSED 的 run 可能还挂着 OPEN 的 billingHold，
    // 一旦被删，reconcileOpenHolds 会因「找不到 run」永久跳过 → 用户预扣的钱退不回来。
    const r = await prisma.canvasRun.deleteMany({
      where: {
        createdAt: { lt: daysAgo(LOG_RETENTION_DAYS.canvasRuns) },
        status: { in: [CANVAS_RUN_STATUS.SUCCEEDED, CANVAS_RUN_STATUS.FAILED, CANVAS_RUN_STATUS.CANCELLED] },
      },
    })
    result.canvasRuns = r.count
  } catch (e) { mlog('清理画布运行记录失败:', e) }

  // 5.5) 超时 RUNNING 收敛（2026-10-01）
  //
  // 为什么必须有：进程重启 / 客户端断线 / 异常退出都会留下**永远不会结束**的 RUNNING。
  // 实测生产：batch 有 46 条 RUNNING 卡了 1 天以上（看似在跑，实际早没了）。
  // 危害有两个：
  //   1) 前端刷新后不认领 RUNNING（怕重复插），于是任务**永久不显示**，用户以为丢了；
  //   2) billingHold 的兜底对账里写着「run 还是 RUNNING 就跳过」——
  //      卡死的 RUNNING 会让那笔预扣**永远退不回来**（用户的钱留在平台账上）。
  //
  // 所以这里把「超过 STALE_RUN_MS 没有更新的 RUNNING」收敛成 FAILED，
  // 让它能被前端认领、也能被 hold 对账正常处理。
  // 阈值取 30 分钟：正常单个生成任务远不会这么久（超长视频也很少 >30min 无任何更新）。
  const STALE_RUN_MS = 30 * 60 * 1000
  try {
    const cutoff = new Date(Date.now() - STALE_RUN_MS)
    const [cr, gt] = await Promise.all([
      prisma.canvasRun.updateMany({
        where: { status: CANVAS_RUN_STATUS.RUNNING, updatedAt: { lt: cutoff } },
        data: { status: CANVAS_RUN_STATUS.FAILED, error: '任务超时未更新（进程重启或连接中断遗留）' },
      }),
      prisma.generationTask.updateMany({
        where: { status: GENERATION_TASK_STATUS.RUNNING, updatedAt: { lt: cutoff } },
        data: { status: GENERATION_TASK_STATUS.FAILED, error: '任务超时未更新（进程重启或连接中断遗留）' },
      }),
    ])
    result.staleRuns = cr.count + gt.count
    if (result.staleRuns > 0) console.log(`[maintenance] 收敛僵死 RUNNING：canvasRun ${cr.count} + task ${gt.count}`)
  } catch (e) { mlog('收敛僵死 RUNNING 失败:', e) }

  // 5.6) 异步任务兜底结算（视频/音频）
  //
  // 放在「收敛僵死 RUNNING」之后：那些被收敛成 FAILED 的任务，其退款已由
  // 用户端轮询或下面第 6 步的 hold 对账处理；这里只接管「预扣已结算、
  // 但因为用户不再轮询而没人退款」的 PENDING 记录。
  try {
    result.asyncSettle = await settleOrphanedAsyncTasks()
    await reconcileVideoUsageLogs()
    const a = result.asyncSettle
    if (a.refundedBeans > 0 || a.refundedPoints > 0) {
      // 退款发生了就必须留痕：否则「用户没投诉但账对不上」这类问题会被彻底埋掉
      console.log(
        `[maintenance] 异步兜底退款：豆 ${a.refundedBeans} / 积分 ${a.refundedPoints}` +
          `（扫 ${a.scanned} · 成功 ${a.succeeded} · 失败 ${a.failed} · 进行中 ${a.stillRunning}）`,
      )
    }
  } catch (e) { mlog('异步任务兜底结算失败:', e) }

  try {
    // 只清已结算的（OPEN 的还在等对账，不能动）
    const r = await prisma.billingHold.deleteMany({
      where: { status: { not: 'OPEN' }, createdAt: { lt: daysAgo(LOG_RETENTION_DAYS.billingHolds) } },
    })
    result.billingHolds = r.count
  } catch (e) { mlog('清理预扣账本失败:', e) }

  // 6) 僵死的 OPEN hold 兜底
  // 正常路径由「用户访问 profile」触发 reconcileOpenHolds，但如果用户不再登录，
  // 那笔预扣会一直挂着。这里主动扫一遍全平台的 OPEN hold，逐条走**同一个**
  // reconcileHold —— 判定标准（RUNNING/PAUSED 跳过、僵死接管、run 不存在按未消耗退）
  // 只有一份，不再由本文件另写一遍。改对账语义只改 wallet.ts 一处。
  try {
    const staleHolds = await prisma.billingHold.findMany({
      where: { status: 'OPEN', createdAt: { lt: daysAgo(1) } },
      take: 100,
    })
    for (const hold of staleHolds) {
      try {
        // 跳过（run 还在跑/已暂停等续跑）的 hold 不计入 staleHolds：
        // 这个数是对外展示「兜底退回了多少笔」，把「这轮没动」的算进去会误导。
        const { refunded } = await reconcileHold(hold)
        if (refunded) result.staleHolds++
      } catch (e) { mlog('兜底对账僵死预扣失败(跳过,下轮重试):', e) }
    }
  } catch (e) { mlog('兜底对账僵死预扣失败:', e) }

  // 6b) 订阅到期平台级回滚（Q-603）
  // 单用户惰性检查只覆盖 login/profile 两个入口；长期不走这两个接口的账号会让
  // users.billingType 一直停在 SUBSCRIPTION。显示层虽已二次判过期时间，
  // 但库里不变式为假会让任何按 billingType 过滤的新查询虚高 —— 这里兜底。
  try {
    result.expiredSubs = await expireDueSubscriptions()
    if (result.expiredSubs > 0) {
      console.log(`[maintenance] 订阅到期回滚：${result.expiredSubs} 个账号 billingType → POINTS`)
    }
  } catch (e) { mlog('订阅到期回滚失败:', e) }

  // 7) 封面缓存
  try {
    result.coverFiles = await cleanupCoverCache(COVER_CACHE_TTL_DAYS)
  } catch (e) { mlog('清理封面缓存失败:', e) }

  // 5) 工具封面孤儿（管理员换封面后遗留的旧图）
  try {
    const tools = await prisma.tool.findMany({ where: { coverUrl: { not: null } }, select: { coverUrl: true } })
    const referenced = new Set(
      tools.map((t) => (t.coverUrl ? toolCoverLocalPath(t.coverUrl) : null)).filter((p): p is string => !!p),
    )
    result.orphanToolCovers = await cleanupOrphanToolCovers(referenced)
  } catch (e) { mlog('回收工具封面孤儿失败:', e) }

  // 6) 历史文案归一化（一次性，跑完即空操作）
  // 早期把画布预算池的预扣记成「画布执行预扣」，用户看到「预扣 + 节点分摊」两行会
  // 以为扣了两次。金额没变，只是把标签改成对用户友好的说法。
  try {
    const [p, b] = await Promise.all([
      prisma.pointsLog.updateMany({
        where: { description: '画布执行预扣' },
        data: { description: '生成扣费' },
      }),
      prisma.beansLog.updateMany({
        where: { description: '画布视频节点预扣' },
        data: { description: '视频生成扣费' },
      }),
    ])
    result.relabeledLogs = p.count + b.count
  } catch (e) { mlog('归一化历史扣费文案失败:', e) }

  return result
}

/** 供后台展示：本轮维护的配置概览 */
export function maintenancePolicy() {
  return {
    logRetentionDays: LOG_RETENTION_DAYS,
    coverCacheTtlDays: COVER_CACHE_TTL_DAYS,
    minIntervalMinutes: MIN_INTERVAL_MS / 60000,
  }
}
