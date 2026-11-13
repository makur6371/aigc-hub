'use client'

// 工具箱 / Agent 共用的三段式工作台（成果区 · 工作台 · 操作面板）。
//
// ===== 为什么抽成共享组件 =====
// 「Agent 页」原本是 /agent → 307 → /tools/[slug]?panel=agent 的**跳转**，
// 落地仍是工具页 —— 地址栏是工具 slug、顶部挂着工具切换器和「在画布中编辑」，
// 两个身份天然糊在一起，怎么调参数都分不开。
//
// 但把工具页复制一份给 Agent 更糟：三栏/成果区/工作台/批量操作/拖拽/移动端 Tab
// 会立刻开始漂移（这个项目已经交过学费，见 agent-message.ts 的注释）。
//
// 所以：**骨架只有一份**，用 mode 区分身份，两条路由各自薄壳：
//   mode='tool'  → 头部=工具切换器+元信息+画布入口；右栏=「工具 / 智能体」双 Tab
//   mode='agent' → 头部=Agent 身份（无工具切换器/无画布入口）；右栏=纯 Agent 对话
// 三栏结构与全部状态机完全共用。
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Typography, Button, Card, Input, Segmented, Select, Upload, App as AntApp, Tooltip, Empty, Dropdown } from 'antd'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageState } from '@/components/ui/PageState'
import { AnimatedLogo } from '@/components/ui/AnimatedLogo'
import {
  ThunderboltFilled, ThunderboltOutlined, LikeOutlined, PlayCircleOutlined, UploadOutlined, EditOutlined,
  PictureOutlined, VideoCameraOutlined,
  SoundOutlined, RobotOutlined,
  AppstoreOutlined, DeleteOutlined, EyeOutlined, DownOutlined, InboxOutlined,
  LeftOutlined, RightOutlined, CloseOutlined, LoadingOutlined,
  DownloadOutlined,
  CheckOutlined,
  EyeInvisibleOutlined,
} from '@ant-design/icons'
import { useParams, useRouter } from 'next/navigation'
import { useNavPush } from '@/lib/use-nav-push'
import { apiFetch } from '@/lib/api-client'
import { useAuthStore } from '@/stores/useAuthStore'
import { ASPECT_RATIOS, RES_TIERS, decodeSize } from '@/lib/image-sizes'
import {
  getVideoCapabilities, resolveVideoMediaSlots, slotVisibleInVideoMode, sortVideoModes,
  videoBeansLabel, VIDEO_MODE_LABELS,
} from '@/lib/video-capabilities'
import { CREATE_TOOL_SLUGS } from '@/lib/create-tools'
import {
  BASE_TOOL_CATEGORIES as BASE_CATEGORIES,
  normalizeToolCategory,
  STANDALONE_TOOLS,
} from '@/lib/constants/categories'
import { Workbench, type WorkbenchItem } from '@/components/tools/Workbench'
import { ComposerBar } from '@/components/tools/ComposerBar'
import type { CreateMode } from '@/components/tools/CreateModePicker'
import { ResultBatchActions } from '@/components/tools/ResultBatchActions'
import { FirstUseGuide, GUIDE_STEPS, guideVersionOf } from '@/components/ui/FirstUseGuide'
import { useToolRunStore, IMAGE_BATCH_META, IMAGE_BATCH_OPS, type ImageBatchOp, type ResultItem } from '@/stores/useToolRunStore'
import { useResultRecovery } from '@/components/tools/useResultRecovery'
import ToolAgentPanel from '@/components/tools/ToolAgentPanel'
import { QuickFavoriteButton } from '@/components/tools/QuickFavoriteButton'
import { downloadResults } from '@/lib/download-results'
import { ImageLightbox } from '@/components/ui/ImageLightbox'
import { toAssetProxyUrl, toDisplayUrl, isEphemeralUrl } from '@/lib/media-url'
import { ensureServerUrl as ensureServerUrlShared } from '@/lib/ensure-server-url'
import { useFileDrop, RESULT_DRAG_MIME, type ResultDragPayload } from '@/app/(app)/tools/[slug]/file-drop'
import { SlotControl, ResultRow, useElapsed, formatElapsed, type ToolSlot, type ModelOption } from '@/app/(app)/tools/[slug]/slot-controls'
import { GifSpeedModal } from '@/components/tools/GifSpeedModal'
import { readLocalText, writeLocalJson, removeLocalKey } from '@/lib/local-store'

const { Text } = Typography


/** 工作台当前项持久化 key（成果区 key 由 useToolRunStore 统一管理） */
const WORKBENCH_LS_KEY = 'toolhub:workbench'

type ToolDetail = {
  id: string
  slug: string
  name: string
  description: string | null
  coverUrl: string | null
  category: string | null
  tags: string | null
  isOfficial: boolean
  useCount: number
  likeCount: number
  slots: ToolSlot[]
  /** 工作流快照：用于把文本槽预填成「工具作者保存的值」，而不是空白框 */
  workflow?: {
    nodes?: Array<{ id: string; type?: string; label?: string; inputs?: Record<string, unknown> }>
    connections?: unknown[]
  }
  author: { nickname: string | null; avatarUrl: string | null } | null
  /**
   * 已下架工具的迁移信息（后端在 status !== APPROVED 且有承接方时返回）。
   * 有它 → 显示「这个功能搬到哪了」的引导；没有 → 走原来的「未上架」空状态。
   */
  retired?: boolean
  migration?: { slug: string; to: string; note: string; href?: string }
}

const MODEL_TYPE_FILTER: Record<string, string[]> = {
  TEXT: ['TEXT', 'VISION'],
  VISION: ['VISION'],
  IMAGE: ['IMAGE'],
  VIDEO: ['VIDEO'],
  AUDIO: ['AUDIO'],
}

/**
 * 成果图 / 工作台共用的**同源显示地址**。
 *
 * 为什么必须共用：成果区用 `<img src=上游外链>` 渲染，工作台子页则要 `fetch()` 一份
 * 二进制去解码编辑 —— 这是**两条互不相干的缓存**：浏览器 `<img>` 缓存按「图片资源」
 * 存，跨域 `fetch` 拿不到它（且上游无 CORS 时 fetch 直接失败），于是同一张 3MB 图
 * 被完整下载两遍。实测上游单张 3MB / 直连 4.0s，用户感受就是
 * 「成果区已经显示出来了，点进工作台还要再等一次」。
 *
 * 两边都用同一个上游原图地址：浏览器 HTTP 缓存对 `<img>` 和 `fetch`
 * 是同一份（服务端还带 `immutable` 长缓存 + 磁盘缓存 + 并发去重），第二遍直接命中。
 *
 * 站内地址（/api/asset/、/generated/、blob:、data:）本来就是同源且无需回源，原样返回。
 */
// 收敛到 media-url 的唯一实现（守卫完全一致）
const displayUrl = toDisplayUrl

/** 风格卡片的算法生成封面（无示例图时的占位美学：品牌紫系渐变 + 首字） */
export type ToolStudioProps = {
  /**
   * 页面身份。决定头部渲染什么、右栏有没有「工具/智能体」切换。
   * 'tool' = 工具执行页（/tools/[slug]）；'agent' = 智能体页（/agent）。
   */
  mode: 'tool' | 'agent'
  /**
   * 宿主工具 slug。
   *   tool 模式：必传，就是路径里的工具。
   *   agent 模式：不传 —— Agent 不该有「宿主工具」这种身份，
   *               ToolAgentPanel 的 toolSlug 只用于推断默认技能，留空=通用智能体。
   */
  toolSlug?: string
  createMode?: CreateMode
  onCreateModeChange?: (mode: CreateMode) => void
}

