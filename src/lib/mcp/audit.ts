// MCP 审计日志：每次工具调用记一行（tool/参数摘要/token/IP/结果）。
// 写 DB（复用 apiUsageLog 表语义不合适，独立轻量记录走 console 结构化日志 + 可选 DB）。
// MVP：console 结构化日志（生产 docker logs 可 grep MCP_AUDIT）；后续量级上来再落库。

import { clientIp } from './auth'

export function mcpAudit(opts: {
  tool: string
  userId: string
  pairingName: string
  argsSummary: string
  ok: boolean
  durationMs?: number
  request?: Request
}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    kind: 'MCP_AUDIT',
    tool: opts.tool,
    userId: opts.userId,
    pairing: opts.pairingName,
    ip: opts.request ? clientIp(opts.request) : undefined,
    ok: opts.ok,
    durationMs: opts.durationMs,
    args: opts.argsSummary.slice(0, 300),
  })
  console.log(line)
}

/** 工具参数摘要：只保留顶层键与几个关键短字段，避免把整包 nodes 打进日志 */
export function summarizeArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args)
  const parts: string[] = []
  for (const k of keys) {
    const v = args[k]
    if (typeof v === 'string' && v.length <= 80) parts.push(`${k}=${v}`)
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}=${v}`)
    else if (Array.isArray(v)) parts.push(`${k}=[${v.length} items]`)
    else if (v && typeof v === 'object') parts.push(`${k}={object}`)
    else parts.push(`${k}=${String(v).slice(0, 40)}`)
  }
  return parts.join(' ')
}
