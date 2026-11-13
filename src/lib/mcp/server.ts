// MCP Server 工厂：注册画布工具（9 个）+ 基础生图工具（4 个）。
// 画布 = 让 Agent 搭/跑工作流；基础生图 = 文生图/图生图这两条独立链路（见 tools/image.ts 顶部说明）。
// 工具 handler 从 ctx.http.authInfo.extra.userId 取身份。
// 分层：本文件只做注册与装配；业务实现在 tools/{workflow,run,catalog}.ts。

import { McpServer } from '@modelcontextprotocol/server'
import type { ServerContext } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { listWorkflows, getWorkflow, createWorkflow, updateWorkflow } from './tools/workflow'
import { runWorkflow, getRun, cancelRun } from './tools/run'
import { listNodeTypes, listModels } from './tools/catalog'
import { uploadImage, generateImageTool, editImageTool, listImages } from './tools/image'
import { mcpAudit, summarizeArgs } from './audit'
import { error } from './tools/types'
import type { ToolResult } from './tools/types'

// 从 ServerContext 取已验证的用户（withMcpAuth 的 verifyToken 塞进 authInfo.extra）
function userIdOf(ctx: ServerContext): string {
  const uid = ctx.http?.authInfo?.extra?.userId
  if (typeof uid !== 'string' || !uid) throw new Error('未授权：缺少配对码身份')
  return uid
}

function pairingNameOf(ctx: ServerContext): string {
  const n = ctx.http?.authInfo?.extra?.pairingName
  return typeof n === 'string' ? n : 'unknown'
}

// 统一包装：错误→isError 中文文本；审计。返回值对齐 SDK CallToolResult（ToolResult 结构兼容）。
// 注意：SDK 对无 inputSchema 的工具按 (ctx) 单参回调；为统一签名，无参工具也包一层 args=()。
function wrap<TArgs>(
  tool: string,
  fn: (userId: string, args: TArgs, ctx: ServerContext) => Promise<ToolResult>
) {
  const inner = async (args: TArgs, ctx: ServerContext): Promise<ToolResult> => {
    const startedAt = Date.now()
    try {
      const userId = userIdOf(ctx)
      const result = await fn(userId, args, ctx)
      mcpAudit({
        tool, userId, pairingName: pairingNameOf(ctx),
        argsSummary: summarizeArgs(args as Record<string, unknown>),
        ok: !result.isError, durationMs: Date.now() - startedAt,
      })
      // MCP 规范（2025-06-18 / 2026-07-28）：返回 structuredContent 的工具 SHOULD 同时在
      // TextContent 里给出序列化 JSON，兜底只读 content 的客户端（如 WorkBuddy）
      if (result.structuredContent) {
        const json = JSON.stringify(result.structuredContent, null, 2)
        const blocks = Array.isArray(result.content) ? result.content : []
        const textBlock = blocks.find((b) => b.type === 'text')
        if (textBlock) {
          textBlock.text = `${textBlock.text}\n\n${json}`
        } else {
          result.content = [{ type: 'text', text: json }, ...blocks]
        }
      }
      return result
    } catch (err) {
      mcpAudit({
        tool, userId: 'unknown', pairingName: pairingNameOf(ctx),
        argsSummary: summarizeArgs(args as Record<string, unknown>),
        ok: false, durationMs: Date.now() - startedAt,
      })
      return error(`工具执行异常：${err instanceof Error ? err.message : '未知错误'}`)
    }
  }
  // SDK 对无 inputSchema 的工具按 (ctx) 单参回调；这里统一成双参形态并兼容单参调用
  return ((a: unknown, b?: unknown) =>
    b !== undefined ? inner(a as TArgs, b as ServerContext) : inner({} as TArgs, a as ServerContext)
  ) as unknown as (args: TArgs, ctx: ServerContext) => Promise<ToolResult>
}

