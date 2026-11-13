// Agent 会话上下文的窗口参数（**叶子模块**，不 import 任何业务代码）。
//
// ===== 为什么单独一个文件 =====
// 这些数值被**两条路径**共用：
//   1) 主路径 agent-tool-loop（工具循环）
//   2) 回落路径 agent-executor（单次规划，模型不支持 function calling 时）
// 而 agent-executor 静态 import 了 agent-tool-loop —— 若把常量放在 tool-loop 里，
// executor 再加一条**值** import 就构成运行时循环依赖（模块初始化顺序变得不可预期）。
//
// 两条路径必须同口径：否则同一个会话「主路径记得住、回落后突然失忆」，
// 行为飘忽且极难排查（这个项目在 preferences/memory 上已经踩过一次同类分叉）。
// 所以把口径收敛到这个无依赖的叶子模块，两边都从这里取。
//
// ⚠️ 这个文件不要 import 任何 `@/lib/*` 业务模块，否则又会把循环依赖引回来。

/** 粗估：1 token ≈ 多少字符。中文为主时按 1.5，英文约 4 —— 取保守值避免高估容量。 */
const CHARS_PER_TOKEN = 1.5

/**
 * 预留给「本轮其它内容」的 token 上限（system prompt + 工具清单 + 可用模型清单）。
 *
 * ⚠️ 必须按窗口比例收缩，不能是固定值：实测 32K 窗口若固定扣 6000+12000=18000，
 * 光预留就吃掉一大半窗口，算出来的历史预算被压到下限，等于「配了 32K 也没历史」。
 * 所以取「固定上限」与「窗口比例」的较小者。
 */
const RESERVED_FOR_PROMPT_TOKENS = 6000
const PROMPT_RESERVE_RATIO = 0.15

/** 预留给「模型输出」的 token（含推理，与 maxTokens 8192 同量级） */
const RESERVED_FOR_OUTPUT_TOKENS = 12000
const OUTPUT_RESERVE_RATIO = 0.25

/**
 * 会话窗口的安全比例：只吃上下文窗口的 60%。
 *
 * 为什么不吃满：① 上游对 token 的计数口径与我们粗估不同（差 20~30% 很常见）；
 * ② 图片（多模态）也占 token，但**在请求发出前无法准确计算**；
 * ③ 留余量给「本轮新增的工具返回结果」。估超了会被上游直接 400 拒绝，得不偿失。
 */
const CONTEXT_USAGE_RATIO = 0.6

/**
 * 模型未声明 contextWindow 时的兜底值。
 *
 * 32K → 248K（2026-10-04，用户决定）：项目在用的规划模型都是 248K 起步
 * 原来兜底 32K 的后果是：**只要忘了在后台填这一栏，模型就被当成 32K 用**，
 * 历史预算掉到 1/7 —— 用户看到的就是"配了 256K 却还是记不住"。
 *
 * ⚠️ 代价：真接了 8K/32K 的小模型时必须**显式填** contextWindow，否则会超窗口 400。
 */
const DEFAULT_CONTEXT_WINDOW = 248000

/**
 * 按**模型实际上下文窗口**算「给历史对话多少字符预算」。
 *
 * 为什么不写死条数（2026-10-04 改，用户反馈「上面的内容一直丢」）：
 * 原实现把窗口写死成条数（6→12→24），**与模型能力无关** —— 配 256K 和配 8K 用同一套限制。
 * 且每条消息长度差异极大（一句「换成 4:3」vs 一大段结构化上下文），按条数给窗口，
 * 实际 token 用量能差几十倍。用户明确要求：「配的模型至少 256K，别自动丢上下文」。
 *
 * @param contextWindowTokens 模型配置声明的上下文窗口（model.contextWindow）
 */
export function historyBudgetChars(contextWindowTokens?: number | null): number {
  const window = contextWindowTokens && contextWindowTokens > 0 ? contextWindowTokens : DEFAULT_CONTEXT_WINDOW
  // 预留按「固定上限」与「窗口比例」取小（小窗口不该被固定预留吃光）
  const reservedPrompt = Math.min(RESERVED_FOR_PROMPT_TOKENS, window * PROMPT_RESERVE_RATIO)
  const reservedOutput = Math.min(RESERVED_FOR_OUTPUT_TOKENS, window * OUTPUT_RESERVE_RATIO)
  const usable = window * CONTEXT_USAGE_RATIO - reservedPrompt - reservedOutput
  const chars = Math.floor(usable * CHARS_PER_TOKEN)
  // 下限 8000 字符（约 5K token）：避免小窗口算出「几乎没有历史」。
  // ⚠️ 但**绝不能越过模型容量** —— 宁可历史短，也不能把请求撑到上游 400。
  // 所以下限只在「容量本身够」时生效；容量不足时老实按容量给。
  const capacityChars = Math.max(0, Math.floor((window * CONTEXT_USAGE_RATIO) * CHARS_PER_TOKEN))
  return Math.min(capacityChars, Math.max(Math.min(8000, capacityChars), chars))
}

