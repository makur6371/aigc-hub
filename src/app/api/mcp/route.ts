// MCP 远程端点（Streamable HTTP，2026-07-28 spec，stateless）。
// 鉴权：Bearer 配对码（mkp_...）→ verifyPairingCode 查库；AuthInfo.extra.userId 供工具租户隔离。
// proxy 放行本路径（PUBLIC_PREFIXES），本文件自验身份。
// 说明：不用 mcp-handler 的 withMcpAuth——它把 verifyToken 抛出的所有错误统一改写成
// "Invalid token"，丢失我们给用户/Agent 的具体中文原因（撤销/过期/频控）。自包装可完全控制。

import { createMcpHandler } from 'mcp-handler'
import { OAuthError, OAuthErrorCode, bearerAuthChallengeResponse } from '@modelcontextprotocol/server'
import { registerCanvasTools } from '@/lib/mcp/server'
import { verifyPairingCode, toAuthInfo } from '@/lib/mcp/auth'
import { ORG } from '@/lib/site-content'

// 每请求都重建 server 实例（stateless、多用户隔离），注册成本可忽略
const mcpHandler = createMcpHandler(
  (server) => {
    registerCanvasTools(server)
  },
  {
    serverInfo: { name: 'aigc-hub-aigchub-canvas', version: '1.0.0' },
    instructions:
      `${ORG.name}画布 MCP（原 AIGC Hub）：用 list_node_types + list_models 了解可用节点与模型，用 create_workflow/run_workflow 搭建并运行 AI 工作流（文生图、LLM、视频、批量提示词等）。整包读写：改工作流前先 get_workflow。`,
  }
)

const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource'

function challenge(error: OAuthError, req: Request): Response {
  const origin = new URL(req.url).origin
  return bearerAuthChallengeResponse(error, { resourceMetadataUrl: `${origin}${RESOURCE_METADATA_PATH}` })
}

async function authedHandler(req: Request): Promise<Response> {
  try {
    const { auth } = await verifyPairingCode(req)
    if (!auth) {
      return challenge(new OAuthError(OAuthErrorCode.InvalidToken, '未授权'), req)
    }
    // 把身份挂到 request.auth（SDK 约定），工具 ctx.http.authInfo 从这里来
    ;(req as Request & { auth?: unknown }).auth = toAuthInfo(auth, '')
    return mcpHandler(req)
  } catch (err) {
    if (err instanceof OAuthError) {
      return challenge(err, req) // 携带中文原因（撤销/过期/频控）的 401
    }
    console.error('MCP auth unexpected error:', err)
    return challenge(new OAuthError(OAuthErrorCode.ServerError, '服务器内部错误'), req)
  }
}

export async function GET(request: Request) {
  return authedHandler(request)
}

export async function POST(request: Request) {
  return authedHandler(request)
}

export async function DELETE(request: Request) {
  return authedHandler(request)
}

// Next.js route 配置：MCP 请求体可能较大（整包 workflow JSON），不做默认大小/缓存干预
export const dynamic = 'force-dynamic'
