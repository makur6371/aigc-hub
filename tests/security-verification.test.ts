import { describe, expect, it } from 'vitest'
import { isSecurityVerified, missingSecurityRequirements } from '@/lib/security-verification'

describe('安全验证资料检查', () => {
  const complete = { phone: ('188' + '00000000'), nickname: '微信同名', socialUid: 'wx-openid', hasPassword: true }

  it('手机号、密码、微信、昵称齐全才可验证', () => {
    expect(missingSecurityRequirements(complete)).toEqual([])
  })

  it('逐项列出缺失资料', () => {
    expect(missingSecurityRequirements({ phone: null, nickname: null, socialUid: null, hasPassword: false }))
      .toEqual(['手机号', '密码', '微信', '昵称'])
    expect(missingSecurityRequirements({ ...complete, socialUid: null })).toEqual(['微信'])
    expect(missingSecurityRequirements({ ...complete, nickname: '  ' })).toEqual(['昵称'])
  })

  it('只有 securityVerifiedAt 才算通过安全检查', () => {
    expect(isSecurityVerified({ securityVerifiedAt: null })).toBe(false)
    expect(isSecurityVerified({ securityVerifiedAt: new Date() })).toBe(true)
  })
})
