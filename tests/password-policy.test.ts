import { describe, expect, it } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PASSWORD_MIN_LENGTH, isPasswordValid } from '@/lib/password-policy'
import { readSource } from './helpers/source-guard'

/**
 * 密码策略唯一口径（台账 Q-B03）。
 * 原来 6 这个数字散在 4 个服务端接口 + 3 个前端表单里，改策略必漏。
 */
describe('password-policy 校验边界', () => {
  it('刚好达到最小长度算合法，差一位不合法', () => {
    expect(isPasswordValid('a'.repeat(PASSWORD_MIN_LENGTH))).toBe(true)
    expect(isPasswordValid('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe(false)
  })

  it('非字符串（undefined / null / 数字）一律不合法，不抛错', () => {
    for (const v of [undefined, null, 123456, {}, []]) {
      expect(isPasswordValid(v)).toBe(false)
    }
  })
})

describe('密码长度不得再散落硬编码（源码守卫）', () => {
  it('API 路由里不出现密码长度的裸比较，必须走 isPasswordValid', () => {
    // 纯 Node 扫描：不依赖外部 rg / shell，避免 CI 环境差异导致误红
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) { walk(full); continue }
        if (!full.endsWith('.ts')) continue
        const src = readSource(full)
        // 命中「password*.length < 数字」或「< 6」这类裸长度判断
        if (/password\w*\.length\s*<\s*\d+/i.test(src)) offenders.push(full)
      }
    }
    walk('src/app/api')
    expect(offenders, `发现硬编码密码长度判断，请改用 lib/password-policy.ts：\n${offenders.join('\n')}`).toEqual([])
  })
})