export function registerCanvasTools(server: McpServer): void {
  // ===== 目录（只读，Agent 搭建前先读） =====
  server.registerTool(
    'list_node_types',
    {
      title: '节点类型目录',
      description:
        '列出画布全部节点类型及每个节点的 inputs/outputs 端口定义。搭建任何工作流之前必须先调用本工具了解可用节点和端口类型。返回约 24 种节点，体积小。',
      annotations: { readOnlyHint: true },
    },
    wrap('list_node_types', async () => listNodeTypes())
  )

  server.registerTool(
    'list_models',
    {
      title: '模型清单',
      description:
        '列出当前可用的 AI 模型（含每次调用的积分单价）。llm-chat / image-generate / video-generate 节点的 inputs.model 需填这里返回的模型 id；不填则系统自动选该类型第一个可用模型。可用 type 参数按 TEXT/VISION/IMAGE/VIDEO/AUDIO 过滤。',
      inputSchema: z.object({
        type: z.string().optional().describe('按类型过滤：TEXT / VISION / IMAGE / VIDEO / AUDIO'),
      }),
      annotations: { readOnlyHint: true },
    },
    wrap<{ type?: string }>('list_models', async (_uid, args) => listModels(args))
  )

  // ===== 工作流 CRUD（整包读写） =====
  server.registerTool(
    'list_workflows',
    {
      title: '我的工作流列表',
      description:
        '列出你的画布工作流（仅摘要：id/名称/时间，不含节点内容）。每页默认 30 条、上限 100。要查看内容需再调 get_workflow。',
      inputSchema: z.object({
        page: z.number().int().min(1).optional().describe('页码，默认 1'),
        pageSize: z.number().int().min(1).max(100).optional().describe('每页条数，默认 30'),
      }),
      annotations: { readOnlyHint: true },
    },
    wrap('list_workflows', (uid, args) => listWorkflows(uid, args))
  )

  server.registerTool(
    'get_workflow',
    {
      title: '读取工作流',
      description:
        '读取一个工作流。detail="summary" 只返回节点类型列表（省 token，推荐先看摘要）；detail="full" 返回完整 nodes+connections JSON（可能较大，含的图片已替换为占位摘要）。修改前务必先 get 再改。',
      inputSchema: z.object({
        id: z.string().describe('工作流 id（list_workflows 返回的）'),
        detail: z.enum(['summary', 'full']).optional().describe('summary=只看结构摘要（默认）；full=完整 JSON'),
      }),
      annotations: { readOnlyHint: true },
    },
    wrap('get_workflow', (uid, args) => getWorkflow(uid, args))
  )

  server.registerTool(
    'create_workflow',
    {
      title: '创建工作流',
      description:
        '创建一个新工作流（整包写入）。nodes 数组每个元素形如 {id, type, label, category, x, y, inputs, outputs}；connections 形如 {id, sourceNodeId, sourcePort, targetNodeId, targetPort}。节点类型和端口签名先从 list_node_types 获取。禁止在 nodes 里内嵌 base64 图片数据——图片一律用 http(s) URL。节点上限 100 个、整包 2MB。',
      inputSchema: z.object({
        name: z.string().min(1).max(60).describe('工作流名称'),
        nodes: z.array(z.record(z.string(), z.unknown())).describe('节点数组'),
        connections: z.array(z.record(z.string(), z.unknown())).describe('连线数组'),
      }),
    },
    wrap('create_workflow', (uid, args) => createWorkflow(uid, args))
  )

  server.registerTool(
    'update_workflow',
    {
      title: '更新工作流（整包覆盖）',
      description:
        '以整包方式覆盖一个已有工作流的 nodes/connections。注意：这是全量覆盖，不是增量修改——必须先 get_workflow(detail="full") 拿到当前完整内容，在它的基础上修改后整包提交，否则会丢掉你没带上的节点。可选 expectedUpdatedAt（get 时返回的 updatedAt）做乐观锁，冲突时会拒绝并提示重新读取。禁止内嵌 base64 图片。',
      inputSchema: z.object({
        id: z.string().describe('要更新的工作流 id'),
        name: z.string().min(1).max(60).optional().describe('可选：改工作流名'),
        nodes: z.array(z.record(z.string(), z.unknown())).describe('完整节点数组（覆盖式）'),
        connections: z.array(z.record(z.string(), z.unknown())).describe('连线数组（覆盖式）'),
        expectedUpdatedAt: z.string().optional().describe('乐观锁：get_workflow 返回的 updatedAt；不传则跳过检查'),
      }),
    },
    wrap('update_workflow', (uid, args) => updateWorkflow(uid, args))
  )

  // ===== 运行 =====
  server.registerTool(
    'run_workflow',
    {
      title: '运行画布',
      description:
        '运行一段画布工作流（不必先保存）。同步等待执行完成后返回各节点 outputs（图片节点的 imageUrl 可直接使用）。计费：按节点所用模型实时扣积分，生成失败自动退还未消耗部分。nodes≤100、整包≤2MB、禁止 base64 图片（用 URL）。长视频生成可能需要数分钟。',
      inputSchema: z.object({
        nodes: z.array(z.record(z.string(), z.unknown())).describe('节点数组（同 create_workflow 结构）'),
        connections: z.array(z.record(z.string(), z.unknown())).describe('连线数组'),
        workflowName: z.string().max(60).optional().describe('可选：本次运行的名称（记录在运行历史里）'),
        executeNodeIds: z.array(z.string()).optional().describe('可选：只运行指定节点（增量执行，其余节点输入取 seedOutputs）'),
        seedOutputs: z.record(z.string(), z.record(z.string(), z.unknown())).optional().describe('可选：增量执行时提供上游节点输出 {nodeId: {port: value}}'),
      }),
    },
    wrap('run_workflow', (uid, args) => runWorkflow(uid, args))
  )

  server.registerTool(
    'get_run',
    {
      title: '查询运行状态',
      description:
        '查询一次画布运行的当前状态、消耗与最终输出（成功时 outputs 在 seedOutputs 字段）。run_workflow 长时间未返回或被网络切断时，可用 get_run 轮询补救。',
      inputSchema: z.object({
        runId: z.string().describe('运行记录 id（run_workflow 返回的 runId）'),
      }),
      annotations: { readOnlyHint: true },
    },
    wrap('get_run', (uid, args) => getRun(uid, args))
  )

  server.registerTool(
    'cancel_run',
    {
      title: '取消运行',
      description:
        '取消一个正在运行/暂停的画布执行。执行器会在下一个节点边界停止，未消耗的积分自动退还。',
      inputSchema: z.object({
        runId: z.string().describe('运行记录 id'),
      }),
    },
    wrap('cancel_run', (uid, args) => cancelRun(uid, args))
  )

  // ===== 基础生图（文生图 / 图生图）=====
  // 只放开两条真正不同的链路。放大/抠图/去水印/翻译本质是 edit_image + 一段提示词，
  // 不单独建工具 —— 否则 Agent 要先记 4 个工具名，反而更难用。

  server.registerTool(
    'upload_image',
    {
      title: '上传参考图',
      description:
        '把本地图片交给我们，换回一个公网 URL（用于图生图）。' +
        '入参收 base64，返回的**只有 URL**（不回 base64，避免撑爆你的上下文）。' +
        '图生图前请先用本工具把图片换成 URL，再传给 edit_image 的 referenceImages。' +
        '临时素材 2 小时后自动清理。',
      inputSchema: z.object({
        data: z.string().describe('图片内容：完整 data URL（data:image/png;base64,...）或裸 base64'),
        fileName: z.string().optional().describe('可选：文件名（帮助识别格式）'),
        mime: z.string().optional().describe('可选：MIME 类型，如 image/png；data URL 里带了就不用给'),
      }),
    },
    wrap<{ data: string; fileName?: string; mime?: string }>('upload_image', (uid, args) => uploadImage(uid, args))
  )

  server.registerTool(
    'generate_image',
    {
      title: '文生图',
      description:
        '根据文字描述生成图片（文生图）。任务按平台统一口径计费（预扣 + 失败自动退款），' +
        '产出会记进"我的图片"，可用 list_images 查看。' +
        '不知道用哪个模型就先调 list_models。',
      inputSchema: z.object({
        prompt: z.string().describe('画面描述'),
        modelId: z.string().optional().describe('模型 id（用 list_models 查）；省略则用平台默认'),
        width: z.number().int().positive().optional().describe('宽度（像素）'),
        height: z.number().int().positive().optional().describe('高度（像素）'),
        count: z.number().int().min(1).max(4).optional().describe('生成张数，默认 1'),
      }),
    },
    wrap<{ prompt: string; modelId?: string; width?: number; height?: number; count?: number }>(
      'generate_image', (uid, args) => generateImageTool(uid, args)
    )
  )

  server.registerTool(
    'edit_image',
    {
      title: '图生图',
      description:
        '基于参考图生成新图（图生图）。高清放大 / 抠图 / 去水印 / 翻译 / 换风格等**都用本工具** ——' +
        '它们只是在 prompt 里写不同的指令，不需要另外的工具。' +
        'referenceImages 必须是可以公网访问的 URL：本地图片先用 upload_image 换 URL。' +
        'prompt 里不要复述参考图上已可见的颜色/材质，只写要改什么。',
      inputSchema: z.object({
        prompt: z.string().describe('要做什么改动（如"放大到高清，保持构图与文字不变"）'),
        referenceImages: z.array(z.string()).min(1).max(6).describe('参考图 URL 数组（upload_image 返回的 url）'),
        modelId: z.string().optional().describe('模型 id（用 list_models 查）；省略则用平台默认'),
        width: z.number().int().positive().optional().describe('输出宽度'),
        height: z.number().int().positive().optional().describe('输出高度'),
      }),
    },
    wrap<{ prompt: string; referenceImages: string[]; modelId?: string; width?: number; height?: number }>(
      'edit_image', (uid, args) => editImageTool(uid, args)
    )
  )

  server.registerTool(
    'list_images',
    {
      title: '查看生成记录',
      description:
        '查看历史生成记录与积分消耗（含图片 URL、状态、失败原因）。' +
        '用于确认"刚才那张生成了没""一共花了多少积分"，以及找回之前生成图的 URL。' +
        '注意：上游链接会过期，返回里标注了 expired。',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).optional().describe('返回条数，默认 10'),
        status: z.enum(['success', 'failed', 'all']).optional().describe('按状态过滤，默认全部'),
      }),
      annotations: { readOnlyHint: true },
    },
    wrap<{ limit?: number; status?: string }>('list_images', (uid, args) => listImages(uid, args))
  )
}
