'use client'

import { create } from 'zustand'
import { parseSseChunk, type SseEvent } from '@/lib/sse'
import { isEphemeralUrl, toAbsoluteUrl, unwrapMediaProxyUrl } from '@/lib/media-url'
import { ensureServerUrl } from '@/lib/ensure-server-url'

// ===== 工具运行队列（跨页面常驻）=====
// 目标：工作流一旦派发就不再依赖页面组件存活——
//   1) 切到别的工具/页面时，正在跑的流继续读，产出照常回填成果区；
//   2) 同一工具可连续派发多批任务，各自独立排队、互不打断；
//   3) 已完成成果落 localStorage；刷新后的运行占位由 useResultRecovery 按服务端任务恢复。
// 之前把 fetch 流放在页面组件里，unmount/再次点击就会 abort，导致「工作流丢失、结果丢失」。

export const RESULTS_LS_KEY = 'toolhub:results'

/**
 * 「已删除记录」持久键。
 *
 * ===== 为什么必须有这一层 =====
 * 成果区有两个恢复源：**localStorage**（本地快照）与 **服务端 CanvasRun**（刷新后认领）。
 * 用户删除时只改了 localStorage —— 服务端那条 run 的产出还在，刷新时认领逻辑发现
 * url 不在当前列表里，就把刚删掉的图又插了回来（用户报的「删除过期链接后，刷新还会出现」）。
 *
 * 治法不是「删的时候顺手调接口删服务端 run」（那会连带删掉任务记录、调用日志要用的溯源信息，
 * 而且一次 run 可能产出多张、删一张不该销毁整条 run），而是在**展示层**记一份删除名单：
 * 凡是恢复（无论是本地快照还是服务端认领）都要过这道过滤，删掉的就不会再回来。
 *
 * 只存 url 字符串、上限 MAX_DISMISSED 条，容量可忽略；超出按 FIFO 淘汰最旧的
 * （旧到被挤掉的图早该过期了，再恢复也没有意义）。
 */
export const DISMISSED_LS_KEY = 'toolhub:dismissed-results'
const MAX_DISMISSED = 300

/**
 * 成果 URL 的展示层身份。
 *
 * 同一张图可能以这几种地址出现：
 * - 上游原图 https://...
 * - 展示代理 /api/asset-proxy?u=...
 * - 重试后带 _r 参数
 * - 当前站点绝对地址 / 相对地址
 *
 * 删除名单、恢复认领和本地快照必须共用同一身份，否则同一张图换个壳就会复活。
 */
export function resultUrlKey(url: string): string {
  const raw = String(url || '').trim()
  if (!raw) return ''
  try {
    const candidate = unwrapMediaProxyUrl(raw)
    const currentOrigin = typeof window !== 'undefined' && window.location ? window.location.origin : ''
    const origin = currentOrigin || 'https://example.invalid'
    const parsed = new URL(candidate, origin)
    parsed.searchParams.delete('_r')
    parsed.hash = ''
    if (currentOrigin && parsed.origin === currentOrigin) {
      return `${parsed.pathname}${parsed.search}`
    }
    if (parsed.origin === 'https://example.invalid') return `${parsed.pathname}${parsed.search}`
    return parsed.toString()
  } catch {
    return raw.split('#')[0]
  }
}

/** 读取删除名单（恢复路径共用）。任何异常都退化为空集合，绝不阻断恢复。 */
export function loadDismissedUrls(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = readLocalText(DISMISSED_LS_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return new Set(
      Array.isArray(arr)
        ? arr.filter((u): u is string => typeof u === 'string' && !!u).map(resultUrlKey).filter(Boolean)
        : [],
    )
  } catch { return new Set() }
}

/** 把一批 url 追加进删除名单（幂等、FIFO 截断、落盘）。 */
export function rememberDismissedUrls(urls: Iterable<string>): void {
  if (typeof window === 'undefined') return
  try {
    const set = loadDismissedUrls()
    for (const u of urls) {
      const key = resultUrlKey(u)
      if (key) set.add(key)
    }
    // 超出上限时丢最旧的（Set 保序 = 插入序，正是我们要的 FIFO）
    const arr = [...set]
    writeLocalJson(DISMISSED_LS_KEY, arr.slice(-MAX_DISMISSED))
  } catch { /* 空间不足忽略 */ }
}

/**
 * 把「服务端恢复出来的成果」合并进当前列表。
 *
 * 这是 CanvasRun、Agent GenerationTask 以及未来任何恢复源的唯一入口：
 * - 用户删过的 URL 永不复活
 * - 当前列表已有的 URL 不重复
 * - 同一批恢复数据自身也去重
 */
export function mergeRecoveredResults(
  prev: ResultItem[],
  recovered: ResultItem[],
  dismissed: Set<string> = loadDismissedUrls(),
): ResultItem[] {
  const known = new Set(prev.map((r) => resultUrlKey(r.url)).filter(Boolean))
  const inserts: ResultItem[] = []
  for (const item of recovered) {
    const key = resultUrlKey(item.url)
    if (!key || isEphemeralUrl(item.url) || dismissed.has(key) || known.has(key)) continue
    known.add(key)
    inserts.push({ ...item, status: 'done' })
  }
  return inserts.length > 0 ? [...inserts, ...prev] : prev
}

/**
 * 成果区最多保留多少条。
 *
 * 之前只截了「写 localStorage 的那份」（slice(0,100)），内存里的数组无上限：
 * 连续跑几十批后 DOM 要渲染上千个节点，页面越用越卡（而且用户不会去清理）。
 * 这里改成内存也截——保留最近 N 条，与持久化口径一致。
 * 运行中的占位不参与截断（否则正在跑的卡片会被挤掉）。
 */
