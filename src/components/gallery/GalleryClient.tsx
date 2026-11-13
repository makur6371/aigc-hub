'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Typography, App, Segmented, Modal, Button, Tooltip } from 'antd'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageState } from '@/components/ui/PageState'
import { MediaActionsBar } from '@/components/ui/MediaActionsBar'
import { BrandTag } from '@/components/ui/BrandTag'
import { CopyOutlined, CheckOutlined, PlusOutlined, EyeOutlined, LikeOutlined, AppstoreOutlined, SearchOutlined, ClearOutlined, LoadingOutlined, MessageOutlined, PictureOutlined, UploadOutlined, ScissorOutlined, VideoCameraOutlined, FontSizeOutlined, NumberOutlined, MergeCellsOutlined, FileTextOutlined, PartitionOutlined, ForkOutlined, CalculatorOutlined, SelectOutlined, ReadOutlined, ArrowRightOutlined } from '@ant-design/icons'
import { useRouter } from 'next/navigation'
import dayjs from 'dayjs'
import { useAuthStore } from '@/stores/useAuthStore'
import { StarFilled, StarOutlined } from '@ant-design/icons'
import { apiFetch } from '@/lib/api-client'
import { BASE_TOOL_CATEGORIES, VERTICAL_CATEGORIES, DEFAULT_IMAGE_TOOL_SLUG } from '@/lib/constants/categories'
import { FirstUseGuide, GUIDE_STEPS } from '@/components/ui/FirstUseGuide'
import { writeLocalJson } from '@/lib/local-store'

const { Title, Text } = Typography

type WorkflowSummary = {
  nodeCount: number
  nodeTypes: string[]
  modelChain: string[]
}

type WorkItem = {
  id: string
  slug: string
  title: string
  description: string
  type: string
  category?: string | null
  coverUrl: string | null
  images?: string[] | null
  // 详情弹窗「导入到画布」用：列表接口随卡片返回工作流快照（nodes JSON）
  nodes?: unknown
  connections?: unknown
  likeCount: number
  viewCount: number
  authorName: string
  createdAt: string
  featured?: boolean
  workflowSummary?: WorkflowSummary
  // 自定义套图排版（发布弹窗排版编辑器生成）；无则走默认 WorkImagesCollage
  coverLayout?: { ratio?: string; cells?: { url: string; x: number; y: number; w: number; h: number }[] } | null
}

type WorksListPayload = {
  items: WorkItem[]
  total: number
  semantic?: boolean
}

const PAGE_SIZE = 12

// 推荐搜索词：给用户检索方向（语义搜索会理解意图，不必逐字匹配）
const SEARCH_SUGGESTIONS = ['科技感海报', '温馨插画', '电商产品图', '赛博朋克', '国风水墨', '3D 角色']

/**
 * 作品分类筛选开关。
 *
 * 为什么默认关：生产库 958 条作品的 category 全为 NULL，按分类过滤必然 0 条 ——
 * 点一下作品就全空、取消又恢复，是误导性的死交互。
 * 等作品补齐分类（或后台支持编辑）后改为 true 即可恢复，代码无需重写。
 */
const CATEGORY_FILTER_ENABLED = false

