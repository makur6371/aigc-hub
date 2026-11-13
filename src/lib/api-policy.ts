// ===== 消耗性 API 的访问策略（单一来源）=====
//
// 为什么单独抽出来：proxy.ts 里原本手写了两份「拦截名单」——
//   1) NO_PHONE_BLOCKED_APIS：未绑定手机号不能用的接口
//   2) LOW_BLOCKED_PREFIXES：安全等级 LOW 不能用的接口
// 手写名单的问题是**新增消耗性接口时容易漏**：`/api/tools/[id]/run`（工具箱执行）
// 就漏在 LOW 名单外，LOW 用户可以直接跑工具消耗积分。`/api/audio/isolate`（人声分离）
// 同样漏了。
//
// 所以改成：**一处声明每个消耗性接口的策略，proxy 从这张表派生**。
// 新增接口时只要在下面加一行，两套拦截自动生效。

export interface ConsumingApiPolicy {
  /** 路径前缀 */
  prefix: string
  /** 未绑定手机号是否拦截（默认 true：消耗性接口都该拦） */
  requirePhone?: boolean
  /** 安全等级 LOW 是否拦截（默认 true：消耗性接口都该拦） */
  requireSecurity?: boolean
  /** 说明（便于后人理解为什么在名单里） */
  note: string
}

/**
 * 消耗性接口清单：会扣积分/豆、或会调用付费上游的接口。
 * 新增这类接口时**必须**在这里登记，否则会被 LOW 等级用户/未绑手机号用户绕过。
 */
export const CONSUMING_APIS: ConsumingApiPolicy[] = [
  { prefix: '/api/image/generate', note: '生图（扣积分）' },
  { prefix: '/api/video/generate', note: '生视频（扣豆）' },
  { prefix: '/api/audio/generate', note: '生音频（扣积分）' },
  { prefix: '/api/audio/isolate', note: '人声分离（扣积分）' },
  { prefix: '/api/canvas/execute', note: '画布执行（预扣积分/豆）' },
  { prefix: '/api/canvas/copilot', note: 'Copilot 对话（扣积分）' },
  // 工具箱执行：内部走 canvas 执行核心，同样消耗积分。
  // 之前漏在 LOW 名单外 —— 这条就是本文件存在的原因。
  { prefix: '/api/tools/', note: '工具箱执行（预扣积分/豆）' },
  { prefix: '/api/agent', note: 'Agent 对话/生成（扣积分/豆）' },
  // 管理接口：LOW 用户当然不能碰，但「未绑手机号」不该拦管理员
  { prefix: '/api/admin/adapters', requirePhone: false, note: '适配器管理（管理员）' },
]

/** 未绑定手机号需要拦截的 API 前缀 */
export const NO_PHONE_BLOCKED_PREFIXES = CONSUMING_APIS
  .filter((p) => p.requirePhone !== false)
  .map((p) => p.prefix)

/** 安全等级 LOW 需要拦截的 API 前缀 */
export const LOW_BLOCKED_PREFIXES = CONSUMING_APIS
  .filter((p) => p.requireSecurity !== false)
  .map((p) => p.prefix)

/** 判断路径是否命中某个前缀（前缀以 / 结尾时按 startsWith，否则按「等于或后跟 /」） */
export function matchesPrefix(pathname: string, prefix: string): boolean {
  if (prefix.endsWith('/')) return pathname.startsWith(prefix)
  return pathname === prefix || pathname.startsWith(prefix + '/')
}

export function hitsAny(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => matchesPrefix(pathname, p))
}
