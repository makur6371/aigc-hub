// ===== 分类体系统一常量 =====
// 工具/作品/提示词三实体复用，前端所有硬编码分类统一引用这里

/** 基础工具类（单能力工具：文生图/图生图/视频/音频等） */
export const BASE_TOOL_CATEGORIES = [
  '文生图',
  '图生图',
  '图片编辑',
  // 视频类合并成一个分类（2026-10-18，用户决策：「那几个生视频的都归到基础工具的视频生成里」）。
  //
  // 为什么合并：原来按输入形态分了 4 类（文生/图生/首尾帧/多图参考），
  // 但对用户选工具时没有决策价值 —— 他关心的是「我要生视频」，
  // 而不是「我这次恰好能用哪种输入形态」。而工具页的切换下拉只有 10 个位置，
  // 四个近义分类会把「基础」组撑成两倍长，反而更难找。
  //
  // 输入形态的差异已经由**模型的 constraints** 表达（首尾帧要 first_frame/last_frame、
  // 动作迁移要 requireVideo 等），分类层不该重复承载这个信息。
  '视频生成',
  '音频生成',
  '音乐生成',
  '语音识别',
  '文字识别',
] as const

/**
 * 视频工具的历史分类别名（已并入「视频生成」）。
 *
 * 用途：后台编辑工具时若读到旧分类值，自动归一到新分类，避免
 * 「同一个能力散在 4 个分类下」的历史数据继续存在。
 * 不要把它加回 ALL_TOOL_CATEGORIES —— 那会让下拉重新长回 4 项。
 */
export const LEGACY_VIDEO_CATEGORIES = [
  '文生视频',
  '图生视频',
  '首尾帧生成视频',
  '多图参考生成视频',
] as const

/** 把任意分类值归一到当前合法分类（历史别名 → 现分类） */
export function normalizeToolCategory(category?: string | null): string {
  const c = (category ?? '').trim()
  if (!c) return ''
  if ((LEGACY_VIDEO_CATEGORIES as readonly string[]).includes(c)) return '视频生成'
  return c
}

/** 垂直领域类（场景化工具：电商/海报/自媒体/品牌等） */
export const VERTICAL_CATEGORIES = [
  '电商商拍',
  '海报设计',
  '自媒体创作',
  '品牌设计',
  '服饰穿戴',
  '角色设计',
  '建筑设计',
  '产品渲染',
  'AI 漫剧',
  '通用工具',
] as const

/** 工具分类全集（基础 + 垂直） */
export const ALL_TOOL_CATEGORIES = [
  ...BASE_TOOL_CATEGORIES,
  ...VERTICAL_CATEGORIES,
] as const

/** 提示词分类（创意库已有分类，保持独立枚举） */
export const PROMPT_CATEGORIES = [
  '海报设计',
  '人像摄影',
  'UI与社交媒体',
  '对比评测',
  '广告创意',
  '电商商品',
  '角色设计',
  '通用',
  '功能模板',
] as const

/** 作品分类（复用工具分类） */
export const WORK_CATEGORIES = ALL_TOOL_CATEGORIES

/** 工具分类类型 */
export type ToolCategory = typeof ALL_TOOL_CATEGORIES[number]

/** 提示词分类类型 */
export type PromptCategory = typeof PROMPT_CATEGORIES[number]

/** 作品分类类型 */
export type WorkCategory = typeof WORK_CATEGORIES[number]

// ===== 工具箱默认落点 =====
//
// 「点导航『工具箱』该进哪个工具」—— 这是**产品默认值**，不是数据事实。
// 之前的实现是 `orderBy: { createdAt: 'desc' }` 取第一条，结果随着新工具上架
// 不断变化（上架「俄区智能套图」后，默认就变成了一个垂直领域的复杂工具，
// 新用户点进来一脸懵）。
//
// 所以固定成一个基础工具：**图生图**（上传参考图直接出图），
// 是最直观、门槛最低的「第一件事」。
//
// ⚠️ 这个 slug 必须与库里真实存在的工具一致；若该工具被下架，
// 调用方会回落到「创建时间最新的已上架工具」，不会死链。
// 2026-11-09：图生图旧工具已下架（并入创作区图像生成），
// 默认落点改为「数字人对口型」——仍在架、基础、无前置素材即可用。
// 历史坑：默认 slug 失效时 /tools 入口会回落「创建时间最新」，
// 撞上 composer 试点工具（视频生成）→ 打开工具箱默认进了视频生成。

/** 首页「生图」入口的默认落点（文生图） */
// 首页创作入口已改为直达 /create（创作工作区），旧文生图工具已下架并入创作区。
// 该常量仅供作品广场「复用提示词」兜底使用，指向合并后的图像生成工具。
export const DEFAULT_IMAGE_TOOL_SLUG = 'image-creation'

// ===== 独立代码工具（路线二）=====
//
// 这类工具**不是** /tools/[slug] 的 slot 表单形态，而是各自独立的页面 + 自己的后端编排路由，
// 因此不在 `tools` 表里（那张表的 workflow/slots 两列对它们没有意义）。
//
// 但它们仍然是**用户可用的一等工具**，必须出现在工具切换下拉里，否则等于没上线
//
// 新增独立工具时：在这里登记一条，下拉会自动多出一个「独立工具」分组。
// 判据（DEV_HANDOFF §4.10）：价值来自某个能力、节点体系拼不出来 → 走这条路。
export interface StandaloneTool {
  /** 与 categories.ts 里那些 slug 一样，直接当路由用 */
  slug: string
  name: string
  /** 一句话说明它做什么（用户不点进去也要能判断要不要用） */
  summary: string
}

/**
 * 当前为空。电商 Agent **不在**这里 —— 它有 tools 表记录，会正常出现在
 * 「垂直领域 → 电商商拍」分组里。
 *
 * 2026-10-18 踩过的坑：我先把它加在这里，后来它又被写进 tools 表，
 * 结果同一个功能在下拉里出现两次（「电商详情图生成」+「电商详情图 Agent」）。
 * 规则：**有 tools 记录的，就不要再登记到这里**。这个数组只留给
 * 「确实不需要 tools 记录、但用户要能点进去」的工具。
 */
export const STANDALONE_TOOLS: StandaloneTool[] = []