/**
 * 摘要占「总历史预算」的比例。
 *
 * ⚠️ 摘要必须**从总预算里切**，不能与正文各算各的：
 * 实测正文 203K + 摘要 81K = 284K 字符（≈190K token），已超过 256K 窗口的 60% 目标
 * （154K token）—— 两笔预算相加会**静默超预算**，请求被上游 400。
 */
const SUMMARY_SHARE = 0.4

/** 摘要预算 = 总预算 × SUMMARY_SHARE（从总预算里切，不额外加） */
export function historySummaryBudgetChars(contextWindowTokens?: number | null): number {
  return Math.floor(historyBudgetChars(contextWindowTokens) * SUMMARY_SHARE)
}

/** 正文预算 = 总预算 − 摘要（两者之和恒等于总预算） */
export function historyMessagesBudgetChars(contextWindowTokens?: number | null): number {
  const total = historyBudgetChars(contextWindowTokens)
  return Math.max(2000, total - historySummaryBudgetChars(contextWindowTokens))
}

/**
 * 给模型看的历史消息**条数上限**。
 *
 * 现在是「软上限」：真正的约束是 historyMessagesBudgetChars（按 token 算）。
 * 条数保留一个够大的值，防止「极短消息（如只发一个表情）」把查询撑到几千条。
 */
export const HISTORY_MESSAGES = 200

/**
 * 单条历史消息正文的截断长度（控 token）。
 *
 * 1200 → 4000：单条就可能是一大段结构化内容（如带可用模型清单的上下文、
 * 或用户粘贴的长需求）。在总预算受控（historyBudgetChars）的前提下，
 * 单条没必要再卡这么死 —— 截断反而把关键信息切掉。
 */
export const HISTORY_CONTENT_CHARS = 4000

/** 兼容旧引用的固定值（未传窗口时的默认摘要预算） */
export const HISTORY_SUMMARY_CHARS = historySummaryBudgetChars(DEFAULT_CONTEXT_WINDOW)

/**
 * 滚动摘要**落库**时保留的总长度（比注入模型时更长）。
 *
 * 两个值分开的理由：落库是「长期记忆的存储上限」，注入是「本轮 token 预算」。
 * 存得比给的多，下次注入时才有往前的余量 —— 若两者相等，
 * 每次追加都会把最旧的一整轮直接挤掉，早期内容再也找不回来。
 *
 * 8000 → 120000（随上下文一起放宽）：用户要求「别一直往下走上面的就丢」。
 *
 * ⚠️ 必须 **> 注入时用的摘要预算**，否则「存得比给的少」——
 * 每次注入都会把最旧的一整轮直接挤掉，往前余量白留。
 * 256K 窗口注入的摘要上限是 81360 字符，所以落库给到 12 万留足余量。
 * （按字符算 12 万约 8 万 token，对 256K 窗口放得下；且这只是**盘中字符串**，
 * 只有真正注入的那部分才进 token 预算。）
 */
export const HISTORY_SUMMARY_STORE_CHARS = 120000
// ===== 新手引导 ↔ 画布 Copilot 的协作事件 =====
//
// 引导要指 Copilot 的「输入框 / 大脑模型」，但面板默认是**收起成胶囊**的 ——
// 那两个元素根本不在 DOM 里，引导会静默退化成居中弹卡。
// 所以引导在切到这两步时派发这个事件，由 CopilotPanel 监听并展开面板。
//
// 用事件而不是 props：FirstUseGuide 是页面级通用组件，
// 为它加一条穿透 CopilotPanel 的 props 会把「通用引导」与「画布」耦合死。
export const GUIDE_OPEN_COPILOT_EVENT = 'aigc-hub:guide-open-copilot'

/** 引导需要「先展开 Copilot 面板」时调用 */
export function requestOpenCopilot(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(GUIDE_OPEN_COPILOT_EVENT))
}
