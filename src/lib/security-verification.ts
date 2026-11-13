export interface SecurityProfile {
  phone: string | null
  nickname: string | null
  socialUid: string | null
  hasPassword: boolean
  securityVerifiedAt?: Date | null
}

export function missingSecurityRequirements(user: SecurityProfile): string[] {
  const missing: string[] = []
  if (!user.phone) missing.push('手机号')
  if (!user.hasPassword) missing.push('密码')
  if (!user.socialUid) missing.push('微信')
  if (!user.nickname?.trim()) missing.push('昵称')
  return missing
}

export function isSecurityVerified(user: Pick<SecurityProfile, 'securityVerifiedAt'>): boolean {
  return user.securityVerifiedAt != null
}
