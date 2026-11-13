/**
 * 密码策略的唯一口径（台账 Q-B03）。
 *
 * 原来最小长度 6 硬编码在 4 个服务端接口 + 3 个前端表单里：
 * 数值虽然一致，但一旦要调整策略（比如提到 8 位或加复杂度），必然漏改某处，
 * 出现「前端放行、后端拒绝」或反之的不一致。集中到这里，改一处即全端生效。
 */
export const PASSWORD_MIN_LENGTH = 6

/** 服务端校验：非字符串或长度不足都视为不合法 */
export function isPasswordValid(value: unknown): boolean {
  return typeof value === 'string' && value.length >= PASSWORD_MIN_LENGTH
}

/** 前端展示文案用的片段（保持各表单原有语境，只有数值来自同一常量） */
export const PASSWORD_MIN_HINT = `至少 ${PASSWORD_MIN_LENGTH} 位`
