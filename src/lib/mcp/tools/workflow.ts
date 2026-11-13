// 工作流 CRUD 工具：整包读写（get/update 整个 nodes+connections JSON）。
// 多租户隔离：所有查询强制 userId = ctx 里的 auth userId（绝不信客户端参数）。

import { getPrisma } from '@/lib/prisma'
import { sanitizeForAgent, checkWorkflowSize } from '../sanitize'
import type { ToolResult } from './types'

export async function listWorkflows(
  userId: string,
  args: { page?: number; pageSize?: number }
): Promise<ToolResult> {
  const prisma = await getPrisma()
  const page = Math.max(1, Math.min(Number(args.page) || 1, 100))
  const pageSize = Math.max(1, Math.min(Number(args.pageSize) || 30, 100))
  const [items, total] = await Promise.all([
    prisma.canvasWorkflow.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { id: true, name: true, createdAt: true, updatedAt: true },
    }),
    prisma.canvasWorkflow.count({ where: { userId } }),
  ])
  const structured = {
    total,
    page,
    pageSize,
    items: items.map((w) => ({
      id: w.id,
      name: w.name,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    })),
  }
  return {
    content: [{ type: 'text', text: `共 ${total} 个工作流，当前第 ${page} 页（每页 ${pageSize} 条）` }],
    structuredContent: structured,
  }
}

export async function getWorkflow(
  userId: string,
  args: { id: string; detail?: 'summary' | 'full' }
): Promise<ToolResult> {
  const prisma = await getPrisma()
  const wf = await prisma.canvasWorkflow.findFirst({
    where: { id: args.id, userId },
    select: { id: true, name: true, nodes: true, connections: true, updatedAt: true },
  })
  if (!wf) {
    return { content: [{ type: 'text', text: `工作流 ${args.id} 不存在或不属于你。先调 list_workflows 拿有效 id` }], isError: true }
  }
  if (args.detail === 'summary') {
    const nodes = Array.isArray(wf.nodes) ? (wf.nodes as Record<string, unknown>[]) : []
    const structured = {
      id: wf.id,
      name: wf.name,
      nodeCount: nodes.length,
      nodeTypes: nodes.map((n) => String((n as Record<string, unknown>).type || '?')),
      updatedAt: wf.updatedAt.toISOString(),
      hint: '这是摘要模式。要查看完整 nodes/connections 再调一次并传 detail="full"',
    }
    return { content: [{ type: 'text', text: `${wf.name}（${nodes.length} 节点）` }], structuredContent: structured }
  }
  const structured = {
    id: wf.id,
    name: wf.name,
    nodes: sanitizeForAgent(wf.nodes),
    connections: sanitizeForAgent(wf.connections),
    updatedAt: wf.updatedAt.toISOString(),
  }
  return { content: [{ type: 'text', text: `工作流 ${wf.name} 的完整 JSON` }], structuredContent: structured }
}

export async function createWorkflow(
  userId: string,
  args: { name: string; nodes: unknown[]; connections: unknown[] }
): Promise<ToolResult> {
  const sizeError = checkWorkflowSize(args.nodes, args.connections)
  if (sizeError) {
    return { content: [{ type: 'text', text: `创建失败：${sizeError}` }], isError: true }
  }
  const prisma = await getPrisma()
  const wf = await prisma.canvasWorkflow.create({
    data: {
      userId,
      name: args.name.slice(0, 60),
      nodes: args.nodes as object,
      connections: args.connections as object,
    },
  })
  return {
    content: [{ type: 'text', text: `已创建工作流「${wf.name}」（id: ${wf.id}），${args.nodes.length} 个节点` }],
    structuredContent: { id: wf.id, name: wf.name },
  }
}

export async function updateWorkflow(
  userId: string,
  args: { id: string; name?: string; nodes: unknown[]; connections: unknown[]; expectedUpdatedAt?: string }
): Promise<ToolResult> {
  const sizeError = checkWorkflowSize(args.nodes, args.connections)
  if (sizeError) {
    return { content: [{ type: 'text', text: `更新失败：${sizeError}` }], isError: true }
  }
  const prisma = await getPrisma()
  const existing = await prisma.canvasWorkflow.findFirst({ where: { id: args.id, userId } })
  if (!existing) {
    return { content: [{ type: 'text', text: `工作流 ${args.id} 不存在或不属于你。先调 list_workflows` }], isError: true }
  }
  // 乐观锁：expectedUpdatedAt 不匹配说明期间有其他写入（网页画布或另一 Agent 会话）
  if (args.expectedUpdatedAt) {
    const expected = new Date(args.expectedUpdatedAt)
    if (existing.updatedAt.getTime() !== expected.getTime()) {
      return {
        content: [{
          type: 'text',
          text: `更新冲突：工作流在 ${existing.updatedAt.toISOString()} 被修改过（你基于 ${args.expectedUpdatedAt} 的版本）。请重新 get_workflow 后合并修改再提交，避免覆盖他人改动`
        }],
        isError: true,
      }
    }
  }
  const wf = await prisma.canvasWorkflow.update({
    where: { id: existing.id },
    data: {
      ...(args.name ? { name: args.name.slice(0, 60) } : {}),
      nodes: args.nodes as object,
      connections: args.connections as object,
    },
  })
  return {
    content: [{ type: 'text', text: `已更新工作流「${wf.name}」（${args.nodes.length} 个节点，updatedAt: ${wf.updatedAt.toISOString()}）` }],
    structuredContent: { id: wf.id, updatedAt: wf.updatedAt.toISOString() },
  }
}