export default function ToolStudio({ mode, toolSlug, createMode, onCreateModeChange }: ToolStudioProps) {
  const isAgent = mode === 'agent'
  const isCreateAgent = isAgent && createMode === 'agent'
  const router = useRouter()
  const navigate = useNavPush()
  const { message, modal } = AntApp.useApp()
  const user = useAuthStore((s) => s.user)

  const [tool, setTool] = useState<ToolDetail | null>(null)
  const [notFound, setNotFound] = useState(false)
  /** 初次加载标记：缓存命中后切换模式不再显示 loading，避免「整页闪一下」 */
  const [initialLoad, setInitialLoad] = useState(true)
  /**
   * 已加载过的工具详情缓存（组件实例内）。
   *
   * 创作区三个模式常驻切换（video/image/agent），切回已访问过的工具时
   * 不能重新拉 /api/tools/[slug]——那会把 tool 置回 null → 整页 loading，
   * 用户看到的是「切一下整个工作区闪一下」，等效重载。缓存后切换是纯显示层切换。
   */
  const toolCacheRef = useRef<Map<string, ToolDetail>>(new Map())
  /**
   * 已下架工具的迁移指引（非空 → 显示「搬到哪了」引导页）。
   * 见 lib/retired-tools.ts：下架必须给路，不能只丢一个空状态给老用户。
   */
  const [retiredMigration, setRetiredMigration] = useState<{ slug: string; to: string; note: string; href?: string } | null>(null)
  const [models, setModels] = useState<ModelOption[]>([])
  const [values, setValues] = useState<Record<string, unknown>>({})
  // URL 预填的想法（?prompt=xxx）：既灌进工具表单槽位，也交给智能体面板作为对话首轮输入。
  // 单一来源读取，"避免两处各解析一遍 window.location 漂移。
  const [urlPrompt, setUrlPrompt] = useState('')
  // 成果区 + 运行队列统一由常驻 store 管理：切工具/刷新不丢工作流与结果，可连续派发多批
  const results = useToolRunStore((s) => s.results)
  const setResults = useToolRunStore((s) => s.setResults)
  const jobs = useToolRunStore((s) => s.jobs)
  const focusedJobId = useToolRunStore((s) => s.focusedJobId)
  const startRun = useToolRunStore((s) => s.startRun)
  const stopJob = useToolRunStore((s) => s.stopJob)
  const markNoticeConsumed = useToolRunStore((s) => s.markNoticeConsumed)
  // 本工具当前正在跑的 job（可能同时有多批）
  // 批量图像处理任务（放大/抠图/去水印/翻译）的 toolId 是 op 本身
  // （它们不是某个工具的运行，而是对成果图的操作），但同样在成果区占排队位、
  // 同样需要进度/停止/完成汇总 —— 所以一并纳入，
  // 否则「成功 N 张」的汇总永远不弹、进度条和停止按钮也不出现。
  const myJobs = useMemo(
    () => jobs.filter((j) => j.toolId === tool?.id || IMAGE_BATCH_OPS.includes(j.toolId as ImageBatchOp)),
    [jobs, tool?.id],
  )
  const runningJobs = useMemo(() => myJobs.filter((j) => j.status === 'running'), [myJobs])
  const running = runningJobs.length > 0
  const activeJob = useMemo(
    () => runningJobs.find((j) => j.id === focusedJobId) ?? runningJobs[runningJobs.length - 1] ?? null,
    [runningJobs, focusedJobId],
  )
  const progressMsg = activeJob?.progressMsg ?? ''
  const progressPct = activeJob?.progressPct ?? 0
  const [active, setActive] = useState<WorkbenchItem | null>(() => {
    try {
      const raw = readLocalText(WORKBENCH_LS_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw) as WorkbenchItem | null
      // blob:/data: 是浏览器临时产物（本地拖入、工作台编辑），刷新后必然失效 —— 不带回来
      if (!parsed?.url || isEphemeralUrl(parsed.url)) return null
      return parsed
    } catch { return null }
  })
  const [toolList, setToolList] = useState<Array<{ id: string; slug: string; name: string; isOfficial: boolean; category: string | null }>>([])
  const [liked, setLiked] = useState(false)
  const [likeCount, setLikeCount] = useState(0)
  const [resultsCollapsed, setResultsCollapsed] = useState(false)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  // 成果区多选：批量删除 / 批量下载。存 url 集合（成果可能没有稳定 id）
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set())
  const [downloading, setDownloading] = useState(false)
  // 成果区图片放大：与「送到工作台」分开（后者占用卡片 onClick）
  const [lightbox, setLightbox] = useState<{ open: boolean; urls: string[]; index: number }>({ open: false, urls: [], index: 0 })
  const [speedItem, setSpeedItem] = useState<ResultItem | null>(null)
  // 移动端两 Tab：操作面板 / 工作台；成果做成工作台内可展开层
  const [mTab, setMTab] = useState<'panel' | 'workbench'>('panel')
  // 操作面板内容：由**路由**决定，不再是页内开关。
  //
  // 演进：① 局部 state → ② URL 的 ?panel=agent（Agent 借工具页渲染）→ ③ 现在。
  // ③ 的理由：Agent 已有独立路由 /agent，工具页再留一个「切到智能体」的开关，
  //   等于把刚拆开的两个身份又在同一个页面上粘回去 —— 用户也会困惑
  //   「我到底在工具页还是 Agent 页」。工具页就只做工具，Agent 走导航栏。
  const showAgentPanel = isAgent

  // 移动端引导前置修正：引导要高亮右面板里的控件，但移动端默认可能停在「工作台」Tab
  // （比如用户先点过成果图），此时面板是 max-lg:!hidden，锚点量出来全 0 → 引导退化成居中卡。
  // 所以首次进入（引导还没看过）时，把 Tab 拉回「面板」，保证引导每一步都能指到真实控件。
  useEffect(() => {
    if (!user) return
    // key 必须与 FirstUseGuide 的 storageKey **同源**（含版本号）—— 否则会误读别的场景的
    // 「已看过」记录，或者版本号一涨这里就失配。所以直接调它的 guideVersionOf，不手写数字。
    const guideScene = isAgent ? 'agent' : 'tools'
    const guideKey = `guide:seen:${guideScene}:v${guideVersionOf(guideScene)}`
    try {
      if (readLocalText(guideKey) === '1') return
    } catch { /* 读不到就按「没看过」处理 */ }
    setMTab('panel')
  }, [user, isAgent])
  const [mResultsOpen, setMResultsOpen] = useState(false)
  /**
   * 移动端单屏 Tab 只在窄屏成立；桌面三栏是 CSS 用 lg(1024px) 控制的。
   * 但 mTab 是 JS state，原来只在「点开始生成」时读过一次 matchMedia ——
   * 浏览器缩放 / 拖窗口跨过 1024 时，CSS 已经切好了，mTab 却还停在旧值，
   * 结果 max-lg:!hidden 与 lg 布局短暂打架（「卡几下才恢复正常」）。
   * 这里补齐监听，让 state 跟 CSS 同源同步：回到桌面就回 panel，
   * 免得用户从窄屏拖宽后停在一个被 lg 布局隐藏的 Tab 上。
   */
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)')
    const sync = () => {
      if (mq.matches) return
      setMTab((prev) => (prev === 'panel' ? prev : 'panel'))
      setMResultsOpen(false)
    }
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  // 工作台当前项持久化（成果区由 store 自己回写）
  useEffect(() => {
    try {
      // 临时产物不落盘：刷新后打不开，只会变成一张死图
      const persistable = active && !isEphemeralUrl(active.url)
      if (persistable) writeLocalJson(WORKBENCH_LS_KEY, active)
      else removeLocalKey(WORKBENCH_LS_KEY)
    } catch { /* 忽略 */ }
  }, [active])

  // 工具快捷切换下拉：拉一遍已上架工具（轻量分页）
  useEffect(() => {
    let alive = true
    apiFetch<{ items: Array<{ id: string; slug: string; name: string; isOfficial: boolean; category: string | null }> }>('/api/tools?pageSize=50')
      .then((r) => { if (alive && r.success && r.data?.items) setToolList(r.data.items) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  // 本地拖入素材 → 进成果区并加载工作台（只存浏览器本地 blob，不上传服务器）
  // 需要当生成输入时，由「用作输入」按需上传换取公网链接。
  const onDropFiles = useCallback(async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      const kind: ResultItem['kind'] = f.type.startsWith('video') ? 'video' : f.type.startsWith('audio') ? 'audio' : 'image'
      const localUrl = URL.createObjectURL(f)
      const item: ResultItem = { url: localUrl, kind, nodeId: 'local', status: 'done', styleLabel: f.name }
      setResults((prev) => [item, ...prev])
      setActive({ url: localUrl, kind, label: f.name })
    }
  }, [setResults])

  // 上传中状态：只要还有素材在传，就禁用「开始生成」，避免带着 blob/失效链接去跑
  const [uploading, setUploading] = useState(0)
  const onUploadActivityChange = useCallback((active: boolean) => {
    setUploading((count) => active ? count + 1 : Math.max(0, count - 1))
  }, [])

  /**
   * 确保一个素材地址是「服务器可达的站内 URL」。
   *
   * 三种来源统一处理：
   *   - blob:（本地文件 / 工作台编辑产出）→ 上传服务器换 /api/asset/...
   *   - http(s) 外链（上游临时图）→ 转存为站内素材
   *   - 已是 /api/asset/ → 原样返回
   *
   * 为什么必须过这一步：模型侧要能拉到图，浏览器 blob 和厂商临时外链都拉不到；
   * 之前从成果区「用作输入」时只处理了 blob，工作台编辑产出（也是 blob）会漏过去，
   * 导致上游收到一个无效地址（表现为 ENOENT / 请上传参考图）。
   */
  // 统一走共用实现（工具面板 / Agent / 批量处理同一份，避免口径分散）
  const ensureServerUrl = useCallback((url: string) => ensureServerUrlShared(url), [])

  // 拖拽进「操作面板」的图片上传槽：直接走该槽位的上传逻辑（上传服务器换公网链接）。
  // 与拖进成果区（只存本地 blob）区分开——面板上传区是「给模型看的输入」，必须公网可达。
  const onDropToUploadSlots = useCallback(async (files: FileList | File[]) => {
    const slots = (tool?.slots ?? []).filter(
      (s) => s.type === 'upload' && !s.hidden && (s.accept ?? ['image']).includes('image'),
    )
    if (slots.length === 0) return false
    // 多个上传口时按顺序轮流分配（与「用作输入」下拉的语义一致）
    const list = Array.from(files)
    setUploading((n) => n + list.length)
    let ok = 0
    for (let i = 0; i < list.length; i++) {
      const slot = slots.length === 1 ? slots[0] : slots[i % slots.length]
      const multiple = slot.multiple ?? false
      try {
        const fd = new FormData()
        fd.append('file', list[i])
        fd.append('source', 'tool')
        // apiFetch 已支持 FormData（Q-810）
        const r = await apiFetch<{ url: string }>('/api/assets', { method: 'POST', body: fd })
        if (!r.success || !r.data?.url) {
          message.error(r.message || '上传失败')
          continue
        }
        // 先把 url 取出来：setValues 的回调里 `r.data` 的收窄会失效（TS 看得见，运行时也不会是 null）
        const uploadedUrl = r.data.url
        ok++
        setValues((prev) => {
          const cur = prev[slot.id]
          const arr = Array.isArray(cur) ? cur : cur ? [cur] : []
          return { ...prev, [slot.id]: multiple ? [...arr, uploadedUrl] : uploadedUrl }
        })
      } catch {
        message.error('上传失败')
      } finally {
        setUploading((n) => Math.max(0, n - 1))
      }
    }
    if (ok > 0) message.success(`已上传 ${ok} 张到「${slots[0].label}」`)
    return true
  }, [tool, message])

  // 记住当前工具：点导航「工具箱」时要直达它。
  // 用 cookie 而非 localStorage —— /tools 入口是**服务端重定向**，读不到 localStorage。
  useEffect(() => {
    // 只有工具模式才记「上次用的工具」：Agent 页不该污染这个记忆
    // composer 试点工具（视频/图像生成）也不记：它们的入口是「创作」导航，
    // 工具箱的记忆里不该出现它们 —— 否则「上次用了创作区的视频生成」会让
    // 点「工具箱」默认进视频生成，绕过了创作区的入口语义。
    if (isAgent || !toolSlug || CREATE_TOOL_SLUGS.includes(toolSlug)) return
    document.cookie = `lastToolSlug=${encodeURIComponent(toolSlug)};path=/;max-age=${60 * 60 * 24 * 90};samesite=lax`
  }, [isAgent, toolSlug])

  // ?prompt= 深链：首页「Agent」入口把用户的想法带进来，预填进对话框（不自动发送）。
  // 工具模式在读工具详情时顺带读取（它要写进文本槽位）；Agent 模式没有工具详情，
  // 所以这里独立读一次 —— 两条路径共用 urlPrompt 这一个 state，不各自维护。
  useEffect(() => {
    if (!isAgent) return
    const presetPrompt = new URLSearchParams(window.location.search).get('prompt')
    if (presetPrompt) setUrlPrompt(presetPrompt)
  }, [isAgent])

  useEffect(() => {
    // Agent 页没有「宿主工具」：不拉工具详情，只拉模型列表（Agent 内部自己选模型）。
    if (isAgent || !toolSlug) {
      let alive = true
      apiFetch<ModelOption[]>('/api/models', { silent401: true })
        .then((m) => { if (alive && m.success && Array.isArray(m.data)) setModels(m.data) })
        .catch(() => {})
      return () => { alive = false }
    }
    // 缓存命中：同 slug 已加载过 → 直接复用，不重拉（切换模式不再闪 loading）
    const cached = toolCacheRef.current.get(toolSlug)
    if (cached) {
      setTool(cached)
      setLikeCount(cached.likeCount)
      setNotFound(false)
      setRetiredMigration(null)
      setInitialLoad(false)
      return
    }
    let alive = true
    Promise.all([
      apiFetch<ToolDetail>(`/api/tools/${toolSlug}`),
      apiFetch<ModelOption[]>('/api/models', { silent401: true }),
    ]).then(([t, m]) => {
      if (!alive) return
      if (t.success && t.data) {
        // 已下架但有承接方 → 展示迁移引导（不进执行界面）
        if (t.data.retired && t.data.migration) {
          setRetiredMigration(t.data.migration)
          setTool(null)
          return
        }
        setTool(t.data)
        toolCacheRef.current.set(toolSlug, t.data)
        setLikeCount(t.data.likeCount)
        // 默认值：风格默认勾选第一个、模型空=自动、比例取快照默认
        const init: Record<string, unknown> = {}
        for (const s of t.data.slots) {
          // ratio 槽：图片用 {ratio,tier}；视频端口是 aspectRatio，用 {ratio} 即可
          // （分辨率/时长由面板在选好模型后按能力给出，默认留空 = 用节点预设）
          if (s.type === 'ratio') {
            const isVideoSlot = (s.targets[0]?.port ?? '') === 'aspectRatio'
            init[s.id] = isVideoSlot
              ? { ratio: s.defaultRatio ?? '16:9' }
              : { ratio: s.defaultRatio ?? '1:1', tier: s.defaultTier ?? '1K' }
          }
          if (s.type === 'choice') init[s.id] = s.options?.[0]?.nodeId ? [s.options[0].nodeId] : []
          if (s.type === 'number') init[s.id] = s.multipliers?.[0] ?? 1
          // 可见文本槽：预填快照里目标端口的原值。
          // 此前面板是空白、执行时才用快照原值 —— 用户「看不见」作者写好的模板，
          // 想改一个字也只能整段重打（模板工具的核心价值就是这段预填内容）。
          // 注意只预填非空字符串：空值继续走 `values[slot.id] === undefined` 的
          // 「不覆盖快照」语义，避免把作者留空的端口写成空串。
          if (s.type === 'text' && !s.hidden) {
            const target = s.targets[0]
            const sourceNode = target
              ? t.data.workflow?.nodes?.find((n) => n.id === target.nodeId)
              : undefined
            const seeded = target && sourceNode ? sourceNode.inputs?.[target.port] : undefined
            if ((typeof seeded === 'string' && seeded) || typeof seeded === 'number') {
              init[s.id] = String(seeded)
            }
          }
          // 隐藏槽（如 LLM 系统提示词默认值）：不预填——面板值空 = 执行时用快照原值，避免空串覆盖快照
        }
        // URL 预填（首页创作入口跳转）：?prompt=xxx 自动写入文本/提示词槽位
        const presetPrompt = new URLSearchParams(window.location.search).get('prompt')
        if (presetPrompt) setUrlPrompt(presetPrompt)
        if (presetPrompt) {
          // 优先写真正的 prompt 端口；没有才退回第一个可见文本槽。
          // 否则像「九宫格循环帧」这种第一个文本槽是「角色外观」的工具，
          // 深链会把用户的画面描述塞进角色字段。
          const textSlot = t.data.slots.find(
            (s) => s.type === 'text' && !s.hidden && s.targets.some((t) => t.port === 'prompt'),
          ) ?? t.data.slots.find((s) => s.type === 'text' && !s.hidden)
          if (textSlot) init[textSlot.id] = presetPrompt
        }
        setValues(init)
      } else setNotFound(true)
      if (m.success && Array.isArray(m.data)) setModels(m.data)
      setInitialLoad(false)
    }).catch(() => { if (alive) setNotFound(true) })
    return () => { alive = false }
  }, [isAgent, toolSlug])

  useResultRecovery()

  // 注意：这里刻意不在卸载时中止执行——运行队列由常驻 store 托管，
  // 页面卸载/切换工具时任务继续跑，产出照常回填成果区（这是「工作流不丢失」的关键）。

  const setVal = useCallback((id: string, v: unknown) => {
    setValues((prev) => {
      const next = { ...prev, [id]: v }
      // 被依赖的槽（如「平台」）变化后，把依赖它的 choice 里**不再可见的已选项**清掉。
      // 不清理的话会出现「切到 Amazon，OZON 专属方向已从列表消失、
      // 但仍留在勾选状态里被一起提交」的脏状态。
      for (const slot of tool?.slots ?? []) {
        if (slot.type !== 'choice' || !slot.dependsOn || slot.dependsOn.slotId !== id) continue
        if (!slot.dependsOn.filterByTag) continue
        const now = String((next as Record<string, unknown>)[slot.dependsOn.slotId] ?? '')
        if (!now) continue // 依赖值为空 → 显示全部，无需清理
        const sel = Array.isArray(next[slot.id]) ? (next[slot.id] as string[]) : []
        const kept = sel.filter((nodeId) => {
          const opt = (slot.options ?? []).find((o) => o.nodeId === nodeId)
          if (!opt) return true // 找不到定义（旧数据）→ 不擅自清掉
          const tags = opt.tags ?? []
          return tags.includes('*') || tags.includes(now)
        })
        if (kept.length !== sel.length) next[slot.id] = kept
      }
      return next
    })
  }, [tool])

  // 只有 result 槽位目标节点的产出才算成果（否则上传/预览等透传节点会把同一张图重复写进成果区）
  const resultNodeIds = useMemo(() => {
    const set = new Set<string>()
    for (const s of tool?.slots ?? []) {
      if (s.type === 'result') for (const t of s.targets) set.add(t.nodeId)
    }
    return set
  }, [tool])
  const formSlots = useMemo(() => {
    const visible = (tool?.slots ?? []).filter((s) => s.type !== 'result' && !s.hidden)
    // 单选分支槽（如「AI 写分镜 / 直接用描述」）未选中时按 buildRuns 的默认取第一项；
    // 未选中的分支不会执行，它的模型槽也不该显示/强制选择。
    const singleChoices = visible.filter((s) => s.type === 'choice' && s.single === true)
    const selectedByChoice = new Map<string, Set<string>>()
    for (const slot of singleChoices) {
      const raw = values[slot.id]
      const picked = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String)
      const effective = picked.length > 0
        ? picked
        : slot.required !== false && (slot.options?.length ?? 0) > 0
          ? [slot.options![0].nodeId]
          : []
      selectedByChoice.set(slot.id, new Set(effective))
    }
    return visible.filter((s) => {
      if (s.type !== 'model') return true
      const owner = singleChoices.find((cs) => (cs.options ?? []).some((o) => o.nodeId === s.targets[0]?.nodeId))
      if (!owner) return true
      const picked = selectedByChoice.get(owner.id)
      return Boolean(picked && s.targets.some((t) => picked.has(t.nodeId)))
    })
  }, [tool, values])
  const uploadSlots = useMemo(() => formSlots.filter((s) => s.type === 'upload' && (s.accept ?? ['image']).includes('image')), [formSlots])

  /**
   * 视频模型的「生成方式」（面板第二步，2026-11-08）。
   *
   * 合并后的 H3（文生 / 多图参考 / 首尾帧）在 metadata.video.modes 里声明方式；
   * 模型声明 ≥2 种 → 面板出现方式选择器，上传框按方式显隐、首尾帧方式补必填校验。
   * 动作迁移 / 对口型等单形态模型不声明 modes → 无选择器，行为与旧版一致。
   * 模式只是 UI + 校验层的概念：执行器按实际素材形态提交（带尾帧 → 首尾帧工作流）。
   */
  const videoModelSlot = formSlots.find((s) => s.type === 'model' && (s.modelType ?? '') === 'VIDEO')
  const videoModel = models.find((m) => m.id === (videoModelSlot ? values[videoModelSlot.id] : undefined))
  const videoModes = useMemo(() => {
    if (!videoModel || videoModel.type !== 'VIDEO') return []
    return sortVideoModes(getVideoCapabilities(videoModel).modes.filter((m) => !!VIDEO_MODE_LABELS[m]))
  }, [videoModel])
  // 模式值在渲染期派生（不进 effect）：用户偏好只在声明的方式里生效，
   // 换模型后偏好失效就自动回落到第一种 —— 无需 effect 同步。
  const [videoModePref, setVideoModePref] = useState<string | undefined>(undefined)
  const videoMode = videoModes.length >= 2
    ? (videoModePref && videoModes.includes(videoModePref) ? videoModePref : videoModes[0])
    : videoModes[0]

  /** 上传槽在当前生成方式下是否生效（隐藏的槽不进 payload、不参与必填校验） */
  const slotActiveInVideoMode = useCallback((slot: ToolSlot): boolean => {
    const cap = videoModel && videoModel.type === 'VIDEO' ? getVideoCapabilities(videoModel) : null
    return slotVisibleInVideoMode(
      slot,
      videoMode,
      cap && videoMode === 'multiReference' ? resolveVideoMediaSlots(cap) : null,
    )
  }, [videoMode, videoModel])

  /**
   * 下发给 Media Studio 顶栏「用作输入」的槽位清单。
   * 只传 id+label：编辑器不关心槽位的其它语义，只负责选了之后回传 slotId。
   * 用 useMemo 保持引用稳定 —— 否则每次渲染都推一次 postMessage。
   */
  const inputSlots = useMemo(
    () => uploadSlots.map((s) => ({ id: s.id, label: s.label })),
    [uploadSlots],
  )

  // ===== 必填校验：缺哪些口 =====
  const missingLabels = useMemo(() => {
    if (!tool) return []
    const miss: string[] = []
    for (const s of formSlots) {
      // 当前生成方式下隐藏的槽不参与校验（如首尾帧方式下不要求参考图）
      if (!slotActiveInVideoMode(s)) continue
      if (!s.required) continue
      const v = values[s.id]
      if (s.type === 'upload' && (!v || (Array.isArray(v) && v.length === 0))) miss.push(s.label)
      if (s.type === 'text' && (typeof v !== 'string' || !v.trim())) miss.push(s.label)
      // 模型必选：不选会走后端兜底，规格/质量按默认参数发出，用户拿不到想要的图
      if (s.type === 'model' && (typeof v !== 'string' || !v)) miss.push(s.label)
    }
    // 首尾帧方式下首/尾帧是槽位定义外的**方式级必填**（槽位本身 optional，
    // 否则多图参考方式会被拓扑必填拦住）—— 这里按方式补校验。
    if (videoMode === 'firstLastFrame' && videoModelSlot) {
      for (const s of formSlots) {
        if (s.type !== 'upload') continue
        const isFrameSlot = s.videoModeOnly === 'firstLastFrame'
          || ['firstFrame', 'lastFrame'].includes(s.targets[0]?.port ?? '')
        if (!isFrameSlot) continue
        const v = values[s.id]
        if (!v || (Array.isArray(v) && v.length === 0)) miss.push(s.label)
      }
    }
    return miss
  }, [tool, formSlots, values, videoMode, slotActiveInVideoMode])

  // ===== 积分预估（本地：模型单价 × 份数；份数只由风格选中数与数量控件决定，多图上传不按张展开） =====
  const estimate = useMemo(() => {
    if (!tool) return { runs: 1, points: 0, beans: 0, uncertain: false }
    let runs = 1
    for (const s of formSlots) {
      if (s.type === 'choice') {
        const sel = (Array.isArray(values[s.id]) ? values[s.id] : []) as string[]
        if (sel.length > 0) runs = Math.max(runs, sel.length)
      }
      if (s.type === 'number' && typeof values[s.id] === 'number') runs *= values[s.id] as number
    }
    // 粗估：按默认模型每节点一次的常见单价（生图 1~6、LLM 1），无法精确到节点就给区间语义
    let points = 0
    let beans = 0
    let uncertain = false
    for (const s of formSlots) {
      if (s.type !== 'model') continue
      const mid = values[s.id]
      const m = typeof mid === 'string' && mid ? models.find((x) => x.id === mid) : undefined
      if (m?.effectiveCostPoints != null) points += m.effectiveCostPoints
      else if (m?.isFree) points += 0
      else uncertain = true
    }
    // 生图类默认模型多数 1 积分/次：按份数给个下限
    const hasImage = formSlots.some((s) => s.type === 'ratio' && s.targets[0]?.port !== 'aspectRatio')
    if (hasImage && points === 0) { points = runs; uncertain = true }
    else if (hasImage) points = Math.max(points, runs)
    // 视频模型按豆计费（run route 按 planNodeCharge 预检豆）：未选模型时按份数 × 视频默认价粗估
    const hasVideo = formSlots.some((s) => s.type === 'model' && (s.modelType ?? '') === 'VIDEO')
      || formSlots.some((s) => s.type === 'ratio' && s.targets[0]?.port === 'aspectRatio')
    if (hasVideo) {
      for (const s of formSlots) {
        if (s.type !== 'model') continue
        const mid = values[s.id]
        const m = typeof mid === 'string' && mid ? models.find((x) => x.id === mid) : undefined
        if (m?.videoCost != null) beans += m.videoCost * runs
        else if (m && videoBeansLabel(m.videoCost, m.metadata)) {
          // 按秒计价（perSecondBeans / perSecondByResolution）：按 5 秒参考时长粗估，
          // 精确值由服务端 exact 校准 —— 本地估只是请求返回前的即时反馈。
          const rate = Number(m.metadata?.perSecondBeans ?? 0) > 0
            ? Number(m.metadata?.perSecondBeans)
            : (() => {
              const rates = Object.values(
                ((m.metadata?.video as Record<string, unknown> | undefined)?.billing as Record<string, unknown> | undefined)?.perSecondByResolution as Record<string, number> | undefined
                ?? {},
              ).map(Number).filter((n) => Number.isFinite(n) && n > 0)
              return rates.length > 0 ? Math.min(...rates) : 0
            })()
          beans += rate * 5 * runs
          uncertain = true
        }
        else if (m && m.isFree) beans += 0
        else { beans += 6 * runs; uncertain = true }
      }
    }
    return { runs, points, beans, uncertain }
  }, [tool, formSlots, values, models])

  // ===== 服务端精确预估：与真实扣费同一套计算（含免费额度抵扣），替换「约 N 积分」 =====
  // 本地 estimate 只用于请求返回前的即时反馈；拿到服务端结果后以服务端为准。
  const [exactResult, setExact] = useState<{ key: string; points: number; beans: number; runs: number } | null>(null)
  /**
   * 沉浸式 Composer（2026-11-08 试点）：tags 带 'composer' 的工具用底部输入条替代
   * 右侧操作面板。只是**渲染层**切换 —— values/校验/预估/执行与经典面板完全同源。
   */
  const isComposer = !!tool?.tags?.includes('composer')
  const valuesKey = useMemo(() => JSON.stringify(values), [values])
  const estimateKey = `${tool?.id ?? ''}:${videoMode ?? ''}:${valuesKey}`
  const exact = exactResult?.key === estimateKey ? exactResult : null
  useEffect(() => {
    // Agent 页没有工具表单，也就没有「这个工具的预估扣费」这回事
    if (isAgent || !tool || !user) return
    let alive = true
    const timer = setTimeout(() => {
      const payload: Record<string, unknown> = {}
      for (const s of tool.slots) {
        if (s.type === 'result') continue
        if (!slotActiveInVideoMode(s)) continue
        const v = values[s.id]
        if (v !== undefined && v !== null && v !== '') payload[s.id] = v
      }
      apiFetch<{ points: number; beans: number; runs: number }>(`/api/tools/${tool.id}/run`, {
        method: 'PUT', silent401: true, body: JSON.stringify({ values: payload }),
      }).then((r) => { if (alive && r.success && r.data) setExact({ ...r.data, key: estimateKey }) }).catch(() => { /* 保留本地粗估 */ })
    }, 350)
    return () => { alive = false; clearTimeout(timer) }
  }, [isAgent, tool, user, valuesKey, values, slotActiveInVideoMode, estimateKey])

  // ===== 运行：派发到常驻队列（store），页面卸载/切工具都不会中断 =====
  const run = useCallback(async () => {
    if (!tool) return
    if (!user) { router.push('/login'); return }
    if (missingLabels.length > 0) {
      message.warning(`请先完成：${missingLabels.join('、')}`)
      return
    }
    // 还在上传服务器：等传完再跑，避免带着 blob 地址发出去
    if (uploading > 0) {
      message.warning('素材正在上传，请稍候再点开始生成')
      return
    }
    // 兜底校验：槽位里若有非站内地址（blob/data/外链），说明没走完上传流程。
    // 直接拦下并尝试补传，避免上游收到无效地址（表现为 ENOENT / 请上传参考图）。
    const pending = formSlots
      .filter((sl) => sl.type === 'upload')
      .flatMap((sl) => {
        const v = values[sl.id]
        const arr = Array.isArray(v) ? v : v ? [v] : []
        return arr.filter((u) => typeof u === 'string' && u && !u.startsWith('/api/asset/') && !u.startsWith('/generated/'))
      })
    if (pending.length > 0) {
      message.loading({ content: '正在上传图片到服务器…', key: 'uploading-assets', duration: 0 })
      try {
        const fixed = new Map<string, string>()
        for (const u of pending) fixed.set(u, await ensureServerUrl(u))
        setValues((prev) => {
          const next = { ...prev }
          for (const sl of formSlots) {
            if (sl.type !== 'upload') continue
            const v = next[sl.id]
            if (Array.isArray(v)) next[sl.id] = v.map((x) => (typeof x === 'string' && fixed.has(x) ? fixed.get(x)! : x))
            else if (typeof v === 'string' && fixed.has(v)) next[sl.id] = fixed.get(v)!
          }
          return next
        })
        message.success({ content: '图片已就绪，请再点一次开始生成', key: 'uploading-assets' })
      } catch (e) {
        message.error({ content: e instanceof Error ? e.message : '图片上传服务器失败', key: 'uploading-assets' })
      }
      return
    }
    if (window.matchMedia('(max-width: 1023px)').matches) { setMTab('workbench'); setMResultsOpen(false) } // 移动端：运行时切到工作台看进度
    const payloadValues: Record<string, unknown> = {}
    for (const s of tool.slots) {
      if (s.type === 'result') continue
      if (!slotActiveInVideoMode(s)) continue
      const v = values[s.id]
      if (v !== undefined && v !== null && v !== '') payloadValues[s.id] = v
    }
    // 不 await：派发后立刻返回，页面可继续操作/继续派发下一批
    void startRun({
      toolId: tool.id,
      toolName: tool.name,
      values: payloadValues,
      estRuns: Math.max(1, estimate.runs),
      resultNodeIds: [...resultNodeIds],
      llmNodes: (tool.workflow?.nodes ?? [])
        .filter((n) => n.type === 'llm-chat')
        .map((n) => ({ id: n.id, label: n.label ?? 'LLM' })),
    })
  }, [tool, values, user, router, message, missingLabels, estimate, startRun, resultNodeIds, uploading, formSlots, ensureServerUrl, slotActiveInVideoMode])

  const stop = useCallback(() => {
    if (!activeJob) return
    stopJob(activeJob.id)
    // 批量图像处理是站内直连调用，abort 会真的取消在途请求；工具运行是 SSE 流，
    // 中止只停止等待、后台任务自然结束（产出仍会回填）。
    message.info(
      IMAGE_BATCH_OPS.includes(activeJob.toolId as ImageBatchOp)
        ? `已停止${IMAGE_BATCH_META[activeJob.toolId as ImageBatchOp]?.label ?? '处理'}，未完成的已取消`
        : '已停止等待，任务将在后台自然结束',
    )
  }, [activeJob, stopJob, message])

  // ===== 成果区批量操作 =====
  // 只对已完成的成果生效：运行中的占位没有可下载内容，也不该被「删除」误导成取消任务
  const doneResults = useMemo(() => results.filter((r) => r.status === 'done' && r.url), [results])

  /**
   * 「失效」成果：生成成功但图打不开（imageState='expired'）。
   *
   * 为什么单独拎出来：upstream 链接会过期，用户攒一批后要一张张挑着删，
   * 很烦。这里给出「仅看失效 / 一键清失效」，把「过期链接」当成一个可筛选维度。
   */
  const expiredResults = useMemo(() => doneResults.filter((r) => r.imageState === 'expired'), [doneResults])
  const [onlyExpired, setOnlyExpired] = useState(false)
  /** 成果区当前展示哪一批：只看失效 或 全部已完成 */
  const visibleResults = onlyExpired ? expiredResults : doneResults
  // 单条/批量删除都走这个收口，统一清掉勾选与当前预览：
  // 否则删完还留着「已选 3」和右侧预览一张已不存在的图。
  const removeResults = useCallback((urls: Iterable<string>) => {
    const set_ = new Set(urls)
    if (set_.size === 0) return 0
    setResults((prev) => prev.filter((r) => !set_.has(r.url)))
    setSelectedUrls((prev) => {
      const next = new Set(prev)
      for (const u of set_) next.delete(u)
      return next
    })
    setActive((cur) => (cur && set_.has(cur.url) ? null : cur))
    return set_.size
  }, [setResults])

  // 两个拖拽落点：成果区（只存浏览器 blob）、操作面板上传区（上传服务器换公网链接）
  const resultsDropRef = useFileDrop(useCallback((files: FileList) => { void onDropFiles(files) }, [onDropFiles]))

  /**
   * 把成果图写入某个上传槽（拖拽与「用作输入」共用同一条路径）。
   *
   * 为什么要先 ensureServerUrl：上传槽的值会作为**生成输入**发给上游，
   * 上游必须能自己拉到这张图 —— blob:/data: 只存在于浏览器，站内相对路径上游也不认。
   * 这里统一换成公网可访问的站内绝对地址。
   */
  const writeSlotFromResult = useCallback(async (slot: (typeof uploadSlots)[number], url: string) => {
    setUploading((n) => n + 1)
    try {
      const serverUrl = await ensureServerUrl(url)
      const multiple = slot.multiple ?? false
      setValues((prev) => {
        const cur = prev[slot.id]
        const arr = Array.isArray(cur) ? cur : cur ? [cur] : []
        return { ...prev, [slot.id]: multiple ? [...arr, serverUrl] : serverUrl }
      })
      message.success(`已作为输入放入「${slot.label}」`)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '作为输入失败')
    } finally {
      setUploading((n) => Math.max(0, n - 1))
    }
  }, [uploadSlots, ensureServerUrl, message])

  /**
   * 编辑器顶栏「用作输入」：把编辑结果（blob）写进上传槽。
   *
   * 为什么不直接复用 writeSlotFromResult：那个收的是 URL（成果图），
   * 这里手上只有跨 realm 传来的 Blob —— 先转 objectURL 再走 ensureServerUrl，
   * 之后与其它入口完全同一条通道（同一个上传/回填/提示口径）。
   * blob URL 用完即 revoke，避免编辑器反复编辑时累积泄漏。
   */
  const writeSlotFromBlob = useCallback(async (slotId: string | null, blob: Blob) => {
    const slot = (slotId && uploadSlots.find((s) => s.id === slotId)) || uploadSlots[0]
    if (!slot) { message.warning('这个工具没有可写入的图片输入口'); return }
    const objectUrl = URL.createObjectURL(blob)
    try {
      await writeSlotFromResult(slot, objectUrl)
    } catch (e) {
      message.error(e instanceof Error ? e.message : '用作输入失败')
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }, [uploadSlots, writeSlotFromResult, message])

  /**
   * 成果图拖进「操作面板」：当作生成输入。
   *
   * 语义与「用作输入」按钮完全一致 —— 都要过服务器换成公网地址。
   * 只有一个上传口时直接写入；多个口时交给 antd Dragger 自己处理（拖到哪个框就进哪个框），
   * 这里只在拖到面板空白处时兜底写入第一个口。
   */
  const onPanelDropResult = useCallback((payload: ResultDragPayload) => {
    if (uploadSlots.length === 0) return
    if (payload.kind !== 'image') { message.warning('上传区只支持图片'); return }
    void writeSlotFromResult(uploadSlots[0], payload.url)
  }, [uploadSlots, writeSlotFromResult, message])

  /** 成果图拖进「工作台」：打开编辑（与点击成果图同一效果） */
  const onWorkbenchDropResult = useCallback((payload: ResultDragPayload) => {
    setActive({ url: payload.url, kind: payload.kind, label: payload.label })
  }, [])

  // 面板落点：本地文件走 onDropToUploadSlots；站内成果图走 onPanelDropResult。
  // skipSelector 让 antd Dragger 自己处理落在上传框内的拖拽（避免同一文件传两次）。
  const panelDropRef = useFileDrop(
    useCallback((files: FileList) => { void onDropToUploadSlots(files) }, [onDropToUploadSlots]),
    // 工具没有图片上传口时关闭该落点：否则拖上去会亮起「可放入」但松手什么都不发生
    { skipSelector: '[data-upload-slot]', disabled: uploadSlots.length === 0, onResult: onPanelDropResult },
  )

  /** 工作台落点：只接受站内成果图拖拽（本地文件由 iframe 子页转发，不走这里） */
  const workbenchDropRef = useFileDrop(
    useCallback(() => { /* 本地文件不走这条：子页 msp:files 已转发到成果区通道 */ }, []),
    { onResult: onWorkbenchDropResult },
  )

  /**
   * document 级兜底：把文件拖到「两个落点之外」时，浏览器默认会直接打开该文件
   * （整个页面被替换成一张图）。这里只 preventDefault，不做任何状态更新、不渲染任何东西，
   * 所以不会带来拖拽卡顿。
   *
   * 落点自身的 handler 会 stopPropagation，因此落到成果区/上传区时不会走到这里。
   */
  useEffect(() => {
    const isFileDrag = (e: DragEvent) => {
      const types = Array.from(e.dataTransfer?.types ?? [])
      // 站内成果图拖拽用自定义 MIME（application/x-aigc-hub-result），不带 Files。
      // 这种拖拽**不该**被浏览器当成「拖文件进页面」，所以判 File 时排除掉它，
      // 否则拖成果图会把页面顶掉。
      return types.length === 0 || types.includes('Files')
    }
    const onOver = (e: DragEvent) => { if (isFileDrag(e)) e.preventDefault() }
    const onDrop = (e: DragEvent) => { if (isFileDrag(e)) e.preventDefault() }
    document.addEventListener('dragover', onOver)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragover', onOver)
      document.removeEventListener('drop', onDrop)
    }
  }, [])
  const selectedItems = useMemo(
    () => doneResults.filter((r) => selectedUrls.has(r.url)),
    [doneResults, selectedUrls],
  )

  const toggleSelect = useCallback((url: string) => {
    setSelectedUrls((prev) => {
      const next = new Set(prev)
      if (next.has(url)) next.delete(url)
      else next.add(url)
      return next
    })
  }, [])

  /**
   * 清理失效的勾选。
   *
   * 为什么需要：勾选状态用 url 做 key，而成果会因为「单条删除 / 批量删除 / 新一批成果挤掉旧的」
   * 从列表消失。不清理的话 selectedUrls 会残留，表现为「已选 3」但列表里只有 1 张被勾选、
   * 全选按钮判断错乱、下载/删除按钮的可用状态也对不上。
   */
  useEffect(() => {
    setSelectedUrls((prev) => {
      if (prev.size === 0) return prev
      const alive = new Set(doneResults.map((r) => r.url))
      let changed = false
      const next = new Set<string>()
      for (const u of prev) {
        if (alive.has(u)) next.add(u)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [doneResults])

  const toggleSelectAll = useCallback(() => {
    // 全选跟随当前视图：切到「仅看失效」时全选的就是失效那批，
    // 而不是偷偷把没显示的也勾上（否则一键删除会连用户没看到的图一起删）。
    const urls = visibleResults.map((r) => r.url)
    setSelectedUrls((prev) => (prev.size === urls.length && urls.every((u) => prev.has(u)) ? new Set() : new Set(urls)))
  }, [visibleResults])

  /** 删除某批成果（统一走确认弹窗 + removeResults 收口） */
  const deleteResultsWithConfirm = useCallback((targets: ResultItem[], title: string) => {
    if (targets.length === 0) return
    modal.confirm({
      title,
      content: '仅从成果区移除，不影响「我的素材」里已保存的文件，也不会删除任务记录。',
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => {
        const n = removeResults(targets.map((r) => r.url))
        message.success(`已移除 ${n} 个成果`)
      },
    })
  }, [modal, message, removeResults])

  /** 一键清理全部失效成果（过期链接） */
  const cleanupExpired = useCallback(() => {
    deleteResultsWithConfirm(expiredResults, `清理全部 ${expiredResults.length} 个失效成果？`)
  }, [deleteResultsWithConfirm, expiredResults])

  /**
   * 滑动批量选择（rubber-band）：按住鼠标在成果列表的**空白处**拖出一个选择框，
   * 框到的成果即被勾选（框选期间再拖不累积勾选，松手一次性落定）。
   *
   * 为什么是「空白处起手的框选」而不是「按住划过即选」：成果卡片自带 draggable
   * （拖去上传区/工作台是既有手势），按住划过会和它抢。框选避开卡片起手，互不干扰。
   *
   * 阈值 6px：位移小于它就当作普通点击 → 点空白 = 清空勾选（常规预期）。
   */
  const [band, setBand] = useState<{ left: number; top: number; w: number; h: number } | null>(null)
  // 起手点（容器坐标）+ 是否已越过阈值；用 ref 存，避免 pointermove 每帧重渲染
  const bandStartRef = useRef<{ x: number; y: number; active: boolean; base: Set<string> } | null>(null)
  const bandHostRef = useRef<HTMLDivElement | null>(null)

  const onBandPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // 只响应主键；点在卡片上交给卡片自己的点击/拖拽，不抢
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('[data-result-row]')) return
    const host = e.currentTarget
    bandHostRef.current = host
    const r = host.getBoundingClientRect()
    bandStartRef.current = {
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      active: false,
      // 按住 Shift 时在已有勾选基础上追加（框选局部补充），否则以空集起手
      base: e.shiftKey ? new Set(selectedUrls) : new Set<string>(),
    }
  }, [selectedUrls])

  // move/up 挂 window：指针拖出列表范围也照样收得到
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const st = bandStartRef.current
      const host = bandHostRef.current
      if (!st || !host) return
      const r = host.getBoundingClientRect()
      const x = e.clientX - r.left
      const y = e.clientY - r.top
      if (!st.active && Math.abs(x - st.x) < 6 && Math.abs(y - st.y) < 6) return
      st.active = true
      const left = Math.min(st.x, x), top = Math.min(st.y, y)
      const right = Math.max(st.x, x), bottom = Math.max(st.y, y)
      setBand({ left, top, w: right - left, h: bottom - top })
      // 实时预览：把框内卡片的 url 勾上（基于起手时的 base，不累积上一帧）
      const picked = new Set(st.base)
      host.querySelectorAll<HTMLElement>('[data-result-row]').forEach((el) => {
        const cr = el.getBoundingClientRect()
        // 用「中心点是否落在框内」判定：比矩形相交更符合直觉（避免只擦到边就选中）
        const cx = cr.left + cr.width / 2 - r.left
        const cy = cr.top + cr.height / 2 - r.top
        if (cx >= left && cx <= right && cy >= top && cy <= bottom && el.dataset.resultUrl) {
          picked.add(el.dataset.resultUrl)
        }
      })
      setSelectedUrls(picked)
    }
    const onUp = () => {
      const st = bandStartRef.current
      bandStartRef.current = null
      bandHostRef.current = null
      setBand(null)
      // 轻点空白（没越过阈值）→ 清空勾选
      if (st && !st.active) setSelectedUrls(new Set())
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  const batchDelete = useCallback(() => {
    const count = selectedItems.length
    if (count === 0) return
    modal.confirm({
      title: `删除选中的 ${count} 个成果？`,
      content: '仅从成果区移除，不影响「我的素材」里已保存的文件，也不会删除任务记录。',
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => {
        // 统一走 removeResults：它同时清勾选/清预览，并把删除记进「已删除名单」
        // （否则刷新后服务端认领会把删掉的图插回来）
        removeResults(selectedItems.map((r) => r.url))
        message.success(`已移除 ${count} 个成果`)
      },
    })
  }, [selectedItems, removeResults, message, modal])

  /**
   * 图片加载失败：**不自动重试**，直接判「链接失效」，由用户决定要不要手动重试。
   *
   * 为什么去掉自动重试（原实现是 5s/10s/20s/30s 递增延时重试最多 5 次）：
   *   1) 重试靠换 URL 参数实现，浏览器会**中止正在进行的加载**再从头下 ——
   *      一张 5MB 大图还没下完就被打断，等于白等一轮，反而更容易失败；
   *   2) 全程要 65 秒才给结论，用户盯着转圈却不知道到底行不行；
   *   3) 结果图用的是上游临时链接，真失效了重试也不会好。
   * 所以：加载不出来就是失效，立刻给结论 + 手动「重试」按钮（用户网络恢复后可自己再试）。
   */
  const handleImgError = useCallback((item: ResultItem) => {
    setResults((prev) => prev.map((x) =>
      x.url === item.url && x.status === 'done' ? { ...x, imageState: 'expired' as const } : x))
  }, [setResults])

  /** 图片加载成功：确保回到正常态（例如手动重试后成功） */
  const handleImgLoad = useCallback((url: string) => {
    setResults((prev) => {
      const hit = prev.find((x) => x.url === url && x.status === 'done')
      // 已经是 ok 且没有重试痕迹就不写回，避免每次 onLoad 都触发一次全量 setState
      const clean = hit && (hit.imageState ?? 'ok') === 'ok' && !hit.retryCount
      if (!hit || clean) return prev
      return prev.map((x) =>
        x.url === url && x.status === 'done'
          ? { ...x, imageState: 'ok' as const, retryCount: 0 }
          : x)
    })
  }, [setResults])

  /** 手动重试：换 cache-busting 参数重新加载（绕过浏览器对失败响应的缓存） */
  const handleImgRetry = useCallback((url: string) => {
    setResults((prev) => prev.map((x) =>
      x.url === url ? { ...x, imageState: 'ok' as const, retryCount: (x.retryCount ?? 0) + 1 } : x))
  }, [setResults])

  const batchDownload = useCallback(async () => {
    const items = selectedItems.length > 0 ? selectedItems : doneResults
    if (items.length === 0) {
      message.warning('还没有可下载的成果')
      return
    }
    setDownloading(true)
    const hide = message.loading({ content: `正在准备下载 ${items.length} 个成果…`, key: 'dl', duration: 0 })
    try {
      const { ok, failed } = await downloadResults(
        items.map((r, i) => ({
          url: r.url,
          kind: r.kind,
          // 文件名带风格名更好认；没有就用「工具名-序号」
          name: r.styleLabel || `${tool?.name || '成果'}-${i + 1}`,
        })),
        (done, total) => message.loading({ content: `正在下载 ${done}/${total}…`, key: 'dl', duration: 0 }),
      )
      hide()
      if (failed === 0) message.success(items.length === 1 ? '已开始下载' : `已打包下载 ${ok} 个成果`)
      else if (ok === 0) message.error(`${failed} 个成果下载失败（链接可能已过期）`)
      else message.warning(`成功 ${ok} 个，失败 ${failed} 个（失败的多为链接已过期）`)
    } catch {
      hide()
      message.error('下载失败')
    } finally {
      setDownloading(false)
    }
  }, [selectedItems, doneResults, tool?.name, message])

  // 后台任务失败/部分失败的提示：页面挂载时消费一次（任务可能在别的工具页跑完）
  useEffect(() => {
    for (const j of myJobs) {
      if (!j.notice || j.noticeConsumed) continue
      if (j.notice.level === 'error') message.error(j.notice.text)
      else if (j.notice.level === 'warning') message.warning(j.notice.text)
      else message.info(j.notice.text)
      markNoticeConsumed(j.id)
    }
  }, [myJobs, message, markNoticeConsumed])

  const toggleLike = useCallback(async () => {
    if (!tool) return
    if (!user) { router.push('/login'); return }
    try {
      const r = await apiFetch<{ likeCount: number; liked: boolean }>(`/api/tools/${tool.id}/like`, {
        method: 'POST', body: JSON.stringify({ cancel: liked }),
      })
      if (r.success && r.data) { setLikeCount(r.data.likeCount); setLiked(r.data.liked) }
    } catch { /* ignore */ }
  }, [tool, liked, user, router])

  if (!isAgent) {
    // 已下架工具的迁移引导：说清楚「去哪、为什么变、怎么用」
    // （商品套图有 289 次使用、5 个重度用户，下架不能只丢一个空状态给他们）
    if (retiredMigration) {
      return (
        <PageContainer>
          <div className="mx-auto grid min-h-[60vh] max-w-xl place-items-center">
            <div className="w-full rounded-2xl border border-black/8 bg-white p-7 text-center shadow-sm">
              <div className="mx-auto mb-3 grid size-11 place-items-center rounded-full bg-accent-soft text-accent">
                <ThunderboltOutlined className="text-[18px]" />
              </div>
              <h2 className="mb-1.5 text-[17px] font-medium text-black/85">这个工具已经升级了</h2>
              <p className="mx-auto mb-5 max-w-md text-[13px] leading-relaxed text-black/55">
                {retiredMigration.note}
              </p>
              <div className="flex items-center justify-center gap-2">
                {/* href：承接方是独立工作区（/create/...）时走完整路径，否则拼 /tools/<slug> */}
                <Button type="primary" onClick={() => navigate(retiredMigration.href ?? `/tools/${retiredMigration.to}`)}>
                  去用新的
                </Button>
                <Button onClick={() => navigate('/tools')}>换个工具</Button>
              </div>
            </div>
          </div>
        </PageContainer>
      )
    }
    if (notFound) {
      return (
        <PageContainer>
          <div className="grid min-h-[60vh] place-items-center">
            <Empty description="工具不存在或未上架">
              {/* /tools 现在是入口重定向（直达上次用的工具），列表页已按用户要求移除 */}
              <Button type="primary" onClick={() => navigate('/tools')}>换个工具</Button>
            </Empty>
          </div>
        </PageContainer>
      )
    }
    // 切换模式时（缓存命中）不再显示 loading——三个模式面板是常驻的，
    // loading 会把整个工作区盖掉，视觉上就是「切一下整页重载」。
    if (!tool) return initialLoad ? <PageState status="loading" /> : null
  }

  return (
    <PageContainer maxWidth="100%" contentClassName="h-full min-h-0" disablePadding>
      {/* 首次进入：工具页引导「模型/规格怎么选」，Agent 页引导「怎么跟它说话」 */}
      <FirstUseGuide storageKey={isAgent ? 'agent' : 'tools'} steps={[...(isAgent ? GUIDE_STEPS.agent : GUIDE_STEPS.tools)]} enabled={!!user} />
      {/* aigc-hub-mobile-bottom-safe：移动端给 NavRail 悬浮菜单球让出底部一条带 ——
          否则它会压住操作面板底部的「技能 / 开始生成」等按钮（用户截图反馈的正是这个）。
          桌面端（>=768px 悬浮球本来就不显示）不受影响。 */}
      <div className="aigc-hub-mobile-bottom-safe flex h-full min-h-0 flex-col px-2 pb-2 pt-2">
        {/* ===== 头部 =====
            tool 模式：工具名下拉快捷切换 + 元信息 + 画布入口（工具身份）
            agent 模式：Agent 身份条 —— 没有工具切换器、没有「在画布中编辑」，
                       因为这一页的主体是智能体，工具只是它可能用到的能力，不是页面身份。 */}
        {createMode ? (
          <div className="relative z-10 mb-2 flex shrink-0 items-center gap-2 px-1">
            <span className="text-[16px] font-medium text-black/80">创作</span>
            <span className="text-xs text-black/40">{createMode === 'agent' ? 'Agent' : createMode === 'image' ? '图像生成' : '视频生成'}</span>
          </div>
        ) : isAgent ? (
          <div className="relative z-10 mb-2 flex shrink-0 items-center gap-2.5 px-1">
            {/* 「怎么用？」紧贴标题 —— 原先孤贴右上角，与标题不在同一视觉组（用户截图反馈）。
                用文字链接而不是描边按钮：它是低频帮助入口，不该抢「去成果区/新对话」的视觉权重。 */}
            <span className="flex items-center gap-1.5 text-[16px] font-medium">
              <RobotOutlined className="text-accent" />
              Agent
            </span>
            <span className="hidden rounded-full border border-accent-border bg-accent-soft px-2 py-0.5 text-[11px] text-accent sm:inline">
              智能体
            </span>
            <button
              type="button"
              className="shrink-0 text-[12px] text-black/45 underline-offset-2 transition hover:text-accent hover:underline"
              onClick={() => message.info('直接在右侧对话框说需求即可；想按某类场景的规则来，先点输入框旁的「技能」选一个。')}
            >
              怎么用？
            </button>
            <span className="hidden min-w-0 flex-1 truncate text-[12px] text-black/40 md:inline">
              多轮对话 + Skills，自动规划并派发生图任务，产出进入下方成果区
            </span>
          </div>
        ) : tool && (
        // —— tool 模式：工具名下拉快捷切换 + 元信息 + 编辑入口，一体化进三栏，不单独占卡
        <div className="relative z-10 mb-2 flex shrink-0 items-center gap-2.5 px-1">
          <Dropdown
            trigger={['click']}
            menu={{
              // 按分类分组展示（基础工具 / 垂直领域），而不是平铺一长串
              items: (() => {
                const byCat = new Map<string, typeof toolList>()
                for (const t of toolList) {
                  // 归一化历史分类别名（文生视频/图生视频/首尾帧生成视频/多图参考生成视频
                  // → 视频生成，2026-10-18 合并）。库里旧数据没清干净时，UI 也不会
                  // 把视频工具错分到「垂直领域」组。
                  const cat = normalizeToolCategory(t.category) || '其他'
                  if (!byCat.has(cat)) byCat.set(cat, [])
                  byCat.get(cat)!.push(t)
                }
                const base = [...byCat.keys()].filter((c) => BASE_CATEGORIES.includes(c as typeof BASE_CATEGORIES[number]))
                const vert = [...byCat.keys()].filter((c) => !BASE_CATEGORIES.includes(c as typeof BASE_CATEGORIES[number]))
                const renderGroup = (label: string, cats: string[]) => ({
                  type: 'group' as const,
                  label,
                  children: cats.flatMap((cat) =>
                    (byCat.get(cat) ?? []).map((t) => ({
                      key: t.id,
                      label: (
                        <span className="flex items-center gap-2">
                          {t.isOfficial && <span className="rounded bg-accent px-1 text-[10px] text-white">官方</span>}
                          <span className="truncate">{t.name}</span>
                          <span className="ml-auto shrink-0 text-[10px] text-black/35">{cat}</span>
                        </span>
                      ),
                    })),
                  ),
                })
                const groups = []
                if (base.length > 0) groups.push(renderGroup('基础工具', base))
                if (vert.length > 0) groups.push(renderGroup('垂直领域', vert))
                // 独立代码工具（路线二）：不在 tools 表里，但同样是一等工具。
                // 不列出来 = 用户不知道它存在（2026-10-18 排查「电商 Agent 在哪」发现）。
                if (STANDALONE_TOOLS.length > 0) {
                  groups.push({
                    type: 'group' as const,
                    label: '独立工具',
                    children: STANDALONE_TOOLS.map((t) => ({
                      key: `standalone:${t.slug}`,
                      label: (
                        <span className="flex flex-col gap-0.5 py-0.5">
                          <span className="flex items-center gap-2">
                            <span className="rounded bg-info/90 px-1 text-[10px] text-white">独立</span>
                            <span className="truncate">{t.name}</span>
                          </span>
                          <span className="truncate text-[10.5px] text-black/40">{t.summary}</span>
                        </span>
                      ),
                    })),
                  })
                }
                return groups
              })(),
              selectedKeys: tool ? [tool.id] : [],
              onClick: ({ key }) => {
                // 独立工具用 `standalone:<slug>` 前缀区分（不在 toolList 里）
                if (key.startsWith('standalone:')) {
                  navigate(`/tools/${key.slice('standalone:'.length)}`)
                  return
                }
                const t = toolList.find((x) => x.id === key)
                if (t) navigate(`/tools/${t.slug}`)
              },
            }}
          >
            <Button type="text" className="!px-2 font-medium" icon={<ThunderboltFilled className="text-accent" />}>
              <span className="text-[16px]">{tool.name}</span>
              <DownOutlined className="ml-1.5 text-[10px] text-black/40" />
            </Button>
          </Dropdown>
          {tool.isOfficial && (
            <span className="rounded-full bg-gradient-to-r from-accent to-accent-2 px-2 py-0.5 text-[11px] font-medium text-white shadow-sm">官方</span>
          )}
          {tool.category && (
            <span className="hidden rounded-full border border-accent-border bg-accent-soft px-2 py-0.5 text-[11px] text-accent sm:inline">{tool.category}</span>
          )}
          <span className="hidden items-center gap-1 text-[12px] text-black/45 sm:flex"><PlayCircleOutlined /> {tool.useCount}</span>
          <span
            className="flex cursor-pointer items-center gap-1 text-[12px] text-black/45 transition hover:text-accent"
            onClick={toggleLike}
          >
            <LikeOutlined style={liked ? { color: 'var(--accent)' } : undefined} /> {likeCount}
          </span>
          {tool.description && <span className="hidden min-w-0 flex-1 truncate text-[12px] text-black/40 md:inline">{tool.description}</span>}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <QuickFavoriteButton currentLabel={tool.name} />
            {/* 想去智能体？给一个**跳转**出口，而不是页内切换器 ——
                页内切换会把「工具页 / Agent 页」两个身份又粘回同一页，
                用户会分不清自己在哪；跳转则保持地址栏与身份一致。 */}
            {createMode && onCreateModeChange && (
              <Tooltip title="切到 Agent：多轮对话帮你规划并批量出图">
                <Button
                  size="small"
                  icon={<RobotOutlined />}
                  className="shrink-0"
                  onClick={() => onCreateModeChange('agent')}
                >
                  <span className="max-sm:hidden">切到 Agent</span>
                </Button>
              </Tooltip>
            )}
            <Tooltip title="在画布中打开这个工具的工作流">
              <Button size="small" icon={<EditOutlined />} className="shrink-0" onClick={() => navigate(`/canvas?load=tool:${tool.id}`)}>
                <span className="max-sm:hidden">在画布中编辑</span>
              </Button>
            </Tooltip>
          </div>
        </div>
        )}

        {/* 移动端极简视图切换：占用头部余量，不再遮挡操作面板运行条 */}
        <div className="mb-2 flex shrink-0 justify-center lg:hidden">
          <div className="flex items-center gap-0.5 rounded-full border border-black/8 bg-white/80 p-0.5 shadow-sm backdrop-blur">
            {([
              // Agent 页右栏是对话，标签就叫「对话」——「操作面板」是工具的语义
              ...((isComposer || isCreateAgent) ? [] : [isAgent
                ? { key: 'panel' as const, label: '对话', icon: <RobotOutlined /> }
                : { key: 'panel' as const, label: '操作面板', icon: <AppstoreOutlined /> }]),
              { key: 'workbench' as const, label: '工作台', icon: <EyeOutlined /> },
            ] as const).map((t) => (
              <button
                key={t.key}
                aria-label={t.label}
                title={t.label}
                className={`relative grid size-7 place-items-center rounded-full text-[12px] transition ${mTab === t.key ? 'bg-gradient-to-r from-accent to-accent-2 text-white shadow-sm' : 'text-black/50 hover:text-accent'}`}
                onClick={() => { setMTab(t.key); setMResultsOpen(false) }}
              >
                {t.icon}
              </button>
            ))}
            <span className="mx-0.5 h-4 w-px bg-black/10" />
            <button
              aria-label="成果"
              title="成果"
              className={`relative grid size-7 place-items-center rounded-full text-[12px] transition ${mResultsOpen ? 'bg-black/80 text-white' : 'text-black/50 hover:text-accent'}`}
              onClick={() => setMResultsOpen((p) => !p)}
            >
              <PictureOutlined />
              {results.length > 0 && <span className={`absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full px-1 text-[9px] leading-none text-white ${mResultsOpen ? 'bg-white/25' : 'bg-accent'}`}>{results.length}</span>}
            </button>
          </div>
        </div>

        {/* ===== 三栏固定：桌面端三栏并排各内滚；移动端单屏 Tab（一次只看一个区） =====
            拖拽落点只有两个：左侧成果区、右侧操作面板的上传区（各自独立监听，见 useFileDrop）。
            中间工作台交给 iframe 自己处理（子页转发文件回父页走成果区通道）。

            【为什么两侧用 clamp 而不是写死 300/400px】
            这三栏是 grid 子项，而 grid 子项默认 min-width:auto（不小于内容宽度）。
            操作面板里是 antd 表单 / 上传槽 / 长下拉，成果区里有长文件名与 URL ——
            一旦内容最小宽度超过轨道宽度，轨道会被顶开、整个 grid 溢出容器。
            clamp() 让两侧在窄桌面时按视口比例收缩（不是先撑破再溢出），
            配合每个子项的 min-w-0 才真正允许缩到内容以下。
            中间栏始终保持 minmax(0,1fr) —— 它是画布，必须能自由收缩。 */}
        <div
          className={`relative grid min-h-0 flex-1 grid-cols-1 gap-2.5 ${
            (isComposer || isCreateAgent || (panelCollapsed && !isAgent))
              ? (resultsCollapsed ? 'lg:grid-cols-1' : 'lg:grid-cols-[clamp(200px,18vw,300px)_minmax(0,1fr)]')
              : resultsCollapsed
              ? 'lg:grid-cols-[minmax(0,1fr)_clamp(300px,26vw,400px)]'
              : 'lg:grid-cols-[clamp(200px,18vw,300px)_minmax(0,1fr)_clamp(280px,24vw,400px)]'
          }`}
        >
          {/* ===== 左：成果列表（电梯式，新成果置顶） ===== */}
          <Card
            ref={resultsDropRef}
            className={`!min-w-0 !rounded-2xl !flex !flex-col max-lg:!hidden lg:!h-full lg:!min-h-0 ${resultsCollapsed ? 'lg:!hidden' : ''}`} styles={{ body: { padding: 10, flex: '1 1 0', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' } }}
            title={<span className="text-[13px] font-medium"><PictureOutlined className="mr-1.5 text-accent" />成果 {results.length > 0 ? `· ${results.length}` : ''}</span>}
            extra={
              // 收起/展开成果区：按钮属于「成果区」自己的动作，放在本卡右上角。
              // 收起后本卡隐藏，改由工作台左边缘的浮钮负责展开（见下方 resultsCollapsed 分支）。
              <Tooltip title="收起成果区（工作台+操作面板放大）">
                <button
                  type="button"
                  aria-label="收起成果区"
                  className="flex h-6 items-center gap-1 rounded-full border border-black/8 bg-white/85 px-2 text-[11px] text-black/55 shadow-sm transition hover:border-accent-ring hover:text-accent"
                  onClick={() => setResultsCollapsed(true)}
                >
                  <LeftOutlined className="text-[10px]" />
                  收起
                </button>
              </Tooltip>
            }
          >
            {/* 批量操作条：有已完成成果才出现，避免空态时占位 */}
            {doneResults.length > 0 && (
              <>
                {/* 过期提示：成果图用上游链接直接展示（不转存），厂商链接有有效期。
                    与其替用户长期保管（费带宽、占盘、还得管清理），不如提醒尽快下载。 */}
                <div className="mb-2 rounded-lg bg-amber-50/70 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-700">
                  成果图使用厂商临时链接，<span className="font-medium">有效期通常几小时到几天</span>，请尽快下载到本地保存。
                  <span className="mt-1 block">
                    刚生成的图如果显示生成失败或加载失败，先刷新浏览器；有时只是还没生成完或没加载完，不一定是真失败。
                  </span>
                </div>
                <div className="mb-2 flex flex-wrap items-center gap-1.5 border-b border-black/[0.06] pb-2">
                <button
                  type="button"
                  onClick={toggleSelectAll}
                  className="rounded-md px-2 py-1 text-[11px] text-black/50 transition hover:bg-black/[0.04] hover:text-accent"
                >
                  {selectedUrls.size === visibleResults.length && visibleResults.length > 0 ? '取消全选' : `全选 ${visibleResults.length}`}
                </button>
                {/* 失效筛选 / 一键清理：过期链接是个可筛选维度，省得一张张挑着删 */}
                {expiredResults.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setOnlyExpired((v) => !v)}
                    className={`rounded-md px-2 py-1 text-[11px] transition ${
                      onlyExpired ? 'bg-amber-100 text-amber-700' : 'text-amber-600 hover:bg-amber-50'
                    }`}
                  >
                    {onlyExpired ? `显示全部 ${doneResults.length}` : `仅看失效 ${expiredResults.length}`}
                  </button>
                )}
                {expiredResults.length > 0 && (
                  <button
                    type="button"
                    onClick={cleanupExpired}
                    className="rounded-md px-2 py-1 text-[11px] text-red-500 transition hover:bg-red-50"
                  >
                    清理失效 {expiredResults.length}
                  </button>
                )}
                {selectedUrls.size > 0 && (
                  <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent">
                    已选 {selectedUrls.size}
                  </span>
                )}
                {/* 批量操作：一个下拉收拢全部动作（放大/抠图/去水印/翻译/下载/删除）。
                    九宫格切割不在其中 —— 它是对「当前编辑的图」的操作，在工作台工具栏。 */}
                <span className="ml-auto flex items-center gap-1">
                  <ResultBatchActions
                    selected={selectedItems}
                    models={models}
                    onDownload={() => void batchDownload()}
                    onDelete={batchDelete}
                    downloading={downloading}
                  />
                </span>
              </div>
              </>
            )}
            {results.length === 0 ? (
              <div className="grid flex-1 place-items-center rounded-xl border border-dashed border-accent-ring/60 bg-accent-soft/40 px-3 py-10 text-center">
                <div>
                  <InboxOutlined className="mb-2 text-2xl text-accent/30" />
                  <Text type="secondary" className="!text-[12px]">生成的成果会出现在这里</Text>
                  <div className="mt-1 text-[11px] text-black/35">
                    支持从本地拖入图片/视频/音频
                    {/* 拖拽是桌面端能力：触屏没有 hover/drag，提示只对桌面显示 */}
                    <span className="hidden lg:inline">
                      ；成果图可直接拖到{isAgent ? '对话框' : '操作面板'}（当输入）或工作台（编辑）
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div
                ref={bandHostRef}
                data-result-band-root
                onPointerDown={onBandPointerDown}
                className="relative min-h-0 flex-1 space-y-2 overflow-y-auto aigc-hub-scrollbar select-none"
              >
                {/* 框选覆盖层：绝对定位于本容器，pointer-events-none 不挡命中 */}
                {band && (
                  <div
                    className="pointer-events-none absolute z-10 rounded border border-accent bg-accent/15"
                    style={{ left: band.left, top: band.top, width: band.w, height: band.h }}
                  />
                )}
                {(onlyExpired ? expiredResults : results).map((r) => (
                  <ResultRow
                    key={r.url || `q-${r.queueId}-${r.queueIndex}`} item={r} active={active?.url === r.url} selected={selectedUrls.has(r.url)}
                    onToggleSelect={() => toggleSelect(r.url)}
                    onClick={() => setActive({ url: r.url, kind: r.kind, label: r.styleLabel })}
                    onImgError={() => handleImgError(r)}
                    onImgLoad={() => handleImgLoad(r.url)}
                    onRetry={() => handleImgRetry(r.url)}
                    onZoom={() => {
                      const imgs = doneResults.filter((x) => x.kind === 'image' && x.url)
                      const idx = imgs.findIndex((x) => x.url === r.url)
                      setLightbox({ open: true, urls: imgs.map((x) => toAssetProxyUrl(x.url)), index: Math.max(0, idx) })
                    }}
                    onRespeed={r.gifSource ? () => setSpeedItem(r) : undefined}
                    onRemove={() => {
                      // 走统一收口：一并记住「已删除」，否则刷新后服务端认领会把它插回来
                      removeResults([r.url])
                    }}
                  />
                ))}
              </div>
            )}
          </Card>

          {/* ===== 中：工作台（自动适配成果类型，支持基础编辑） =====
              成果区收起后，本栏左边缘出现「展开成果」浮钮 —— 否则用户没有入口把成果区叫回来。 */}
          {/* 工作台落点：把成果图拖到这里 = 打开编辑（与点击成果图同效）。
              本地文件仍由 iframe 子页转发（见 onExternalFiles），不走这条。 */}
          <div
            ref={workbenchDropRef}
            className={`relative min-w-0 min-h-[280px] max-lg:!flex-1 max-lg:!min-h-0 lg:h-full lg:min-h-0 ${!isComposer && !isCreateAgent && mTab !== 'workbench' ? 'max-lg:!hidden' : ''}`}
          >
            {resultsCollapsed && (
              <Tooltip title="展开成果区">
                <button
                  className="absolute left-2 top-2 z-10 flex h-7 items-center gap-1 rounded-full border border-black/8 bg-white/85 px-2.5 text-[11px] text-black/55 shadow-sm transition hover:border-accent-ring hover:text-accent"
                  onClick={() => setResultsCollapsed(false)}
                >
                  <RightOutlined className="text-[10px]" />
                  成果
                  {results.length > 0 && <span className="rounded-full bg-accent px-1.5 text-[10px] text-white">{results.length}</span>}
                </button>
              </Tooltip>
            )}
            {!isComposer && (!isAgent || isCreateAgent) && panelCollapsed && (
              <button type="button" onClick={() => setPanelCollapsed(false)} aria-label={isCreateAgent ? '展开 Agent 对话' : '展开操作面板'} className={`absolute right-0 top-1/2 z-30 -translate-y-1/2 rounded-l-xl border border-r-0 border-black/10 bg-white/95 px-2 py-4 text-xs text-black/60 shadow-md transition hover:text-accent ${isCreateAgent ? '' : 'hidden lg:block'}`} style={{ writingMode: 'vertical-rl' }}>
                <LeftOutlined /> {isCreateAgent ? 'Agent 对话' : '操作面板'}
              </button>
            )}
            <Workbench
              item={active}
              onExternalFiles={(files) => { void onDropFiles(files) }}
              // iframe 内拖拽（子页转发）：直接高亮成果区落点。
              // 拖进工作台的文件最终走「成果区」通道，所以高亮成果区才是正确的落点提示；
              // 这里同样只切 DOM class，不碰 React state。
              onExternalDrag={(over) => {
                const el = resultsDropRef.current
                if (!el) return
                if (over) el.classList.add('aigc-hub-drop-active')
                else el.classList.remove('aigc-hub-drop-active')
              }}
              onProduced={(p, opts) => {
                // 编辑产出：替换工作台当前显示（消除“编辑后执行还在用原图”的孤岛问题）+ 追加成果列表。
                // opts.select === false（九宫格切割一次回传 N 张）：只追加成果、不抢焦点，
                // 否则 N 张会依次抢焦点，工作台疯狂重载、最后停在第 N 张，看不到全貌。
                if (opts?.select !== false) setActive({ url: p.url, kind: p.kind, label: p.label })
                // 同步回填上传槽位：槽里若还挂着编辑前的旧图 URL，一并替换成新图，保证点执行用的是编辑后的
                if (p.fromUrl) setValues((prev) => {
                  const next = { ...prev }
                  const replaced: string[] = []
                  for (const s of uploadSlots) {
                    const cur = next[s.id]
                    const from = p.fromUrl
                    if (typeof cur === 'string' && cur === from) next[s.id] = p.url
                    else if (Array.isArray(cur)) {
                      const arr = cur.map((u) => (typeof u === 'string' && u === from ? p.url : u))
                      if (arr.some((u, i) => u !== cur[i])) next[s.id] = arr
                    }
                    if (next[s.id] !== cur) replaced.push(s.label)
                  }
                  if (replaced.length > 0) message.info(`已同步更新输入：${replaced.join('、')}`)
                  return next
                })
                setResults((prev) => [{ ...p, nodeId: 'workbench', status: 'done', styleLabel: p.label }, ...prev])
              }}
              inputSlots={inputSlots}
              onUseAsInput={(slotId, blob) => { void writeSlotFromBlob(slotId, blob) }}
              message={message}
            />
            {isComposer && tool && (
              <div className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center px-3">
                <ComposerBar
                  toolName={tool.name}
                  createMode={createMode}
                  onCreateModeChange={onCreateModeChange}
                  slots={formSlots.filter((slot) => (!slot.videoModeOnly || !!videoMode) && slotActiveInVideoMode(slot))}
                  values={values}
                  models={models}
                  message={message}
                  videoMode={videoMode}
                  videoModes={videoModes}
                  onVideoModeChange={setVideoModePref}
                  hasReferenceImage={formSlots.some((s) => s.type === 'upload' && (s.accept?.[0] ?? 'image') === 'image'
                    && (Array.isArray(values[s.id]) ? (values[s.id] as unknown[]).length > 0 : !!values[s.id]))}
                  estimate={estimate}
                  exact={exact}
                  running={running}
                  uploading={uploading}
                  missingCount={missingLabels.length}
                  onChangeSlot={(id, v) => setVal(id, v)}
                  onUploadActivityChange={onUploadActivityChange}
                  onFilesDropped={(files) => { void onDropToUploadSlots(files) }}
                  onRun={run}
                />
              </div>
            )}
          </div>

          {/* ===== 右：操作面板（原创作面板）；composer 试点工具不渲染 ===== */}
          {!isComposer && (
          <Card
            ref={panelDropRef}
            data-guide="panel"
            className={isCreateAgent
              ? `!min-w-0 !rounded-2xl !flex !flex-col !absolute right-2 top-12 bottom-4 z-30 !h-auto w-[min(440px,calc(100%-16px))] shadow-xl ${panelCollapsed ? '!hidden' : ''}`
              : `!min-w-0 !rounded-2xl !flex !flex-col max-lg:!flex-1 max-lg:!min-h-0 lg:!h-full lg:!min-h-0 ${mTab !== 'panel' ? 'max-lg:!hidden' : ''} ${panelCollapsed && !isAgent ? 'lg:!hidden' : ''}`}
            styles={{ body: { padding: 16, flex: '1 1 0', minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' } }}
            extra={(!isAgent || isCreateAgent) && <button type="button" onClick={() => setPanelCollapsed(true)} aria-label={isCreateAgent ? '收起 Agent 对话' : '收起操作面板'} className={`${isCreateAgent ? 'inline-flex' : 'hidden lg:inline-flex'} rounded-full px-2 py-1 text-xs text-black/45 hover:bg-black/5 hover:text-accent`}>收起 <RightOutlined /></button>}
            title={
            // 纯标题：不再放「工具 / 智能体」切换器 ——
            // Agent 走导航栏入口，工具页只做工具（两个身份不互相寄生）。
            isAgent ? (
              <span className="flex items-center gap-1.5 text-[13px] font-medium">
                <RobotOutlined className="text-accent" />智能体
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-[13px] font-medium">
                <AppstoreOutlined className="text-accent" />操作面板
              </span>
            )
          }>
            {showAgentPanel ? (
              <ToolAgentPanel toolSlug={toolSlug ?? ''} initialPrompt={urlPrompt} createMode={createMode} onCreateModeChange={onCreateModeChange} />
            ) : (
              <>
            <div className="flex-1 space-y-4 max-lg:space-y-3">
              {formSlots.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个工具不需要填什么，直接点开始生成" />}
              {formSlots.map((slot) => (
                <SlotControl
                  key={slot.id}
                  slot={slot}
                  value={values[slot.id]}
                  models={models}
                  selectedModelId={(() => {
                    // ① 先找与本槽**共用节点**的 model 槽（生图规格过滤用，多模型工具不串味）
                    const ms = formSlots.find(
                      (s) => s.type === 'model' && s.targets.some((t) => slot.targets.some((rt) => rt.nodeId === t.nodeId)),
                    )
                    const id = ms ? values[ms.id] : undefined
                    if (typeof id === 'string' && id) return id
                    // ② 没有共用节点（如视频工具的上传槽连的是 vi1/au1 上传节点）：
                    // 若全工具只有**一个** model 槽，也把它作为约束源。
                    // 2026-10-18 修：否则上传槽拿不到所选模型，「素材口跟随模型」
                    // 对视频工具全部失效（实测动作迁移选了模型，参考视频仍显示「可选」）。
                    const modelSlots = formSlots.filter((s) => s.type === 'model')
                    if (modelSlots.length === 1) {
                      const only = values[modelSlots[0].id]
                      return typeof only === 'string' && only ? only : undefined
                    }
                    return undefined
                  })()}
                  needsModelFirst={(() => {
                    const shared = formSlots.some(
                      (s) => s.type === 'model' && s.targets.some((t) => slot.targets.some((rt) => rt.nodeId === t.nodeId)),
                    )
                    // 与上面 selectedModelId 同口径：单 model 槽工具也算前置依赖
                    const modelSlots = formSlots.filter((s) => s.type === 'model')
                    return shared || modelSlots.length === 1
                  })()}
                  // 模型「设为默认」的持久化 key：工具 + 槽位（多模型工具各槽位独立记忆）
                  modelPersistKey={`${tool?.slug ?? toolSlug ?? 'tool'}:${slot.id}`}
                  // 依赖槽当前值：choice 槽按它过滤可选项（多平台套图的方向列表随平台变化）
                  dependsValue={slot.dependsOn ? values[slot.dependsOn.slotId] : undefined}
                  videoMode={videoMode}
                  onVideoModeChange={setVideoModePref}
                  onUploadActivityChange={onUploadActivityChange}
                  onChange={(v) => {
                    // 上传口支持函数式更新（多张并发上传防覆盖）
                    if (typeof v === 'function') setValues((prev) => ({ ...prev, [slot.id]: v(prev[slot.id]) }))
                    else setVal(slot.id, v)
                  }}
                  message={message}
                />
              ))}
            </div>

            {/* 运行条：预估 + 主按钮 + 进度 */}
            <div className="max-lg:sticky max-lg:bottom-0 max-lg:-mx-4 max-lg:mb-[-16px] max-lg:mt-4 max-lg:border-t max-lg:border-black/5 max-lg:bg-white/85 max-lg:px-4 max-lg:py-3 max-lg:pt-3 max-lg:backdrop-blur-xl">
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="primary"
                  size="large"
                  className="!rounded-xl !px-6"
                  data-guide="submit"
                  style={{ background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-2) 100%)', border: 'none' }}
                  icon={<ThunderboltFilled />}
                  loading={uploading > 0}
                  disabled={uploading > 0}
                  onClick={run}
                >
                  {uploading > 0 ? `上传图片中（${uploading}）` : running ? '再生成一次' : '开始生成'}
                </Button>
                {uploading > 0 && (
                  <span className="flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-[12px] text-accent">
                    <LoadingOutlined /> 正在上传到服务器，完成后即可生成
                  </span>
                )}
                {running && (
                  <Button size="large" className="!rounded-xl" onClick={stop}>停止等待</Button>
                )}
                {runningJobs.length > 1 && (
                  <span className="rounded-full bg-accent-soft px-2.5 py-1 text-[12px] text-accent">
                    同时 {runningJobs.length} 个任务进行中
                  </span>
                )}
                {estimate.runs > 1 && (
                  <span className="rounded-full bg-accent-soft px-2.5 py-1 text-[12px] text-accent">
                    将生成 {estimate.runs} 个结果
                  </span>
                )}
                {(exact ? exact.points > 0 || exact.beans > 0 : estimate.points > 0 || estimate.beans > 0) && (
                  <Tooltip title={exact ? '与真实扣费一致（已含免费额度抵扣）' : '按所选模型预估，正在校准…'}>
                    <span className="flex items-center gap-1 text-[12px] text-black/45">
                      <RobotOutlined />
                      {(() => {
                        const pts = exact ? exact.points : estimate.points
                        const bns = exact ? exact.beans : estimate.beans
                        return (
                          <>
                            {pts > 0 && <span>{exact ? '' : '约 '}{pts} 积分</span>}
                            {pts > 0 && bns > 0 && <span> +</span>}
                            {bns > 0 && <span>{exact ? '' : '约 '}{bns} 豆</span>}
                          </>
                        )
                      })()}
                    </span>
                  </Tooltip>
                )}
              </div>
              {running && (
                <div className="mt-3">
                  <div className="mb-1.5 flex items-center gap-2 text-[12px] text-black/55">
                    <AnimatedLogo size={20} />
                    <span className="truncate">{progressMsg || '生成中…'}</span>
                    {progressPct > 0 && <span className="ml-auto shrink-0 text-black/35">{progressPct}%</span>}
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-black/5">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${Math.max(progressPct, 6)}%`, background: 'linear-gradient(90deg, var(--accent) 0%, var(--accent-2) 100%)' }}
                    />
                  </div>
                </div>
              )}
              {missingLabels.length > 0 && !running && (
                <div className="mt-2.5 max-lg:pl-24 text-[12px] text-black/45">
                  还差：<span className="text-accent">{missingLabels.join('、')}</span>
                </div>
              )}
            </div>
              </>
            )}
          </Card>
          )}

        </div>
      </div>

      {/* 移动端成果抽屉：可展开可收起，点条目进工作台 */}
      {mResultsOpen && (
        <div className="fixed inset-0 z-[999] bg-slate-900/35 backdrop-blur-sm lg:hidden" onClick={() => setMResultsOpen(false)}>
          <div className="absolute inset-x-0 bottom-0 flex max-h-[72vh] flex-col overflow-hidden rounded-t-2xl border-t border-black/8 bg-white shadow-[0_-8px_32px_rgba(2,6,23,0.18)]" onClick={(e) => e.stopPropagation()}>
            <div className="flex shrink-0 items-center justify-between px-4 pt-3">
              <span className="text-[13px] font-medium"><PictureOutlined className="mr-1.5 text-accent" />成果 {results.length > 0 ? `· ${results.length}` : ''}</span>
              <button className="rounded-full p-1.5 text-black/40 hover:bg-black/5" onClick={() => setMResultsOpen(false)} aria-label="收起成果">
                <CloseOutlined className="text-[12px]" />
              </button>
            </div>
            {/* 批量操作：移动端与桌面同一套动作（全选/失效筛选/清理/批量放大下载删除） */}
            {doneResults.length > 0 && (
              <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-black/[0.06] px-4 pb-2">
                <button
                  type="button"
                  onClick={toggleSelectAll}
                  className="rounded-md px-2 py-1 text-[11px] text-black/50 transition hover:bg-black/[0.04] hover:text-accent"
                >
                  {selectedUrls.size === visibleResults.length && visibleResults.length > 0 ? '取消全选' : `全选 ${visibleResults.length}`}
                </button>
                {expiredResults.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setOnlyExpired((v) => !v)}
                    className={`rounded-md px-2 py-1 text-[11px] transition ${
                      onlyExpired ? 'bg-amber-100 text-amber-700' : 'text-amber-600 hover:bg-amber-50'
                    }`}
                  >
                    {onlyExpired ? `显示全部 ${doneResults.length}` : `仅看失效 ${expiredResults.length}`}
                  </button>
                )}
                {expiredResults.length > 0 && (
                  <button
                    type="button"
                    onClick={cleanupExpired}
                    className="rounded-md px-2 py-1 text-[11px] text-red-500 transition hover:bg-red-50"
                  >
                    清理失效 {expiredResults.length}
                  </button>
                )}
                {selectedUrls.size > 0 && (
                  <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent">
                    已选 {selectedUrls.size}
                  </span>
                )}
                <span className="ml-auto">
                  <ResultBatchActions
                    selected={selectedItems}
                    models={models}
                    onDownload={() => void batchDownload()}
                    onDelete={batchDelete}
                    downloading={downloading}
                  />
                </span>
              </div>
            )}
            <div className="aigc-hub-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-5 pt-2">
              {results.length === 0 ? (
                <div className="rounded-xl border border-dashed border-accent-ring/60 bg-accent-soft/40 px-3 py-8 text-center">
                  <InboxOutlined className="mb-2 text-2xl text-accent/30" />
                  <Text type="secondary" className="!text-[12px]">生成的成果会出现在这里</Text>
                </div>
              ) : (
                (onlyExpired ? expiredResults : results).map((r) => (
                  <ResultRow
                    key={r.url || `q-${r.queueId}-${r.queueIndex}`} item={r} active={active?.url === r.url} selected={selectedUrls.has(r.url)}
                    onToggleSelect={() => toggleSelect(r.url)}
                    onClick={() => { setActive({ url: r.url, kind: r.kind, label: r.styleLabel }); setMResultsOpen(false); setMTab('workbench') }}
                    onImgError={() => handleImgError(r)}
                    onImgLoad={() => handleImgLoad(r.url)}
                    onRetry={() => handleImgRetry(r.url)}
                    onZoom={() => {
                      const imgs = doneResults.filter((x) => x.kind === 'image' && x.url)
                      const idx = imgs.findIndex((x) => x.url === r.url)
                      setLightbox({ open: true, urls: imgs.map((x) => toAssetProxyUrl(x.url)), index: Math.max(0, idx) })
                    }}
                    onRespeed={r.gifSource ? () => setSpeedItem(r) : undefined}
                    onRemove={() => removeResults([r.url])}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* 成果区图片放大：hover 缩略图上的「放大」按钮触发（卡片点击仍是「送到工作台」） */}
      <ImageLightbox
        open={lightbox.open}
        urls={lightbox.urls}
        startIndex={lightbox.index}
        onClose={() => setLightbox((b) => ({ ...b, open: false }))}
      />
      {speedItem?.gifSource && (
        <GifSpeedModal
          key={speedItem.url}
          item={speedItem}
          onClose={() => setSpeedItem(null)}
          onReplaced={(newUrl, delayMs, mode) => {
            const oldUrl = speedItem.url
            setResults((prev) => prev.map((it) => (
              it.url === oldUrl
                ? {
                  ...it,
                  url: newUrl,
                  imageState: 'ok',
                  retryCount: 0,
                  createdAt: Date.now(),
                  gifSource: it.gifSource ? { ...it.gifSource, delayMs, mode } : it.gifSource,
                }
                : it
            )))
            if (active?.url === oldUrl) setActive({ ...active, url: newUrl })
            setSpeedItem(null)
          }}
        />
      )}
    </PageContainer>
  )
}

// ===== 单个 Slot 控件 =====