export default function GalleryClient() {
  const { message } = App.useApp()
  const router = useRouter()
  const { user } = useAuthStore()
  const isAdminRole = user?.role === 'ADMIN'
  const [featToggling, setFeatToggling] = useState<string | null>(null)
  const [items, setItems] = useState<WorkItem[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [sort, setSort] = useState<'new' | 'hot'>('new')
  const [modalWork, setModalWork] = useState<WorkItem | null>(null)
  const [copied, setCopied] = useState(false)

  // 管理员：直接在作品广场切换首页精选
  const handleToggleFeatured = async (w: WorkItem) => {
    setFeatToggling(w.id)
    const next = !w.featured
    // 乐观更新
    setItems((prev) => prev.map((it) => (it.id === w.id ? { ...it, featured: next } : it)))
    try {
      const res = await apiFetch(`/api/admin/works/${w.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ featured: next }),
      })
      if (res.success) {
        message.success(res.message)
      } else {
        setItems((prev) => prev.map((it) => (it.id === w.id ? { ...it, featured: !next } : it)))
        message.error(res.message || '操作失败')
      }
    } catch {
      setItems((prev) => prev.map((it) => (it.id === w.id ? { ...it, featured: !next } : it)))
      message.error('操作失败')
    } finally {
      setFeatToggling(null)
    }
  }
  const [saving, setSaving] = useState(false)
  const [forking, setForking] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [lastSearch, setLastSearch] = useState<{ q: string; count: number; semantic: boolean } | null>(null)

  const fetchWorks = useCallback(
    async (p: number, type: string, cat: string, sortKey: 'new' | 'hot' = 'new', keyword = '', searchMode = false, append = false) => {
      setLoading(true)
      if (searchMode) setSearching(true)
      try {
        const res = await apiFetch<WorksListPayload>('/api/works', {
          params: {
            page: String(p),
            pageSize: String(PAGE_SIZE),
            sort: sortKey,
            type: type !== 'all' ? type : undefined,
            category: cat !== 'all' ? cat : undefined,
            q: keyword.trim() || undefined,
          },
        })
        if (res.success && res.data) {
          const newItems: WorkItem[] = res.data.items
          setItems((prev) => (append ? [...prev, ...newItems] : newItems))
          setTotal(res.data.total)
          setHasMore(newItems.length === PAGE_SIZE)
          if (searchMode) setLastSearch({ q: keyword, count: res.data.total ?? 0, semantic: !!res.data.semantic })
        } else {
          message.error(res.message || '加载失败')
        }
      } catch {
        message.error('网络错误')
      } finally {
        setLoading(false)
        if (searchMode) setSearching(false)
      }
    },
    [message]
  )

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1)
      fetchWorks(1, typeFilter, categoryFilter, sort, searchQuery.trim())
    }, 0)
    return () => window.clearTimeout(timer)
  }, [fetchWorks, typeFilter, categoryFilter, sort])

  // ===== 图片预加载：新一批数据到位后立即预热 <img>（new Image()），点击「加载更多」直接显示 =====
  useEffect(() => {
    const urls = new Set<string>()
    items.forEach((w) => {
      if (w.coverUrl) urls.add(w.coverUrl)
      if (Array.isArray(w.images)) w.images.forEach((u) => { if (u) urls.add(u) })
    })
    urls.forEach((u) => {
      const img = new Image()
      img.src = u
    })
  }, [items])

  // 「加载更多」按钮：fetch 前先把下一页当纯 JSON 预取进内存缓存,点击后 fetch 命中缓存秒回
  const prefetchPage = useCallback((p: number, type: string, cat: string, sortKey: 'new' | 'hot', keyword: string) => {
    const params = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE), sort: sortKey })
    if (type !== 'all') params.set('type', type)
    if (cat !== 'all') params.set('category', cat)
    if (keyword.trim()) params.set('q', keyword.trim())
    fetch(`/api/works?${params.toString()}`, { credentials: 'same-origin' }).catch(() => {})
    // JSON 已进浏览器 HTTP 缓存；正式 fetch 命中后秒级返回
  }, [])

  // ===== 下一页预取：当前页加载完成后 ~2s 自动预取下一页 JSON + 图片 =====
  useEffect(() => {
    if (!hasMore || searching || loading) return
    const t = setTimeout(() => {
      prefetchPage(page + 1, typeFilter, categoryFilter, sort, lastSearch?.q ?? searchQuery)
    }, 2000)
    return () => clearTimeout(t)
  }, [hasMore, searching, loading, page, typeFilter, categoryFilter, sort, lastSearch, searchQuery, prefetchPage])

  // ===== 手动「加载更多」（用户要求的确定性加载） =====
  const loadMore = useCallback(() => {
    if (loading || !hasMore || searching) return
    const next = page + 1
    setPage(next)
    fetchWorks(next, typeFilter, categoryFilter, sort, lastSearch?.q ?? '', false, true)
  }, [loading, hasMore, searching, page, fetchWorks, typeFilter, categoryFilter, sort, lastSearch])

  // 批量预加载：触底前 ~1.5 屏也自动拉（保留原无限滚动作为兜底，手动按钮为主入口）
  const loadMoreRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = loadMoreRef.current
    if (!el || !('IntersectionObserver' in window)) return
    const io = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting || loading || !hasMore || searching) return
      const next = page + 1
      setPage(next)
      fetchWorks(next, typeFilter, categoryFilter, sort, lastSearch?.q ?? '', false, true)
    }, { rootMargin: '1600px' })
    io.observe(el)
    return () => io.disconnect()
  }, [fetchWorks, loading, hasMore, page, typeFilter, sort, searching, lastSearch])

  return (
    <div className="mx-auto w-full max-w-[1600px]">
      {/* 首次进入作品广场：引导「逛 / 筛 / 复用」三步（只弹一次）。
          enabled 跟全站其它场景（首页/工具箱/Agent）一致：未登录不弹 ——
          引导最后一步指向「导入到画布 / 复制」，那是登录后才成立的路径。 */}
      <FirstUseGuide storageKey="gallery" steps={[...GUIDE_STEPS.gallery]} enabled={!!user} />
      <div className="space-y-5">
        {/* 标题由服务端壳（(public)/gallery/page.tsx 的 h1）承担，此处只放筛选控件 */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <Segmented
            data-guide="gallery-type"
            value={typeFilter}
            onChange={(v) => setTypeFilter(String(v))}
            options={[
              { label: '全部', value: 'all' },
              { label: '工作流', value: 'workflow' },
              { label: '图片', value: 'image' },
              { label: '视频', value: 'video' },
            ]}
          />
        </div>

        {/* 分类筛选：基础工具 / 垂直领域 两组 chips（与工具箱同一分类体系）
            ⚠️ 暂隐藏：生产库 958 条作品的 category 全为 NULL，按分类过滤必然 0 条
            （点一下作品就全空，是误导性死交互）。等作品补上分类后改 CATEGORY_FILTER_ENABLED 恢复。 */}
        {CATEGORY_FILTER_ENABLED && (
        <div className="space-y-2">
          {[
            { label: '基础', cats: BASE_TOOL_CATEGORIES as unknown as string[] },
            { label: '垂直', cats: VERTICAL_CATEGORIES as unknown as string[] },
          ].map((g) => (
            <div key={g.label} className="flex flex-wrap items-center gap-2">
              <span className="mr-1 shrink-0 text-[11px] font-medium tracking-wide text-black/35">{g.label}</span>
              {g.cats.map((c) => {
                const on = categoryFilter === c
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategoryFilter(on ? 'all' : c)}
                    className={`cursor-pointer rounded-full px-3 py-1 text-[12.5px] transition-all ${
                      on
                        ? 'bg-gradient-to-r from-accent to-accent-2 text-white shadow-[0_2px_10px_rgba(125,80,224,0.3)]'
                        : 'border border-black/8 bg-white/70 text-black/60 hover:border-accent-ring hover:text-accent'
                    }`}
                  >
                    {c}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        )}

        {/* 语义搜索区：居中大搜索框 + 右侧排序；下方推荐搜索词一键填入 */}
        <div className="flex flex-col items-center gap-2.5">
          <div className="flex w-full items-center gap-3">
            <div data-guide="gallery-search" className="flex flex-1 items-center gap-2 rounded-full border border-border bg-white px-4 py-2.5 shadow-sm focus-within:border-accent/50 transition-colors">
              <SearchOutlined className="text-text-muted" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { setPage(1); fetchWorks(1, typeFilter, categoryFilter, sort, searchQuery.trim(), true) } }}
                placeholder="描述你想要的作品，如「科技感海报」「温馨插画」…"
                className="flex-1 bg-transparent outline-none text-sm"
              />
              {searchQuery.trim() && (
                <Button
                  type="text"
                  size="small"
                  icon={<ClearOutlined />}
                  onClick={() => { setSearchQuery(''); setLastSearch(null); fetchWorks(1, typeFilter, categoryFilter, sort, '') }}
                />
              )}
              <Button type="primary" size="small" shape="round" loading={searching} onClick={() => { setPage(1); fetchWorks(1, typeFilter, categoryFilter, sort, searchQuery.trim(), true) }}>
                搜索
              </Button>
            </div>
            <Segmented
              value={sort}
              onChange={(v) => setSort(v as 'new' | 'hot')}
              options={[
                { label: '最新', value: 'new' },
                { label: '热门', value: 'hot' },
              ]}
            />
          </div>
          {/* 推荐搜索词（点击直接检索） */}
          <div className="flex flex-wrap justify-center gap-1.5">
            {SEARCH_SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => { setSearchQuery(s); setPage(1); fetchWorks(1, typeFilter, categoryFilter, sort, s, true) }}
                className="rounded-full border border-border/70 bg-white/60 px-2.5 py-0.5 text-[11px] text-text-secondary hover:border-accent/40 hover:text-accent transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* 检索状态：语义检索动画 + 结果反馈 */}
        {searching && (
          <div className="flex items-center gap-3 rounded-xl border border-accent/20 bg-accent-light/40 px-4 py-3">
            <LoadingOutlined spin className="text-accent text-lg" />
            <span className="text-sm text-accent">正在语义检索作品…</span>
            <span className="flex gap-1 ml-1">
              <span className="copilot-thinking-dot h-1 w-1 rounded-full bg-accent" />
              <span className="copilot-thinking-dot h-1 w-1 rounded-full bg-accent" style={{ animationDelay: '0.15s' }} />
              <span className="copilot-thinking-dot h-1 w-1 rounded-full bg-accent" style={{ animationDelay: '0.3s' }} />
            </span>
          </div>
        )}
        {!searching && lastSearch && lastSearch.q && (
          <div className="flex items-center justify-between rounded-xl border border-border bg-white px-4 py-2.5">
            <span className="text-sm text-text-secondary">
              「<Text strong className="text-accent">{lastSearch.q}</Text>」 检索到 <Text strong>{lastSearch.count}</Text> 个相似作品
              {lastSearch.semantic && <span className="ml-2 rounded-full bg-accent-light px-2 py-0.5 text-xs text-accent">语义检索</span>}
            </span>
            <Button type="link" size="small" onClick={() => { setLastSearch(null); setSearchQuery(''); fetchWorks(1, typeFilter, categoryFilter, sort, '') }}>
              清除
            </Button>
          </div>
        )}

        {loading && items.length === 0 ? (
          <PageState status="loading" description="加载作品..." minHeight="280px" />
        ) : items.length === 0 ? (
          <PageState status="empty" description="作品正在整理中，上架后会在这里展示" minHeight="280px" />
        ) : (
          <>
            <div className="columns-2 gap-4 md:columns-3 xl:columns-4 [column-fill:balance]">
              {items.map((w) => (
                <div
                  key={w.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setModalWork(w)}
                  onKeyDown={(e) => { if (e.key === 'Enter') setModalWork(w) }}
                  className="group mb-4 w-full break-inside-avoid cursor-pointer overflow-hidden rounded-2xl bg-white text-left shadow-sm transition-all hover:shadow-md"
                >
                  <div className="relative w-full bg-gradient-to-br from-accent-light to-primary-light overflow-hidden">
                    {w.coverLayout?.cells?.length ? (
                      // 自定义排版：发布时用户手动框选的图片大小/排列 + 外框比例，优先于默认套图布局
                      <WorkCoverLayout layout={w.coverLayout} />
                    ) : w.coverUrl && w.images && w.images.length > 1 ? (
                      // 套图排版：封面大图占左上 2/3 高，其余小图靠右一列 + 底下一行（最多 5 张）
                      <WorkImagesCollage coverUrl={w.coverUrl} images={w.images} />
                    ) : w.coverUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={w.coverUrl}
                        alt={w.title}
                        loading="lazy"
                        className="w-full h-auto object-contain transition-transform duration-300 group-hover:scale-[1.015]"
                      />
                    ) : w.type === 'workflow' && w.workflowSummary ? (
                      // 工作流无封面：渲染节点流水线预览（图标胶囊链），替代默认图标
                      <WorkflowPipelinePreview nodeTypes={w.workflowSummary.nodeTypes} />
                    ) : (
                      <div className="aspect-[4/3] flex items-center justify-center">
                        <AppstoreOutlined className="text-4xl text-accent/40" />
                      </div>
                    )}
                    <BrandTag className="absolute top-2 left-2 m-0">{w.type === 'workflow' ? '工作流' : w.type === 'image' ? '图片' : '视频'}</BrandTag>
                    {/* 管理员：首页精选开关（右上角星标） */}
                    {isAdminRole && (
                      <Tooltip title={w.featured ? '取消首页精选' : '设为首页精选'}>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleToggleFeatured(w) }}
                          className={`absolute top-2 right-2 grid size-8 place-items-center rounded-full backdrop-blur transition-all ${
                            w.featured ? 'bg-warning-amber text-white shadow' : 'bg-white/70 text-text-muted hover:text-warning-amber'
                          }`}
                        >
                          {featToggling === w.id ? <LoadingOutlined /> : w.featured ? <StarFilled /> : <StarOutlined />}
                        </button>
                      </Tooltip>
                    )}
                    {!isAdminRole && w.featured && (
                      <span className="absolute top-2 right-2 grid size-8 place-items-center rounded-full bg-warning-amber text-white shadow">
                        <StarFilled />
                      </span>
                    )}
                    {w.coverUrl && (
                      <div
                        className="absolute right-2 bottom-2 z-10 rounded-lg bg-white/85 p-0.5 opacity-0 shadow-sm backdrop-blur transition group-hover:opacity-100 max-lg:opacity-100"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MediaActionsBar compact url={w.coverUrl} kind="image" name={w.title} />
                      </div>
                    )}
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                  </div>
                  <div className="p-3 space-y-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-light text-accent text-[10px] font-medium">
                        {w.authorName?.charAt(0)?.toUpperCase() || 'U'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-foreground truncate">{w.title}</span>
                        <span className="block text-xs text-text-muted truncate">
                          {w.authorName} · {dayjs(w.createdAt).format('MM-DD')}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 pt-0.5">
                      <span className="text-xs text-text-muted"><EyeOutlined className="mr-1" />{w.viewCount}</span>
                      <span className="text-xs text-text-muted"><LikeOutlined className="mr-1" />{w.likeCount}</span>
                    </div>
                    {w.type === 'workflow' && w.workflowSummary && (
                      <div className="flex flex-wrap items-center gap-1.5 pt-1">
                        <span className="rounded bg-accent-light px-1.5 py-0.5 text-[10px] font-medium text-accent">
                          {w.workflowSummary.nodeCount} 步
                        </span>
                        {w.workflowSummary.modelChain.slice(0, 2).map((m, i) => (
                          <span key={i} className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-text-secondary">
                            {m}
                          </span>
                        ))}
                        {w.workflowSummary.modelChain.length > 2 && (
                          <span className="text-[10px] text-text-disabled">+{w.workflowSummary.modelChain.length - 2}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* 加载更多：主入口按钮（下一批已预取，点击秒出）；滚动触底兜底自动加载保留 */}
            <div ref={loadMoreRef} className="flex flex-col items-center gap-2 py-6">
              {hasMore && items.length > 0 && (
                <Button type="default" shape="round" loading={loading} onClick={loadMore} className="min-w-[160px]">
                  加载更多
                </Button>
              )}
              {loading && items.length > 0 && (
                <span className="text-xs text-text-muted">正在加载下一批…</span>
              )}
              {!hasMore && items.length > 0 && (
                <span className="text-xs text-text-disabled">已加载全部 {total} 个作品</span>
              )}
            </div>
          </>
        )}
      </div>

      {/* 作品详情弹窗：大图 + 提示词 + 复制/收藏 */}
      <Modal
        open={!!modalWork}
        onCancel={() => { setModalWork(null); setCopied(false); }}
        footer={null}
        width={720}
        centered
        destroyOnHidden
      >
        {modalWork && (
          <div className="flex flex-col md:flex-row gap-6">
            <div className="md:w-1/2 shrink-0">
              {modalWork.coverUrl && (
                <div className="space-y-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={modalWork.coverUrl} alt={modalWork.title} className="w-full rounded-xl object-cover" />
                  <MediaActionsBar
                    url={modalWork.coverUrl}
                    kind="image"
                    name={modalWork.title}
                    onClose={() => { setModalWork(null); setCopied(false) }}
                  />
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <Text strong className="text-lg block mb-1">{modalWork.title}</Text>
              <BrandTag className="mb-3">{modalWork.type === 'image' ? '图片' : modalWork.type === 'workflow' ? '工作流' : '视频'}</BrandTag>

              <Text className="block text-sm text-text-secondary whitespace-pre-wrap mb-4 max-h-[360px] overflow-y-auto">
                {modalWork.description || '暂无描述'}
              </Text>

              <div className="flex flex-wrap gap-3">
                {modalWork.type !== 'workflow' && (modalWork.description || '').trim() && (
                  <Button
                    type="primary"
                    icon={<ArrowRightOutlined />}
                    onClick={() => {
                      // 对标 Liblib「做同款」：图片/视频作品直接带着描述跳文生图工具，一键复刻
                      router.push(`/tools/${DEFAULT_IMAGE_TOOL_SLUG}?prompt=${encodeURIComponent(modalWork.description!)}`)
                    }}
                  >
                    做同款
                  </Button>
                )}
                {modalWork.type === 'workflow' && Boolean(modalWork.nodes && modalWork.connections) && (
                  <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    onClick={() => {
                      // 复用作品详情页同款导入路径：localStorage → /canvas 消费
                      try {
                        writeLocalJson('pendingWorkflowImport', {
                          name: modalWork.title,
                          nodes: modalWork.nodes,
                          connections: modalWork.connections,
                        })
                        router.push('/canvas')
                      } catch { message.error('导入失败') }
                    }}
                  >
                    导入到画布
                  </Button>
                )}
                {modalWork.type === 'workflow' && Boolean(modalWork.nodes && modalWork.connections) && (
                  <Button
                    icon={<ForkOutlined />}
                    loading={forking}
                    onClick={async () => {
                      // 把作品的工作流快照 fork 成自己的工具（tools.forkedFrom 溯源到作品）
                      setForking(true)
                      try {
                        const res = await apiFetch('/api/tools', {
                          method: 'POST',
                          body: JSON.stringify({
                            name: `${modalWork.title} 同款`,
                            description: modalWork.description || '',
                            coverUrl: modalWork.coverUrl,
                            workflow: { nodes: modalWork.nodes, connections: modalWork.connections },
                            forkedFrom: `work:${modalWork.slug}`,
                          }),
                        })
                        if (res.success) message.success(res.message || '已创建工具，等待审核')
                        else message.error(res.message || '创建失败')
                      } catch {
                        message.error('创建失败')
                      } finally {
                        setForking(false)
                      }
                    }}
                  >
                    存为我的工具
                  </Button>
                )}
                <Button
                  type="primary"
                  icon={copied ? <CheckOutlined /> : <CopyOutlined />}
                  onClick={() => {
                    navigator.clipboard.writeText(modalWork.description || '')
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  }}
                >
                  {copied ? '已复制' : '复制提示词'}
                </Button>

                <Button
                  icon={<PlusOutlined />}
                  loading={saving}
                  onClick={async () => {
                    setSaving(true)
                    try {
                      const res = await apiFetch('/api/prompts', {
                        method: 'POST',
                        body: JSON.stringify({
                          title: modalWork.title,
                          content: modalWork.description || '',
                          coverUrl: modalWork.coverUrl,
                          category: '通用',
                          isPublic: false,
                        }),
                      })
                      if (res.success) message.success('已添加到我的提示词库')
                      else message.error(res.message || '添加失败')
                    } catch { message.error('添加失败') }
                    finally { setSaving(false) }
                  }}
                >
                  添加到提示词库
                </Button>

              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

// ===== 工作流节点流水线预览 =====
// 为无封面图的工作流作品在卡片封面区渲染一条节点链：每个节点一个图标胶囊 + 连线，
// 直观呈现工作流的执行顺序与用到的节点类型；超出宽度折叠为 +N。
type NodeKind = { icon: React.ReactNode; label: string; tone: string }

// 内置节点类型 → 图标/标签/配色
const NODE_STYLE: Record<string, NodeKind> = {
  'llm-chat': { icon: <MessageOutlined />, label: 'LLM', tone: 'bg-accent/10 text-accent' },
  'image-generate': { icon: <PictureOutlined />, label: '生图', tone: 'bg-violet-100 text-violet-600' },
  'image-upload': { icon: <UploadOutlined />, label: '传图', tone: 'bg-sky-100 text-sky-600' },
  'image-upload-batch': { icon: <UploadOutlined />, label: '批量传图', tone: 'bg-sky-100 text-sky-600' },
  'image-preview': { icon: <EyeOutlined />, label: '看图', tone: 'bg-emerald-100 text-emerald-600' },
  'image-crop': { icon: <ScissorOutlined />, label: '裁切', tone: 'bg-teal-100 text-teal-600' },
  'video-generate': { icon: <VideoCameraOutlined />, label: '视频', tone: 'bg-rose-100 text-rose-500' },
  'video-preview': { icon: <VideoCameraOutlined />, label: '播视频', tone: 'bg-rose-100 text-rose-500' },
  'text-input': { icon: <FontSizeOutlined />, label: '文本', tone: 'bg-gray-200 text-gray-600' },
  'number-input': { icon: <NumberOutlined />, label: '数值', tone: 'bg-gray-200 text-gray-600' },
  'text-concat': { icon: <MergeCellsOutlined />, label: '拼接', tone: 'bg-amber-100 text-amber-600' },
  'json-parser': { icon: <FileTextOutlined />, label: 'JSON', tone: 'bg-orange-100 text-orange-600' },
  'json-prompt-batch': { icon: <PartitionOutlined />, label: '批量提示词', tone: 'bg-orange-100 text-orange-600' },
  'condition-check': { icon: <ForkOutlined />, label: '判断', tone: 'bg-indigo-100 text-indigo-600' },
  'number-calc': { icon: <CalculatorOutlined />, label: '计算', tone: 'bg-gray-200 text-gray-600' },
  'field-extractor': { icon: <SelectOutlined />, label: '提取', tone: 'bg-orange-100 text-orange-600' },
  'text-preview': { icon: <ReadOutlined />, label: '预览', tone: 'bg-emerald-100 text-emerald-600' },
}

function resolveNode(nodeType: string | undefined): NodeKind {
  if (nodeType && NODE_STYLE[nodeType]) return NODE_STYLE[nodeType]
  return { icon: <AppstoreOutlined />, label: '节点', tone: 'bg-gray-200 text-gray-600' }
}

const MAX_VISIBLE = 5

// 套图排版：一大图为中心（左上占 2/3），其余小图右侧一列 + 底下一行（最多 5 张，超出 +N）
// 所有格子固定 aspect-ratio，图片 object-cover —— 加载完成不会撑动瀑布流布局
// 自定义套图排版渲染：ratio=外框比例（如 4/3），cells=每张图的归一化框选（0~1）
function WorkCoverLayout({ layout }: { layout: NonNullable<WorkItem['coverLayout']> }) {
  const ratio = typeof layout.ratio === 'string' && /^\d+\/\d+$/.test(layout.ratio) ? layout.ratio : '4/3'
  const cells = (layout.cells ?? []).filter((c) => c && typeof c.url === 'string')
  if (cells.length === 0) return null
  return (
    <div className="relative w-full" style={{ aspectRatio: ratio.replace('/', ' / ') }}>
      {cells.map((c, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={i}
          src={c.url}
          alt=""
          loading="lazy"
          className="absolute object-cover"
          style={{
            left: `${(c.x * 100).toFixed(2)}%`,
            top: `${(c.y * 100).toFixed(2)}%`,
            width: `${(c.w * 100).toFixed(2)}%`,
            height: `${(c.h * 100).toFixed(2)}%`,
          }}
        />
      ))}
    </div>
  )
}

function WorkImagesCollage({ coverUrl, images }: { coverUrl: string; images: string[] }) {
  const rest = images.filter((u) => u !== coverUrl).slice(0, 4)
  const others = rest.slice(0, 2) // 右侧一列
  const bottom = rest.slice(2, 4) // 底下一行
  const overflow = images.length - 5
  const frame = 'relative overflow-hidden bg-accent-light'
  const img = 'h-full w-full object-cover'
  return (
    <div className="grid w-full grid-cols-3 grid-rows-[2fr_1fr] gap-0.5">
      {/* 大图：占左上 2 列 */}
      <div className={`${frame} col-span-2 row-span-1 aspect-[4/3]`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={coverUrl} alt="" loading="lazy" className={img} />
      </div>
      {/* 右侧小图列 */}
      {others.map((u, i) => (
        <div key={i} className={frame}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={u} alt="" loading="lazy" className={img} />
        </div>
      ))}
      {others.length === 0 && <div className={frame} />}
      {/* 底行小图（大图下方，跨 2 列） */}
      {bottom.map((u, i) => (
        <div key={i} className={`${frame} ${i === 0 ? 'col-span-2' : ''} aspect-[4/3]`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={u} alt="" loading="lazy" className={img} />
        </div>
      ))}
      {overflow > 0 && (
        <div className="absolute bottom-2 right-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur">
          +{overflow}
        </div>
      )}
    </div>
  )
}

function WorkflowPipelinePreview({ nodeTypes }: { nodeTypes?: string[] }) {
  const nodes = (nodeTypes ?? []).filter(Boolean)
  if (nodes.length === 0) {
    return (
      <div className="flex aspect-[4/3] items-center justify-center">
        <AppstoreOutlined className="text-4xl text-accent/40" />
      </div>
    )
  }
  const shown = nodes.slice(0, MAX_VISIBLE)
  const overflow = nodes.length - shown.length

  return (
    <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-3 px-4">
      <div className="flex items-center justify-center gap-1.5 flex-wrap">
        {shown.map((t, i) => {
          const kind = resolveNode(t)
          return (
            <div key={i} className="flex items-center gap-1.5">
              <div className={`grid size-9 place-items-center rounded-xl shadow-sm ring-1 ring-black/5 ${kind.tone}`}>
                {kind.icon}
              </div>
              {i < shown.length - 1 && <ArrowRightOutlined className="text-[10px] text-text-disabled" />}
            </div>
          )
        })}
        {overflow > 0 && (
          <span className="rounded-full bg-white/80 px-2 py-0.5 text-[11px] text-text-muted shadow-sm ring-1 ring-black/5">
            +{overflow}
          </span>
        )}
      </div>
      {nodes.includes('llm-chat') || nodes.includes('image-generate') || nodes.includes('video-generate') ? (
        <span className="rounded-full bg-black/25 px-2.5 py-0.5 text-[11px] font-medium text-white/90 backdrop-blur">
          {nodes.length} 步流程
        </span>
      ) : (
        <span className="rounded-full bg-black/25 px-2.5 py-0.5 text-[11px] font-medium text-white/90 backdrop-blur">
          {nodes.length} 节点
        </span>
      )}
    </div>
  )
}
