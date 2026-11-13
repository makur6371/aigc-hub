export const ORG = {
  name: 'AIGC Hub',
  alternateName: 'AIGC Hub',
  legacyName: 'AIGC Hub',
  url: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  logo: '/logo.svg',
  tagline: 'AI 创作工作台',
  slogan: '从想法到作品',
  description: '自托管的图像、视频、Agent 与画布创作工作台。',
}
export const FEATURES = [
  { title: '图像与视频', description: '使用管理员配置的模型生成图像和视频。' },
  { title: 'Agent', description: '对话、规划并执行创作任务。' },
  { title: '画布', description: '连接节点，搭建、导入和导出工作流。' },
]
export const SCENARIOS = ['图像创作', '视频生成', '素材编辑', '工作流']
export const PRICING_RULES: Array<{title: string; description: string}> = []
export const RECHARGE_TIERS: Array<{cant: string; points: string; note: string; pointsValue?: number}> = []
export const FAQS = [
  { q: '如何开始创作？', a: '请管理员在系统设置中配置模型，或使用本地演示模型。' },
  { q: '如何保存结果？', a: '在成果区查看、下载或复用生成的素材。' },
]