const MAX_RESULTS = 100


export type ResultKind = 'image' | 'video' | 'audio'

// 失败原因翻译已迁到 lib/fail-reason.ts（纯业务语义，前后端共用）；
// 这里 import + re-export，既让本文件能用，也保持既有调用方零改动。
import { humanizeFailReason } from '@/lib/fail-reason'
import { readLocalText, writeLocalJson } from '@/lib/local-store'
export { humanizeFailReason }

export type ResultItem = {
  url: string
  kind: ResultKind
  /** 来源风格名（多选风格时标注） */
  styleLabel?: string
  nodeId: string
  /**
   * **生成**状态（与「图片能不能显示」无关）。
   *
   * 为什么必须分开：以前图片加载失败会把 status 改成 'error'，
   * 于是「生成失败」和「图挂了」在前端长得一模一样 ——
   * 用户看到「生成失败或链接失效」根本分不清是哪一种，
   * 明明生成成功、只是链接过期，却被误报成生成失败。
   *
   * 现在：status 只由后端事件（nodeOutput / nodeError）决定；
   * 图片加载失败走下面的 `imageState`，两者互不影响。
   */
  status: 'running' | 'done' | 'error'
  /**
   * 图片**可显示性**（独立于 status）。
   *   ok      —— 正常（含未尝试加载）
   *   expired —— 加载不出来（多半是上游链接过期），但**生成是成功的**
   *
   * 没有 loading 态：加载失败不再自动重试，直接判 expired 并给手动「重试」按钮。
   * 自动重试靠换 URL 参数实现，会中止正在进行的加载再从头下 —— 大图反而更容易失败。
   */
  imageState?: 'ok' | 'expired'
  /** 排队占位（运行中卡片，完成后消费掉） */
  queueId?: string
  queueIndex?: number
/** 排队位当前进度标注（与进度条联动，如「第5格」或「第 2/3 格」） */
  queueNote?: string
  /**
   * 这条产出是否经过 LLM 阶段（如提示词优化 / 需求理解）。
   *
   * 为什么要这个标记：阶段流程条是**动态段数** —— 有 LLM 才有「优化提示词」那一段，
   * 纯生图工具不该臆造出来。目前只有 Agent（规划模型先跑一轮）会置 true。
   */
  hasLlmStage?: boolean
  /**
   * 工具执行期的 LLM 阶段状态（AI 写分镜 / 优化提示词）。
   * 与 hasLlmStage 的区别：hasLlmStage 是「整条链路有没有 LLM」（Agent 用），
   * 这里是「LLM 现在跑到哪了」，由 nodeStart/nodeOutput 实时更新。
   */
  llmStage?: 'running' | 'done'
  llmStageLabel?: { running: string; done: string }
  /**
   * 上游相位（三段式的中间两段）：
   *   queued  —— 还在闸门排队，请求尚未发出（「等待派发」）
   *   running —— 已发出，等待上游返回（「生成中」）
   * 缺省视为 queued（节点刚开跑、还没打上游）。
   */
  phase?: 'queued' | 'running'
  /** 当前相位的起始时间戳，前端据此显示已等待/已生成秒数 */
  phaseSince?: number
  /**
   * GIF 成果的原始合成参数（源宫格图 + 宫格/选帧/裁切等）。
   * 用于成果区「调速」：不重新生图，只拿源图重新切帧编码。
   */
  gifSource?: {
    imageUrl: string
    grid?: string | number
    frames?: string
    mode?: string
    delayMs?: number
    trimPercent?: number
    maxSize?: number
    background?: string
  }
  /**
   * 认领自服务端的 CanvasRun.id。
   * 页面刷新后从 /api/canvas/runs 恢复成果时打上这个标记，
   * 与「正常 SSE 跑完的产出」区分开，也防止重复插入同一条任务。
   */
  claimedRunId?: string
  /** 产出所属工具（跨工具共享成果区时用于溯源） */
  toolName?: string
  /**
   * 生成失败的原因（后端 nodeError 事件的 error 文本）。
   *
   * 为什么必须有：以前失败卡片只显示一句「生成失败」，用户完全不知道原因 ——
   * 而原因往往是**可自行处理**的：
   *   - 上游内容审核（「与第三方内容相似性」「非法或违法活动」）→ 换个素材/改提示词即可
   *   - 参考图过期（素材只保留 2 小时）→ 重新上传即可
   *   - 上游偶发故障 / 网络中断 → 直接重试即可
   * 把原文透出来，用户与客服都不用靠猜。
   */
  failReason?: string
  /**
   * 图片加载失败的重试次数。
   *
   * 为什么需要：`<img onError>` 触发条件很宽（网络抖动、大图加载中断、CDN 慢），
   * 一旦触发就把状态永久改成 error，用户看到「生成失败或链接失效」——
   * 但这张图可能完全正常，只是那一次没加载出来。大图（3~5MB）尤其容易中招。
   * 记录重试次数，配合 cache-busting 参数重新加载，避免把「一次网络抖动」判成死。
   */
  retryCount?: number
  /** 产出时间（毫秒）：成果区据此提示「上游链接会过期，尽快下载」 */
  createdAt?: number
  /** 生成该成果所用模型名（执行期随 nodeOutput 事件带出，完成态卡片展示） */
  modelName?: string
  /** 该成果的生成耗时（毫秒） */
  durationMs?: number
  /** 该成果扣的积分 */
  costPoints?: number
  /** 该成果扣的豆（视频） */
  costBeans?: number
}

