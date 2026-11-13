import { NextRequest } from 'next/server'
import { randomBytes } from 'crypto'
import { getPrisma } from '@/lib/prisma'
import { apiHandler, requireAuth, ApiHandlerError } from '@/lib/api-handler'
// 配对码哈希与验码侧共用同一实现（lib/mcp/auth），避免两处口径漂移（台账 Q-111）
import { hashCode } from '@/lib/mcp/auth'

// 配对码：明文 mkp_<32字节base64url>（~43 字符），仅 POST 响应返回一次；DB 只存 sha256
function generatePairingCode(): string {
  return `mkp_${randomBytes(32).toString('base64url')}`
}

// 列表：当前用户全部配对码（脱敏，无明文）
export const GET = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)
  const prisma = await getPrisma()

  const pairings = await prisma.mcpPairing.findMany({
    where: { userId: authUser.userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      codeTail: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
      lastUsedIp: true,
      createdAt: true,
    },
  })

  return pairings.map((p) => ({
    ...p,
    expiresAt: p.expiresAt.toISOString(),
    revokedAt: p.revokedAt?.toISOString() ?? null,
    lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
  }))
})

// 生成：明文码仅本次响应返回一次
export const POST = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)

  const body = await request.json().catch(() => ({}))
  const name = typeof body?.name === 'string' && body.name.trim()
    ? body.name.trim().slice(0, 30)
    : 'MCP 接入'
  // 有效期：默认 90 天，上限 365 天
  const days = Math.min(Math.max(Number(body?.days) || 90, 1), 365)

  const prisma = await getPrisma()

  // 单用户最多 10 个有效配对码，防堆积
  const activeCount = await prisma.mcpPairing.count({
    where: { userId: authUser.userId, revokedAt: null, expiresAt: { gt: new Date() } },
  })
  if (activeCount >= 10) {
    throw new ApiHandlerError('配对码数量已达上限（10 个），请先撤销不用的配对码', 400)
  }

  const code = generatePairingCode()
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000)

  const pairing = await prisma.mcpPairing.create({
    data: {
      userId: authUser.userId,
      name,
      codeHash: hashCode(code),
      codeTail: code.slice(-4),
      expiresAt,
    },
  })

  return {
    id: pairing.id,
    name: pairing.name,
    code, // 明文仅此一次
    codeTail: pairing.codeTail,
    expiresAt: expiresAt.toISOString(),
    createdAt: pairing.createdAt.toISOString(),
  }
})

// 撤销：body { id }
export const DELETE = apiHandler(async (request: NextRequest) => {
  const authUser = await requireAuth(request)
  const body = await request.json().catch(() => null)
  const id = body?.id
  if (!id) throw new ApiHandlerError('缺少 id', 400)

  const prisma = await getPrisma()
  const pairing = await prisma.mcpPairing.findUnique({ where: { id } })
  // 无权限与不存在同报 404（不泄露他人配对码存在性）
  if (!pairing || pairing.userId !== authUser.userId) {
    throw new ApiHandlerError('配对码不存在', 404)
  }
  if (pairing.revokedAt) {
    throw new ApiHandlerError('该配对码已撤销', 400)
  }

  await prisma.mcpPairing.update({
    where: { id },
    data: { revokedAt: new Date() },
  })

  return { id, revoked: true }
})
