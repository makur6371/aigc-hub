import { randomInt } from 'node:crypto'
import { getPrisma } from './prisma'

let cachedPolicy: { codeExpiryMinutes: number; resendCooldownSec: number } | null = null

export async function getVerificationPolicy(): Promise<{ codeExpiryMinutes: number; resendCooldownSec: number }> {
  if (cachedPolicy) return cachedPolicy
  const prisma = await getPrisma()
  const record = await prisma.verificationPolicy.findUnique({ where: { id: 'primary' } })
  cachedPolicy = {
    codeExpiryMinutes: record?.codeExpiryMinutes ?? 10,
    resendCooldownSec: record?.resendCooldownSec ?? 60,
  }
  return cachedPolicy
}

export function clearPolicyCache() {
  cachedPolicy = null
}

// 生成 6 位数字验证码
export function generateCode(): string {
  // 密码学安全随机（Q-D22）：验证码是爆破目标，Math.random 的可预测性不可接受
  return randomInt(100000, 1000000).toString()
}