export type RunJob = {
  id: string
  toolId: string
  toolName: string
  /** 中止控制器（不参与持久化，仅内存） */
  controller: AbortController
  /** 预计批次数（排队位数量） */
  total: number
  status: 'running' | 'done' | 'error' | 'stopped'
  progressPct: number
  progressMsg: string
  startedAt: number
  /** 失败/部分失败的提示（页面挂载时消费一次） */
  notice?: { level: 'warning' | 'error' | 'info'; text: string }
  /** 已消费的提示标记（避免重复弹） */
  noticeConsumed?: boolean
}

const KIND_BY_PORT: Record<string, ResultKind> = {
  imageUrl: 'image', gifUrl: 'image', images: 'image', videoUrl: 'video', audioUrl: 'audio', audioUrls: 'audio',
}

type ExecutionEvent = SseEvent

interface ToolRunState {
  results: ResultItem[]
  jobs: RunJob[]
  /** 当前工具页正在关注的 job（用于进度条展示） */
  focusedJobId: string | null
  setResults: (updater: (prev: ResultItem[]) => ResultItem[]) => void
  /**
   * 在成果区置顶一组**排队占位**（工具模式 / Agent 模式共用同一套机制）。
   *
   * ===== 为什么要抽成 store 动作，而不是每个调用方各写一遍 setResults =====
   * 占位协议有四个必须对齐的细节，写错任何一条都会出现「占位转圈转到天荒地老」
   * 或「同一个结果插两张卡」：
   *   1. 用同一个 `queueId` 标记这一批（N 个占位共享一个 queueId，靠 queueIndex 区分）；
   *   2. 先**清掉同 queueId 的旧占位**再插入，否则重复派发会留下上一批的僵尸占位；
   *   3. 落位时**精确按 queueIndex 认领**，找不到才退回第一个空位（多路并发不串位）；
   *   4. 收尾时把没被消费的占位标成 error —— 流结束了却还显示「生成中」是最糟的失败形态。
   * 工具模式（startRun）、Agent（agent-stream-handler）、电商 Agent 三处各写一遍时
   * 已经漂移过一次，所以这里给出唯一实现。
   */
  enqueueSlots: (input: {
    queueId: string
    count: number
    /** 每个占位的卡片标注（如「主图」「第5格」）；缺省按序号生成 */
    noteFor?: (index: number) => string | undefined
    nodeId: string
    kind?: ResultKind
    toolName?: string
    hasLlmStage?: boolean
  }) => void
  /** 用真实产出消费一个排队占位（按 queueId + 认领到的 queueIndex） */
  consumeSlot: (input: {
    queueId: string
    /** 期望落位的序号；找不到对应占位时传 undefined 自动认领第一个空位 */
    queueIndex?: number
    result: ResultItem
  }) => void
  /** 某个占位失败：写失败原因并结束它的排队态 */
  failSlot: (input: { queueId: string; queueIndex?: number; failReason?: string }) => void
  /** 收尾：把该批次所有仍在排队的占位标为失败（流结束/中断时调用） */
  flushStaleSlots: (queueId: string, failReason?: string) => void
  focusJob: (id: string | null) => void
  markNoticeConsumed: (id: string) => void
  startRun: (input: {
    toolId: string
    toolName: string
    values: Record<string, unknown>
    estRuns: number
    resultNodeIds: string[]
    /** 工作流里的 LLM 节点（含 label）：用于成果卡实时显示「AI 写分镜中」 */
    llmNodes?: Array<{ id: string; label: string }>
  }) => Promise<void>
  stopJob: (id: string) => void
  /**
   * 批量图像处理（放大 / 抠图 / 去水印 / 翻译）：每张图各派一次任务，
   * 走与工具运行**同一套排队位机制**。
   *
   * 为什么不用「弹窗 + await 全部返回」：那样会把用户硬控住几十秒～几分钟，
   * 期间成果区没有排队位、也干不了别的。改成排队式后：
   *   - 立刻在成果区置顶 N 个排队位（「等待派发 → 生成中 + 计时」）
   *   - 谁先返回谁先落位，其余继续等，互不阻塞
   *   - 用户可以继续派发别的任务 / 切工具，产出照常回填
   *
   * 派发前统一过 toServerUrl：把 blob:/站内相对路径换成**上游能拉到的绝对公网地址**。
   * 这一步以前漏了站内相对路径与「上游外链是否可达」的校验，是批量任务失败的常见来源。
   */
  startImageBatch: (input: {
    items: Array<{ url: string; label?: string; toolName?: string }>
    modelId: string
    /** 操作类型；缺省 upscale（兼容旧调用） */
    op?: ImageBatchOp
    width?: number
    height?: number
    /** 抠图背景（'transparent' 或颜色名） */
    background?: string
    /** 翻译目标语言 */
    targetLanguage?: string
  }) => void
}

/** 批量图像处理的操作类型（与 /api/image/batch-edit 的 op 一一对应） */
export type ImageBatchOp = 'upscale' | 'cutout' | 'dewatermark' | 'translate'

/** 各操作的展示名与产物标签后缀 */
export const IMAGE_BATCH_META: Record<ImageBatchOp, { label: string; suffix: string }> = {
  upscale: { label: '高清放大', suffix: '放大' },
  cutout: { label: '抠图', suffix: '抠图' },
  dewatermark: { label: '去水印', suffix: '去水印' },
  translate: { label: '翻译', suffix: '翻译' },
}

