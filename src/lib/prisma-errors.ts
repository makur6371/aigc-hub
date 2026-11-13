import { Prisma } from '@prisma/client'

// ===== Prisma 唯一约束错误的统一识别 =====
// 身份字段（phone / email / social_uid）在库层面都是 UNIQUE，是「一微信一账号、一手机号一账号」的最终保障。
// 但业务代码在写入前做的 findFirst/findUnique 预检查存在 TOCTOU 竞态：
//   两个请求同时通过预检查 → 同时写入 → 第二个撞 UNIQUE 约束。
// 若不识别该错误，用户会看到 500「服务器内部错误」而不是「该手机号已绑定其他账号」。
// 这里统一识别，让所有绑定路径都能给出友好且准确的提示。

/** 唯一约束冲突的字段名（如 'phone' / 'email' / 'social_uid'）；非唯一约束错误返回 null */
export function uniqueConstraintField(err: unknown): string | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return null
  if (err.code !== 'P2002') return null
  // meta.target 是字段数组（不同驱动/版本形态略有差异，逐个兜底）
  const meta = err.meta as
    | { target?: unknown; driverAdapterError?: { cause?: { constraint?: { fields?: unknown } } } }
    | undefined
  const candidates = [
    meta?.target,
    meta?.driverAdapterError?.cause?.constraint?.fields,
  ]
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) return String(c[0])
    if (typeof c === 'string' && c) return c
  }
  // 最后兜底：从错误消息里解析 "Unique constraint failed on the fields: (`phone`)"
  const m = /fields:\s*\(?`?([a-zA-Z_]+)`?\)?/.exec(err.message)
  return m ? m[1] : null
}

/** 是否为指定字段的唯一约束冲突（不传 field 则任意唯一冲突都算） */
export function isUniqueConstraintError(err: unknown, field?: string): boolean {
  const f = uniqueConstraintField(err)
  if (f === null) return false
  return field ? f === field : true
}
