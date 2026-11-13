// ===== 创作（Create）工作区工具注册表 =====
//
// 这两个工具是「沉浸式 composer」的试点：不进工具箱列表，从导航「创作」进入
// （/create 页内切换）。工具行仍存 tools 表（ToolStudio 要按 slug 拉详情），
// 但 /api/tools 列表按本表排除，避免「工具箱 / 创作」两处重复入口。
//
// composer 渲染器由 tools.tags='composer' 触发（seed 里写入）；
// 没标记的工具一律走经典右侧面板，互不影响。

export interface CreateToolEntry {
  slug: string
  label: string
  /** /create 页内的路由锚（/create/image、/create/video） */
  href: string
  description: string
}

export const CREATE_TOOLS: CreateToolEntry[] = [
  {
    slug: 'video-creation',
    label: '视频生成',
    href: '/create/video',
    description: '文生 / 首尾帧 / 全能参考三种方式，一句话生成短视频',
  },
  {
    slug: 'image-creation',
    label: '图像生成',
    href: '/create/image',
    description: '描述生成图片；带参考图自动进入图生图',
  },
]

export function findCreateToolBySlug(slug: string): CreateToolEntry | undefined {
  return CREATE_TOOLS.find((t) => t.slug === slug)
}

/** /api/tools 列表排除创作区工具（避免与工具箱重复入口） */
export const CREATE_TOOL_SLUGS = CREATE_TOOLS.map((t) => t.slug)
