import { getPrisma } from '@/lib/prisma'

/**
 * Agent 任务取消信号。
 *
 * 单独放在叶子模块，避免 agent-executor 与 agent-tool-loop 互相 import 运行时值，
 * 再次踩到 TDZ / 循环依赖问题。
 */
export class AgentCancelledError extends Error {
  constructor(message = '任务已取消') {
    super(message)
    this.name = 'AgentCancelledError'
  }
}

type GenerationTaskReader = {
  findUnique?: (args: {
    where: { id: string }
    select: { status: true }
  }) => Promise<{ status: string } | null>
}

/**
 * 读取任务是否已被用户取消。
 *
 * 对测试/轻量调用保持容错：没有 generationTask delegate 时视为未取消，
 * 这样纯函数测试不必为取消能力补一整套 Prisma mock。
 */
export async function isAgentTaskCancelled(taskId: string | null | undefined): Promise<boolean> {
  if (!taskId) return false
  const prisma = await getPrisma()
  const delegate = (prisma as unknown as { generationTask?: GenerationTaskReader }).generationTask
  if (!delegate?.findUnique) return false
  const task = await delegate.findUnique({
    where: { id: taskId },
    select: { status: true },
  })
  return task?.status === 'CANCELLED'
}

/** 执行动作前调用；取消是正常业务状态，不应当被写成 FAILED。 */
export async function assertAgentTaskActive(taskId: string | null | undefined): Promise<void> {
  if (await isAgentTaskCancelled(taskId)) throw new AgentCancelledError()
}
