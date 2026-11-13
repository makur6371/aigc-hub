import { PrismaLibSql } from '@prisma/adapter-libsql'
import type { PrismaClient } from '@prisma/client'
import { resolve } from 'path'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

let prismaPromise: Promise<PrismaClient> | null = null

async function createPrismaClient(): Promise<PrismaClient> {
  const { PrismaClient: PC } = await import('@prisma/client')
  // 生产(docker-compose)必须走 DATABASE_URL(file:/data/dev.db 持久卷)，
  // 否则会读到镜像里 git 提交的 prisma/dev.db，重建镜像即丢运行数据。
  // 本地开发无该环境变量时回落仓库内 prisma/dev.db。
  const dbUrl = process.env.DATABASE_URL || `file:${resolve(process.cwd(), 'prisma', 'dev.db')}`

  // ===== SQLite 并发关键设置 =====
  // 默认的 journal_mode=delete + busy_timeout=0 在高并发下是致命的：
  //   1) delete 模式下写事务会锁住整个库，其他人读写全部阻塞或直接 SQLITE_BUSY；
  //   2) busy_timeout=0 表示遇到锁立即报错、完全不等待重试。
  // 生图任务会并发写积分流水/用量日志/hold，必须改成 WAL + 等待重试。
  //   - WAL：读写不互斥（读不阻塞写、写不阻塞读），并发能力提升一个数量级；
  //   - busy_timeout=5000：遇锁最多等 5 秒再报错，吸收瞬时写冲突。
  // timeout 参数由 @libsql/client 透传为 busy_timeout（毫秒）。
  const adapter = new PrismaLibSql({ url: dbUrl, timeout: 5000 })
  const prisma = new PC({ adapter })

  // WAL 是持久化到数据库文件的属性（设一次即长期生效），但每次启动都设一遍最稳妥；
  // 失败不阻断启动（例如只读挂载），只记录告警。
  try {
    await prisma.$executeRawUnsafe('PRAGMA journal_mode = WAL')
    await prisma.$executeRawUnsafe('PRAGMA synchronous = NORMAL')
  } catch (err) {
    console.warn('[prisma] 设置 SQLite WAL 失败（不影响启动）:', err instanceof Error ? err.message : err)
  }

  // 启动后跑一轮维护（清理过期素材 / 运维日志 / 封面缓存）。
  // 惰性触发在低流量时可能很久不跑，启动补一次能保证「长期没人访问也不会堆垃圾」。
  // 延迟 30 秒执行，避开启动瞬间的初始化竞争；失败不影响启动。
  setTimeout(() => {
    // 先把源码里的内置节点定义同步进库（幂等 upsert），再跑常规维护。
    // 顺序反了会让维护清到旧定义的数据；同步失败也不阻断维护。
    void import('./sync-builtin-nodes')
      .then((m) => m.syncBuiltinNodes())
      .then((r) => console.log(`[sync-builtin-nodes] 内置节点同步完成：新增 ${r.synced}，更新 ${r.updated}`))
      .catch((e) => console.warn('[sync-builtin-nodes] 内置节点同步失败（不影响启动）:', e))
      .finally(() => {
        void import('./maintenance')
          .then((m) => m.runMaintenance(true))
          .then((r) => {
            if (!r.skipped) console.log('[maintenance] 启动维护完成:', JSON.stringify(r))
          })
          .catch((e) => console.warn('[maintenance] 启动维护失败（不影响启动）:', e))
      })
  }, 30_000)

  return prisma
}

function getPrisma(): Promise<PrismaClient> {
  if (!prismaPromise) {
    prismaPromise = createPrismaClient()
  }
  return prismaPromise
}

export { getPrisma }
