/**
 * 浏览器通知（Web Notifications）—— 全站唯一实现。
 *
 * ===== 为什么抽出来 =====
 * 画布与 Copilot 面板各写了一份，**口径已经开始漂移**：
 *   - 画布：只在 document.hidden 时通知
 *   - Copilot：document.hidden **或面板收起** 时通知
 * 而 Agent 面板（第三个使用者）一份都没有。三处各写一份必然继续分叉。
 *
 * ===== 关键约束（决定了这个实现的形状） =====
 * 1) **不是所有场景都该弹通知**。用户正盯着看结果时弹一个系统通知是骚扰。
 *    所以默认策略是「页面不可见才弹」；调用方可用 force 覆盖
 *    （如面板被用户收起、但页面还可见 —— 这时他看不到结果，值得通知）。
 * 2) **权限必须由用户手势触发更可靠**。浏览器对「非手势调用 requestPermission」
 *    会静默忽略或直接拒绝（尤其 Safari）。所以这里不主动请求，
 *    只在页面首次有意义的交互后由调用方决定是否 requestNotifyPermission()。
 * 3) **页面关闭后发不出**。这是平台限制：Notification 必须在页面上下文里构造。
 *    页面彻底关闭后想通知需要 Service Worker + 服务端推送，是另一个量级的工程。
 *    所以本模块的定位是「页面还活着（哪怕在后台标签页）时提醒用户」。
 * 4) 通知不可用（不支持 / 被拒 / 抛错）一律**静默降级**，绝不影响主流程。
 */

export type NotifyOptions = {
  /** 即使页面可见也通知（如：结果在用户看不到的面板里） */
  force?: boolean
  /** 通知点击后聚焦窗口并执行（可选） */
  onClick?: () => void
}

/** 当前是否具备发通知的条件（不触发权限请求） */
export function canNotify(): boolean {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return false
  return Notification.permission === 'granted'
}

/**
 * 请求通知权限。
 *
 * 请在**用户手势**（点击发送按钮等）里调用 —— 浏览器对非手势调用普遍不信任，
 * Safari 会直接忽略，Chrome 也可能不再弹授权框。返回是否最终可用。
 */
export async function requestNotifyPermission(): Promise<boolean> {
  try {
    if (typeof window === 'undefined' || typeof Notification === 'undefined') return false
    if (Notification.permission === 'granted') return true
    if (Notification.permission === 'denied') return false // 用户已拒绝，不再骚扰
    const p = await Notification.requestPermission()
    return p === 'granted'
  } catch {
    return false
  }
}

/**
 * 发一条浏览器通知。
 *
 * 默认只在页面不可见时发（避免盯着屏幕还被系统通知打断）；
 * 传 force: true 可覆盖（如结果落在用户收起的面板里）。
 */
export function notify(title: string, body: string, opts: NotifyOptions = {}): void {
  try {
    if (!canNotify()) return
    // 页面可见且没有强制要求 → 用户看得到，不打扰
    if (!opts.force && typeof document !== 'undefined' && !document.hidden) return
    const n = new Notification(title, { body, icon: '/logo.svg' })
    if (opts.onClick) {
      n.onclick = () => {
        try { window.focus() } catch { /* 可能被浏览器拒绝 */ }
        try { opts.onClick?.() } catch { /* 回调异常不该冒泡 */ }
      }
    }
  } catch {
    /* 通知不可用（不支持/被拒/构造抛错）→ 静默降级，绝不影响主流程 */
  }
}
