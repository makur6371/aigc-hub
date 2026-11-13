import { BUILTIN_NODES } from './canvas-nodes'

/**
 * 把源码里的 BUILTIN_NODES 幂等 upsert 进 canvas_node_specs。
 *
 * 为什么必须有这一步：内置节点的**权威定义在源码**（`src/lib/canvas-nodes.ts`），
 * 但执行层 `executeCustomNode` 只查 DB 的 codeSchema。过去靠管理员手点
 * 「同步内置节点」，于是形成「改了源码但线上行为不变」的静默坑
 * （DB 与源码逐字段比对历史上一直相同，说明只是没人发现这个依赖）。
 *
 * 现在在服务启动时随 prisma 一起跑一次，语义对齐 Dockerfile 里的
 * `prisma db push`：**部署即同步**，源码改动不需要人记得去点按钮。
 *
 * 刻意只 upsert 不删除：DB 里可能是用户自建的同 nodeType 记录（虽被 create 前的
 * 唯一性检查挡住，但老数据不保证），也可能是已被禁用的内置节点 ——
 * 禁用状态（isDisabled）由管理员掌控，同步绝不触碰，否则一次部署就把
 * 运维刻意禁用的节点重新放出来了。
 *
 * 任何失败都不能阻断启动：节点库退化成「只有 DB 里已有的记录」，
 * 与同步前的线上表现一致。
 */
export async function syncBuiltinNodes(): Promise<{ synced: number; updated: number }> {
  const { getPrisma } = await import('./prisma')
  const prisma = await getPrisma()

  let synced = 0
  let updated = 0

  for (const node of BUILTIN_NODES) {
    try {
      const existing = await prisma.canvasNodeSpec.findFirst({
        where: { nodeType: node.type },
        select: { id: true },
      })

      if (existing) {
        await prisma.canvasNodeSpec.update({
          where: { id: existing.id },
          data: {
            label: node.label,
            category: node.category,
            description: node.description,
            inputs: node.inputs as object,
            outputs: node.outputs as object,
            codeSchema: node.codeSchema,
            isOfficial: true,
          },
        })
        updated++
      } else {
        await prisma.canvasNodeSpec.create({
          data: {
            nodeType: node.type,
            label: node.label,
            category: node.category,
            description: node.description,
            inputs: node.inputs as object,
            outputs: node.outputs as object,
            codeSchema: node.codeSchema,
            isOfficial: true,
          },
        })
        synced++
      }
    } catch (err) {
      // 单个节点失败不拖垮整轮：其余节点继续同步，日志留痕。
      console.error(`[sync-builtin-nodes] ${node.type} 同步失败:`, err)
    }
  }

  return { synced, updated }
}
