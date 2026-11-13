/**
 * 浏览器本地存储的**唯一规范层**（Q-D55）。
 *
 * ===== 为什么要有这一层 =====
 * 本仓库长期是「各处自己读写 localStorage」：全库 **16 个文件、53 处调用**，
 * 键名约定十余套并存（`copilot-model`、`canvas-draft-v1`、`toolhub:results`、
 * `aigc-hub:quick-favorites:v1`…）。由此产生的三个真实问题：
 *
 * 1. **失败行为按「作者当时想到没有」随机**。Safari 隐私模式 / 配额满时
 *    `setItem` 会抛 QuotaExceededError：包了 try/catch 的只是丢掉这份记忆，
 *    **没包的会打断当次操作**（用户在选模型时突然报错）。这不是理论风险。
 * 2. **改数据结构无从迁移**。键没有统一前缀与版本策略，旧结构坏掉时只能
 *    靠各处自己 try/catch 兜住，症状是「某处记忆莫名失效」。
 * 3. **跨设备语义混乱，而且已经踩过**：`lib/notify.ts` 的注释自己写着 ——
 *    站内通知用服务端 `readAt`（「换设备登录也该是已读」），
 *    而全局公告用 localStorage（「会出现这台已读、那台还红点」）。
 *
 * ===== 这一层刻意**不**做的事 =====
 * **不改现有键名**。统一前缀很容易想到，但一改，全站用户的
 * 已存模型、画布草稿、默认参数、已读公告**全部消失** ——
 * 那是拿一次「架构统一」换一次用户可见的功能倒退。
 * 所以：前缀与版本是**新增键的规矩**（由守卫测试守着），
 * 存量键原样保留并逐步迁移（例外表只减不增）。
 *
 * ===== 与「站内地址」判定的关系 =====
 * `isSiteRelativePath` 也放这里：`quick-favorites` 用 `href.startsWith('/')`
 * 判站内，而 `//evil.com` 同样以 `/` 开头（协议相对 URL，浏览器会当外站打开）。
 * 「什么算站内地址」本该有唯一实现（同 `lib/media-url.ts` 的教训）。
 */

/** 新键的前缀约定：统一前缀 + 显式版本号。 */
export const LOCAL_STORE_PREFIX = 'aigc-hub:'

/** 新键的推荐形态：`aigc-hub:<名字>:v1`。 */
export function localStoreKey(name: string, version = 1): string {
  return `${LOCAL_STORE_PREFIX}${name}:v${version}`
}

/**
 * localStorage 是否真的可用。
 *
 * Safari 无痕模式里 `window.localStorage` **存在但一写就抛**，
 * 所以不能用 `typeof localStorage !== 'undefined'` 判断 ——
 * 必须真的写一次再删掉。
 */
export function isLocalStorageAvailable(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const probe = `${LOCAL_STORE_PREFIX}__probe__`
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return true
  } catch {
    return false
  }
}

/** 读原始文本。任何异常都返回 null（调用方决定回落值）。 */
export function readLocalText(key: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/**
 * 写原始文本。**永不抛错**，失败返回 false。
 *
 * 返回 false 的两种典型原因：隐私模式、配额已满。
 * 调用方据此决定「这次记忆没存上」要不要提示用户 ——
 * 但**绝不能**因为存不上就中断当前操作。
 */
export function writeLocalText(key: string, value: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    window.localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

/** 删除键。永不抛错。 */
export function removeLocalKey(key: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* 删不掉就算了，不影响主流程 */
  }
}

/**
 * 读 JSON。**永不抛错**。
 *
 * `validate` 是**形状校验**：旧版本结构、手工改坏的数据、别人的数据
 * 都可能不符合当前形状，此时必须回落到 `fallback` 而不是把脏数据
 * 灌进业务逻辑（那才是「某处记忆莫名失效」的来源）。
 */
export function readLocalJson<T>(
  key: string,
  fallback: T,
  validate?: (value: unknown) => value is T,
): T {
  const raw = readLocalText(key)
  if (raw == null) return fallback
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fallback
  }
  if (validate) {
    try {
      return validate(parsed) ? parsed : fallback
    } catch {
      return fallback
    }
  }
  return parsed as T
}

/** 写 JSON。永不抛错；失败返回 false。 */
export function writeLocalJson(key: string, value: unknown): boolean {
  let text: string
  try {
    text = JSON.stringify(value)
  } catch {
    // 循环引用等不可序列化的情况
    return false
  }
  return writeLocalText(key, text)
}

/**
 * 是否是「站内地址」。
 *
 * 必须挡住 `//evil.com`：**协议相对 URL**，它以 `/` 开头，
 * 但浏览器会把它当外站打开 —— 只判 `startsWith('/')` 的写法会漏掉它。
 * 这类判定必须唯一实现（`lib/media-url.ts` 同款教训）。
 */
export function isSiteRelativePath(path: string): boolean {
  if (typeof path !== 'string') return false
  if (!path.startsWith('/')) return false
  if (path.startsWith('//')) return false
  // 控制字符（\n \r \0 等）可以骗过某些解析器
  if (/[\u0000-\u001f\u007f]/.test(path)) return false
  return true
}