/** 全部批量图像操作，供「这个 job 是不是批处理任务」的判断使用 */
export const IMAGE_BATCH_OPS: ImageBatchOp[] = ['upscale', 'cutout', 'dewatermark', 'translate']

export function loadPersistedResults(): ResultItem[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = readLocalText(RESULTS_LS_KEY)
    if (!raw) return []
    // 本地临时占位不直接恢复；useResultRecovery 从服务端认领任务并轮询到终态。
    // 刷新后把 imageState 重置为 ok：上次会话的「加载失败」不该带到这次
    // （链接可能又能访问了，或用户网络变了），让 <img> 重新试一次。
    // 已删除名单必须在这里过滤：否则本地快照里的旧列表会把删掉的图带回来。
    const dismissed = loadDismissedUrls()
    return (JSON.parse(raw) as ResultItem[])
      // blob:/data: 是「浏览器临时产物」（工作台编辑、九宫格切割），刷新后必然失效，
      // 不能带回来变成打不开的死图 —— 它们只在当前会话有效。
      .filter((r) => r.status !== 'running' && r.url && !isEphemeralUrl(r.url))
      .filter((r) => !dismissed.has(resultUrlKey(r.url)))
      .map((r) => ({ ...r, imageState: 'ok' as const, retryCount: 0 }))
  } catch { return [] }
}

// isEphemeralUrl 收敛到 lib/media-url（全站唯一实现）—— 见该文件对「为何集中」的说明

/**
 * 成果图**默认不转存**，直接用上游返回的 URL 展示。
 *
 * 为什么不转存（与后端 `shouldRehost` 默认 false 的口径对齐）：
 *   1) 转存要先把整张图下载到我们服务器，3~5MB 的图既费带宽又占盘；
 *   2) 转存完还得管 TTL 清理，转存素材过期后反而制造「记录在、图没了」的假失败；
 *   3) 上游链接本身通常有几小时到几天有效期，足够用户下载。
 *
 * 所以策略是：**用上游 URL 直接展示，过期就过期**，
 * 前端负责在成果区提示「尽快下载到本地」，而不是替用户长期保管。
 *
 * 注意：以前这里无条件调 /api/assets/rehost，等于把后端刻意保留的上游 URL
 * 又转存了一遍 —— 前后端口径不一致，还引入了「转存素材过期」这个额外故障源。
 */

/**
 * 确保一个图片地址是「上游能拉到」的公网地址。批量图像处理（放大/抠图/去水印/翻译）
 * 全都要把原图 URL 转给上游，上游是**远端服务器**，它必须能自己 fetch 到这张图。
 *
 * 三类地址分别处理：
 *   1) `blob:` / `data:` —— 只存在于用户浏览器，上游绝对拉不到 → **必须上传**换公网 URL
 *   2) `/api/asset/` `站内相对路径` —— 我们自己的文件，要拼成绝对域名（上游不认识相对路径）
 *   3) `https://` 外链 —— 已经是公网地址，原样返回
 *
 * 注意第 2 类：早先这里只判 blob/data，站内相对路径原样返回，
 * 而调用方虽然也会 abs() 一次，但**口径分散、容易漏**，
 * 所以统一收在这里做，保证「送去上游的一定是绝对公网地址」。
 */
export async function toServerUrl(url: string): Promise<string> {
  // 统一走共用实现，避免「每个入口各写一套」导致口径分散
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const serverUrl = await ensureServerUrl(url)
  return serverUrl.startsWith('/') ? `${origin}${serverUrl}` : serverUrl
}

