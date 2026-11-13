

export interface NodeBodyCtx {
  node: { id: string; type: string; label: string; inputs: Record<string, unknown>; batch?: { sourceId: string; index: number } | null }
  output: Record<string, unknown> | null | undefined
  modelOptions: { id: string; name: string; type: string; costPoints?: number | null; effectiveCostPoints?: number | null; pricingType?: string; discount?: number | null; isFree?: boolean; metadata?: Record<string, unknown> | null; dailyUserFreeQuota?: number | null; freeQuotaRemaining?: number | null; promoFreeImage?: boolean }[]
  running: boolean
  onRun: () => void
  onUpdateInput: (nodeId: string, key: string, value: unknown) => void
  onPreviewImage: (src: string) => void
  onPreviewVideo: (src: string) => void
  refImages: string[]
  stopPropagation: (e: React.PointerEvent) => void
  onOpenWorkbench?: (nodeId: string) => void
  /** 裁切节点原图（页面层已解析上游输入/运行结果） */
  cropImageUrl?: string
  /** 人脸涂鸦节点原图（页面层已解析上游输入/运行结果，与 cropImageUrl 同法） */
  doodleImageUrl?: string
  /** 一键衍生节点流转（学习 ComfyArt 核心原子动作） */
  onDeriveNode?: (sourceNodeId: string, actionType: 'remix' | 'face-doodle' | 'animate' | 'crop' | 'vision' | 'upscale', imageUrl: string) => void
}
