// 大陆手机号校验：格式正则 + 工信部已放号段白名单
// 无短信验证码场景下防乱填：拦截「12345678901」「11111111111」等格式正确但号段未放号的号码
const PHONE_PATTERN = /^1\d{10}$/

// 已放号前缀（三位号段）：130-139、145-149、150-153/155-159、162/165-167、170-178、180-189、190-193/195-199
const VALID_PREFIXES = new Set([
  ...range('130', '139'),
  ...range('145', '149'),
  ...range('150', '153'),
  ...range('155', '159'),
  '162',
  ...range('165', '167'),
  ...range('170', '178'),
  ...range('180', '189'),
  ...range('190', '193'),
  ...range('195', '199'),
])

function range(from: string, to: string): string[] {
  const out: string[] = []
  for (let i = Number(from); i <= Number(to); i++) out.push(String(i))
  return out
}

export function isValidMainlandPhone(phone: unknown): boolean {
  if (typeof phone !== 'string' || !PHONE_PATTERN.test(phone)) return false
  return VALID_PREFIXES.has(phone.slice(0, 3))
}