export const useToolRunStore = create<ToolRunState>((set, get) => ({
  results: loadPersistedResults(),
  jobs: [],
  focusedJobId: null,

  setResults: (updater) => {
    const prev = get().results
    const applied = updater(prev)
    // 删除哪些 url 是「用户主动删掉」的：由差集自动推出，调用方无需手动申报。
    // 这样单条删除、批量删除、筛选删除、以及任何未来新增的删除入口都自动被记住，
    // 不会因为「新加了一条删除路径忘了登记」而重新引入刷新复活的问题。
    const nextUrls = new Set(applied.map((r) => resultUrlKey(r.url)).filter(Boolean))
    const removed = prev
      .filter((r) => r.url && !nextUrls.has(resultUrlKey(r.url)))
      .map((r) => r.url)
    if (removed.length > 0) rememberDismissedUrls(removed)
    // 截断时保持原有顺序（成果区是「电梯式、新成果置顶」，重排会打乱视觉预期）：
    // 顺序遍历，运行中的占位永远保留（被挤掉用户就看不到进度了），
    // 已完成的按出现顺序保留到上限。
    let settledKept = 0
    const next = applied.filter((r) => {
      if (r.status === 'running') return true
      if (settledKept >= MAX_RESULTS) return false
      settledKept++
      return true
    })
    set({ results: next })
    try {
      // 临时产物（blob:/data:）不落盘：既避免刷新后出现死图，也避免大 base64 撑爆 localStorage
      writeLocalJson(RESULTS_LS_KEY,
        next.filter((r) => r.status !== 'running' && !isEphemeralUrl(r.url),
      ))
    } catch { /* 空间不足忽略 */ }
  },

  focusJob: (id) => set({ focusedJobId: id }),

  enqueueSlots: ({ queueId, count, noteFor, nodeId, kind = 'image', toolName, hasLlmStage }) => {
    const total = Math.max(1, count)
    const now = Date.now()
    get().setResults((prev) => [
      ...Array.from({ length: total }, (_, i) => ({
        url: '',
        kind: kind as ResultKind,
        nodeId,
        status: 'running' as const,
        queueId,
        queueIndex: i,
        queueNote: noteFor?.(i),
        // 与工具模式对齐：刚建占位还没打上游 → 相位留空（显示「准备中」），
        // 之后由消费方推进成「等待派发 / 生成中 + 计时」。
        phase: undefined,
        phaseSince: now,
        hasLlmStage,
        toolName,
        createdAt: now + i,
      })),
      // 清掉同批次的旧占位：重复派发时上一批的僵尸占位不能留在成果区转圈
      ...prev.filter((r) => r.queueId !== queueId),
    ])
  },

  consumeSlot: ({ queueId, queueIndex, result }) => {
    get().setResults((prev) => {
      // 精确按 queueIndex 认领；找不到再退回第一个仍在排队的占位（兼容批次大小不一致）
      const exact = queueIndex !== undefined && prev.some(
        (r) => r.queueId === queueId && r.status === 'running' && r.queueIndex === queueIndex,
      )
      let placed = false
      const next = prev.map((r) => {
        if (r.queueId !== queueId || r.status !== 'running') return r
        const hit = exact ? r.queueIndex === queueIndex : !placed
        if (!hit) return r
        placed = true
        return { ...result, status: 'done' as const, queueId: undefined, queueIndex: undefined }
      })
      // 一批占位全被消费完但仍有新结果（如重试追加）→ 直接插到最前，不丢结果
      return placed ? next : [result, ...prev]
    })
  },

  failSlot: ({ queueId, queueIndex, failReason }) => {
    get().setResults((prev) => {
      const exact = queueIndex !== undefined && prev.some(
        (r) => r.queueId === queueId && r.status === 'running' && r.queueIndex === queueIndex,
      )
      let placed = false
      return prev.map((r) => {
        if (r.queueId !== queueId || r.status !== 'running') return r
        const hit = exact ? r.queueIndex === queueIndex : !placed
        if (!hit) return r
        placed = true
        return {
          ...r,
          status: 'error' as const,
          failReason: failReason || r.failReason,
          queueId: undefined,
          queueIndex: undefined,
        }
      })
    })
  },

  flushStaleSlots: (queueId, failReason) => {
    get().setResults((prev) => prev.map((r) =>
      r.queueId === queueId && r.status === 'running'
        ? {
            ...r,
            status: 'error' as const,
            failReason: failReason || r.failReason || '未能生成（上游未返回结果），可尝试重试或更换素材',
            queueId: undefined,
            queueIndex: undefined,
          }
        : r,
    ))
  },

  markNoticeConsumed: (id) => set({
    jobs: get().jobs.map((j) => (j.id === id ? { ...j, noticeConsumed: true } : j)),
  }),

  stopJob: (id) => {
    const job = get().jobs.find((j) => j.id === id)
    if (!job) return
    job.controller.abort()
    // 停止等待：把该 job 的排队位标失败（后台任务会自然结束，产出仍会回填）
    get().setResults((prev) => prev.map((r) =>
      r.queueId === id ? { ...r, status: 'error', queueId: undefined, queueIndex: undefined } : r))
    set({
      jobs: get().jobs.map((j) => (j.id === id ? { ...j, status: 'stopped', progressPct: 0, progressMsg: '' } : j)),
      focusedJobId: get().focusedJobId === id ? null : get().focusedJobId,
    })
  },

  startImageBatch: ({ items, modelId, op = 'upscale', width, height, background, targetLanguage }) => {
    if (items.length === 0) return
    const id = `${op}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const label = IMAGE_BATCH_META[op].label
    // 真正可用于中止的 controller：点「停止等待」时 abort，在途请求随之取消
    const controller = new AbortController()
    const job: RunJob = {
      id, toolId: op, toolName: label,
      total: items.length,
      status: 'running',
      progressPct: 4,
      progressMsg: `正在${label} ${items.length} 张…`,
      startedAt: Date.now(),
      controller,
    }
    set({ jobs: [...get().jobs, job], focusedJobId: id })

    const patchJob = (patch: Partial<RunJob>) => set({
      jobs: get().jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)),
    })

    // 排队占位：置顶 N 个，每张完成消费一个
    get().setResults((prev) => [
      ...items.map((it, i) => ({
        url: '', kind: 'image' as const, nodeId: id, status: 'running' as const,
        queueId: id, queueIndex: i, queueNote: it.label || `第 ${i + 1} 张`,
        phase: 'queued' as const, phaseSince: Date.now(), toolName: label,
      })),
      ...prev,
    ])

    let done = 0
    let failed = 0

    /** 把一个排队位换成真实成果 */
    const settle = (index: number, result: { url: string; label?: string; toolName?: string } | null) => {
      get().setResults((prev) => {
        const next = prev.map((r) => {
          if (r.queueId !== id || r.status !== 'running' || r.queueIndex !== index) return r
          if (!result) {
            return { ...r, status: 'error' as const, queueId: undefined, queueIndex: undefined }
          }
          return {
            url: result.url, kind: 'image' as const, status: 'done' as const, nodeId: op,
            styleLabel: `${result.label || '图片'} · ${IMAGE_BATCH_META[op].suffix}`, toolName: result.toolName || label,
            createdAt: Date.now(), queueId: undefined, queueIndex: undefined,
          }
        })
        return next
      })
      done++
      patchJob({
        progressPct: Math.round((done / items.length) * 100),
        progressMsg: `正在${label} ${done}/${items.length}…`,
      })
    }

    // 逐张派发：张与张之间留 50ms，避免一次性把请求全打出去造成尖峰
    // （与工具批量执行同一保护策略）。不 await 整体，用户不被阻塞。
    void (async () => {
      // ===== 第一步：先把所有图准备成「上游能拉到的公网地址」=====
      //
      // 用户明确要求：**送进上游的图必须能被上游访问**。三类需要处理：
      //   - blob:/data:（工作台编辑产出、本地拖入）→ 上传服务器换公网 URL
      //   - 站内相对路径 /api/asset/... → 拼绝对域名
      //   - 上游外链 → 已经可达，直接用
      // 这一步可能要传几 MB × N 张，所以单独给进度，别让用户以为卡死了。
      patchJob({ progressMsg: `正在准备图片 0/${items.length}…` })
      let ready = 0
      const prepared: Array<string | null> = new Array(items.length).fill(null)
      await Promise.all(items.map(async (it, i) => {
        // 准备阶段也留间隔，避免 N 张同时上传打尖峰
        if (i > 0) await new Promise((r) => setTimeout(r, i * 50))
        try {
          prepared[i] = await toServerUrl(it.url)
        } catch {
          prepared[i] = null // 准备失败 → 该张直接判失败，不派发
        } finally {
          ready++
          patchJob({ progressMsg: `正在准备图片 ${ready}/${items.length}…` })
        }
      }))
      patchJob({ progressMsg: `正在${label} 0/${items.length}…` })

      await Promise.all(items.map(async (it, i) => {
        if (i > 0) await new Promise((r) => setTimeout(r, i * 50))
        // 准备阶段就失败的：直接落成失败位，不浪费一次上游调用
        if (!prepared[i]) { failed++; settle(i, null); return }
        // 进入「已发出等返回」相位
        get().setResults((prev) => prev.map((r) =>
          r.queueId === id && r.status === 'running' && r.queueIndex === i
            ? { ...r, phase: 'running' as const, phaseSince: Date.now() }
            : r))
        try {
          const res = await fetch('/api/image/batch-edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            signal: controller.signal,
            body: JSON.stringify({ op, imageUrl: prepared[i], modelId, width, height, background, targetLanguage }),
          })
          const j = await res.json().catch(() => null)
          if (!res.ok || !j?.success || !j?.data?.url) throw new Error(j?.message || `${label}失败`)
          settle(i, { url: j.data.url as string, label: it.label, toolName: it.toolName })
        } catch (err) {
          // 用户主动停止：标记为取消，不计入「失败」（否则会弹「N 张放大失败」误导）
          if ((err as Error)?.name === 'AbortError') { settle(i, null); return }
          failed++
          settle(i, null)
        }
      }))
      const aborted = controller.signal.aborted
      patchJob({
        status: aborted ? 'stopped' : failed === items.length ? 'error' : 'done',
        progressPct: aborted ? 0 : 100,
        progressMsg: '',
        // 已中止就不弹失败汇总（是用户自己停的，不是出错）
        ...(aborted || failed === 0 ? {} : { notice: { level: (failed === items.length ? 'error' : 'warning') as 'error' | 'warning', text: failed === items.length ? `${failed} 张${label}失败` : `成功 ${items.length - failed} 张，失败 ${failed} 张` } }),
      })
      set({ focusedJobId: get().focusedJobId === id ? null : get().focusedJobId })
      setTimeout(() => set({ jobs: get().jobs.filter((j) => j.id !== id) }), 4000)
    })()
  },

  startRun: async ({ toolId, toolName, values, estRuns, resultNodeIds, llmNodes }) => {
    const id = `queue-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const llmNodeIds = new Set((llmNodes ?? []).map((n) => n.id))
    const llmLabelFor = (nodeId: string) => {
      const label = (llmNodes ?? []).find((n) => n.id === nodeId)?.label ?? ''
      return /分镜/.test(label)
        ? { running: 'AI 写分镜中', done: '已写分镜' }
        : { running: '优化提示词中', done: '已理解需求' }
    }
    const controller = new AbortController()
    const job: RunJob = {
      id, toolId, toolName,
      total: Math.max(1, estRuns),
      status: 'running',
      progressPct: 4,
      progressMsg: '准备中…',
      startedAt: Date.now(),
      controller,
    }
    set({ jobs: [...get().jobs, job], focusedJobId: id })

    // 排队占位：置顶 N 个，跑完一条消费一个
    const patchJob = (patch: Partial<RunJob>) => set({
      jobs: get().jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)),
    })
    const consumeQueue = (upsert: (prev: ResultItem[]) => ResultItem[]) => {
      get().setResults((prev) => {
        const applied = upsert(prev)
        const first = applied.findIndex((r) => r.queueId === id)
        if (first >= 0) return applied.filter((r, i) => !(i === first && r.queueId === id))
        return applied
      })
    }

    get().setResults((prev) => [
      ...Array.from({ length: job.total }, (_, i) => ({
        url: '', kind: 'image' as const, nodeId: id, status: 'running' as const,
        queueId: id, queueIndex: i, toolName,
      })),
      ...prev,
    ])

    const resultIdSet = new Set(resultNodeIds)
    const handleEvent = async (ev: ExecutionEvent) => {
      const type = ev.type as string
      const runLabel = (ev.runLabel as string) || undefined
      if (type === 'nodeStart') {
        const i = Number(ev.runIndex), total = Number(ev.runTotal) || 1
        const nodeId = String(ev.nodeId)
        const isResultNode = resultIdSet.has(nodeId)

        // ===== 进度条 vs 卡片的分工 =====
        //
        // **进度条只反映「总体进度」**：多份并发时（套图 7 个方向、九宫格 9 格）
        // 每份都会发 nodeStart/nodeProgress，若都往进度条上写就会互相覆盖、文案乱跳
        // （用户看到的就是「一开始正常，后来变成几格几格」）。
        //
        // **「哪一份、叫什么名字」放在各自的结果卡片上**（queueNote）——
        // 那里天然是一份一个位置，不会互相冲。
        //
        // 所以这里只推进百分比，文案用中性的「正在生成 N 个结果…」。
        if (total > 1) {
          // 已完成的份数 = 当前份序号（前面的都已产出或失败），进度按份推进
          patchJob({
            progressPct: Math.round(((i + 0.2) / total) * 100),
            progressMsg: `正在生成 ${total} 个结果…`,
          })
        } else {
          patchJob({ progressPct: 20, progressMsg: '开始处理…' })
        }

        // 卡片标注优先用 runLabel（「第5格」「配色型号」「动漫风格」）—— 那是用户自己选的选项名，
        // 最贴合所见。**有 runLabel 时不再拼序号**：以前两者都拼，
        // 变成「配色型号 · 第 7/7 格 · 开始处理…」，既啰嗦、又用错了量词
        // （「格」是九宫格的术语，套图是按方向出图，说「格」不对）。
        // 卡片标注：优先用户选的选项名（「第5格」「配色型号」）。
        // 没有选项名时（工具没有 choice 槽位）退回「第 N 个」——
        // 用中性量词，不用「格」（那是九宫格的术语，别的工具套上就不对了）。
        const note = runLabel || (total > 1 ? `第 ${i + 1} 个` : undefined)
        // LLM 不是成果节点，但它是成果卡阶段条的第一段：
        // 在结果占位上实时标「AI 写分镜中」，不要等生图节点开跑才出现。
        if (llmNodeIds.has(nodeId)) {
          const labels = llmLabelFor(nodeId)
          get().setResults((prev) => prev.map((r) => (
            r.queueId === id && r.status === 'running' && r.queueIndex === i
              ? { ...r, llmStage: 'running', llmStageLabel: labels, phaseSince: r.phaseSince ?? Date.now() }
              : r
          )))
        }
        // 只有成果节点才更新占位：预处理/透传节点（如九宫格预切图）也会发 nodeStart，
        // 若让它抢占占位，真正的生图节点相位就永远对不上。
        if (!isResultNode) return
        get().setResults((prev) => {
          // 优先按 queueIndex === runIndex 精确落位（占位与「第 N 格」一一对应），
          // 找不到再退回第一个空闲占位（兼容 total 与 runIndex 不一致的旧工具）。
          const exact = prev.some((r) => r.queueId === id && r.status === 'running' && r.queueIndex === i)
          let placed = false
          return prev.map((r) => {
            if (r.queueId !== id || r.status !== 'running') return r
            if (exact ? r.queueIndex === i : !placed) {
              placed = true
              // 刚开跑、还没打上游 → 相位留空（显示「准备中」），等 nodePhase 事件回填真实相位
              return { ...r, queueNote: note, phase: undefined, phaseSince: Date.now() }
            }
            return r
          })
        })
      } else if (type === 'nodePhase') {
        // 上游相位切换：queued=闸门排队中，running=已发出等返回。
        // 按「运行序号」落位（占位代表一次 run，不是单个节点）：
        // 同一 run 若有多个成果节点，它们的相位都落在同一个占位上，最后报到的生效。
        const phase = ev.phase === 'running' ? 'running' : 'queued'
        const at = Number(ev.at) || Date.now()
        const runIndex = Number(ev.runIndex)
        get().setResults((prev) => prev.map((r) =>
          r.queueId === id && r.status === 'running' && r.queueIndex === runIndex
            ? { ...r, phase, phaseSince: at }
            : r))
        if (phase === 'running') {
          // 进度条文案跟随相位：从「开始处理…」推进到「生成中…」。
          // 只对单份工具做（多份时进度条文案是「正在生成 N 个结果…」，
          // 由各份的 nodeStart 维护，这里不该插嘴）。
          const cur = get().jobs.find((j) => j.id === id)
          if (cur && cur.total <= 1 && cur.progressMsg && !cur.progressMsg.includes('生成中')) {
            patchJob({ progressMsg: cur.progressMsg.replace('开始处理…', '生成中…') })
          }
        }
      } else if (type === 'nodeProgress') {
        // 节点级过程信号（后端发的「选择图像模型...」「扣除积分...」「生成图像中...」）。
        //
        // **多份时忽略**：这些消息是节点级的（「扣除积分...」），不带是哪一份，
        // 7 份并发就会互相覆盖、把进度条文案搅乱。多份的细节看各自卡片即可。
        const job = get().jobs.find((j) => j.id === id)
        if (job && job.total <= 1) {
          patchJob({ progressMsg: String(ev.message || '生成中…') })
        }
      } else if (type === 'nodeOutput') {
        const output = ev.output as Record<string, unknown> | undefined
        if (!output) return
        const nodeId = String(ev.nodeId)
        // LLM 产出：把占位上的 LLM 阶段标成完成，接着生图节点的 nodePhase 接管
        if (llmNodeIds.has(nodeId)) {
          const runIndex = Number(ev.runIndex) || 0
          const labels = llmLabelFor(nodeId)
          get().setResults((prev) => prev.map((r) => (
            r.queueId === id && r.status === 'running' && r.queueIndex === runIndex
              ? { ...r, llmStage: 'done', llmStageLabel: labels }
              : r
          )))
          return
        }
        if (!resultIdSet.has(nodeId)) return // 非成果节点（上传/预览透传）不写成果区
        // 执行期元信息（模型/耗时/扣费）：只有这一刻能拿到，落进卡片供完成态展示。
        // 之前完成卡片只剩一个泛化 label，用户看不出「用什么模型生成的、花了多久、扣了多少」。
        const ometa = (ev.meta ?? {}) as { modelName?: string; durationMs?: number; costPoints?: number; costBeans?: number }
        const producedAt = Date.now()
        for (const [port, val] of Object.entries(output)) {
          const kind = KIND_BY_PORT[port]
          if (!kind) continue
          const urls = Array.isArray(val) ? val : [val]
          // 直接用上游 URL（不转存）：见文件上方 persistImage 处的说明
          for (const u of urls) {
            if (typeof u !== 'string' || !u) continue
            const gifSource = port === 'gifUrl' && typeof output.sourceImageUrl === 'string'
              ? {
                imageUrl: output.sourceImageUrl,
                grid: typeof output.grid === 'string' || typeof output.grid === 'number' ? output.grid : undefined,
                frames: typeof output.frames === 'string' ? output.frames : undefined,
                mode: typeof output.mode === 'string' ? output.mode : undefined,
                delayMs: typeof output.delayMs === 'number' ? output.delayMs : undefined,
                trimPercent: typeof output.trimPercent === 'number' ? output.trimPercent : undefined,
                maxSize: typeof output.maxSize === 'number' ? output.maxSize : undefined,
                background: typeof output.background === 'string' ? output.background : undefined,
              }
              : undefined
            consumeQueue((prev) => [
              {
                url: u, kind, styleLabel: runLabel, nodeId, status: 'done', toolName,
                createdAt: producedAt,
                modelName: ometa.modelName,
                durationMs: ometa.durationMs,
                costPoints: ometa.costPoints,
                costBeans: ometa.costBeans,
                ...(gifSource ? { gifSource } : {}),
              },
              // 同一 URL 只保留一条：原生 GIF 模式下，宫格节点和透传的 GIF 节点
              // 会输出同一个地址，不能显示成两张重复成果。
              ...prev.filter((r) => r.url !== u),
            ])
          }
        }
      } else if (type === 'nodeError') {
        const rawError = String(ev.error || '')
        // 失败原因写进对应的成果卡片，而不是只更新进度条：
        // 卡片才是用户盯着看的地方，一句「生成失败」无法指导下一步动作。
        const failedNodeId = String(ev.nodeId || '')
        const runIndex = Number(ev.runIndex)
        const reason = humanizeFailReason(rawError)
        get().setResults((prev) => {
          // 优先按「运行序号」精确落位（多份并发的占位与 runIndex 一一对应），
          // 找不到再退回「队列里第一个仍在运行的占位」，避免原因丢在一个不对的卡片上。
          const exact = failedNodeId
            ? prev.some((r) => r.queueId === id && r.status === 'running' && r.nodeId === failedNodeId)
            : false
          let placed = false
          return prev.map((r) => {
            if (r.queueId !== id || r.status !== 'running') return r
            const hit = exact
              ? r.nodeId === failedNodeId
              : Number.isFinite(runIndex)
                ? r.queueIndex === runIndex
                : !placed
            if (!hit) return r
            placed = true
            return { ...r, failReason: reason || r.failReason }
          })
        })
        patchJob({ progressMsg: `某一步失败：${rawError}`, notice: { level: 'warning', text: rawError || '部分节点执行失败' } })
      } else if (type === 'error') {
        patchJob({ notice: { level: 'error', text: String(ev.message || '执行失败') } })
      }
    }

    try {
      const res = await fetch(`/api/tools/${toolId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        signal: controller.signal,
        body: JSON.stringify({ values }),
      })
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null)
        throw new Error(j?.message || `请求失败 (${res.status})`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const { events, rest } = parseSseChunk(buf)
        buf = rest
        for (const ev of events) await handleEvent(ev)
      }
      // 流正常结束但仍有排队位 → 说明部分批次没出成果（被上游拒/失败）
      // 保留已写入的 failReason；没有原因的补一句兜底文案，避免卡片上一片空白。
      get().setResults((prev) => prev.map((r) =>
        r.queueId === id
          ? { ...r, status: 'error', queueId: undefined, queueIndex: undefined, failReason: r.failReason || '未能生成（上游未返回结果），可尝试重试或更换素材' }
          : r))
      patchJob({ status: 'done', progressPct: 100, progressMsg: '' })
    } catch (err: unknown) {
      const aborted = (err as Error)?.name === 'AbortError'
      get().setResults((prev) => prev.map((r) =>
        r.queueId === id ? { ...r, status: 'error', queueId: undefined, queueIndex: undefined } : r))
      patchJob({
        status: aborted ? 'stopped' : 'error',
        progressPct: 0,
        progressMsg: '',
        ...(aborted ? {} : { notice: { level: 'error' as const, text: err instanceof Error ? err.message : '运行失败' } }),
      })
    } finally {
      set({ focusedJobId: get().focusedJobId === id ? null : get().focusedJobId })
      // 完成的 job 保留一小段时间供 UI 收尾，之后清掉避免无限增长
      setTimeout(() => set({ jobs: get().jobs.filter((j) => j.id !== id) }), 4000)
    }
  },
}))
