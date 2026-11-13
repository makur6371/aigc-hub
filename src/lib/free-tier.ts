// 免费开画板块的纯数据层：从 /api/models 的返回里筛出「零门槛可用」的模型。
// 放 lib 是为了脱离组件可测，也让首页/定价页共用同一口径。

export interface ModelTierItem {
  id: string
  name: string
  type: string
  typeLabel?: string
  pricingLabel?: string
  isFree?: boolean
  dailyUserFreeQuota?: number | null
}

export interface FreeTierModel {
  id: string
  name: string
  type: string
  typeLabel: string
  dailyFreeCount: number
  isFree: boolean
  pricingLabel?: string
}

const TYPE_LABEL_FALLBACK: Record<string, string> = {
  IMAGE: '图片生成',
  VIDEO: '视频生成',
  LLM: '文本对话',
  VISION: '视觉对话',
  AUDIO: '音频生成',
}

// 排序：图最先（对用户最直观），其余按固定类别顺序，同类别按名称。
const TYPE_RANK: Record<string, number> = { IMAGE: 0, VISION: 1, LLM: 2, VIDEO: 3, AUDIO: 4 }

export function pickFreeTierModels(items: ModelTierItem[]): FreeTierModel[] {
  return items
    .filter((m) => (m.dailyUserFreeQuota ?? 0) > 0 || m.isFree)
    .map((m) => ({
      id: m.id,
      name: m.name,
      type: m.type,
      typeLabel: m.typeLabel || TYPE_LABEL_FALLBACK[m.type] || m.type,
      dailyFreeCount: m.dailyUserFreeQuota ?? 0,
      isFree: Boolean(m.isFree),
      pricingLabel: m.pricingLabel,
    }))
    .sort((a, b) => {
      const rankDiff = (TYPE_RANK[a.type] ?? 9) - (TYPE_RANK[b.type] ?? 9)
      return rankDiff !== 0 ? rankDiff : a.name.localeCompare(b.name, 'zh')
    })
}
