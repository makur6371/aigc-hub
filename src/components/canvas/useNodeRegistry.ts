'use client'

import { useState, useEffect, useMemo } from 'react'
import type { NodeInfo } from '@/lib/canvas-utils'
import { apiFetch } from '@/lib/api-client'

export type ModelOption = {
  id: string
  name: string
  type: string
  supportsVision: boolean
  think: boolean
  costPoints?: number | null
  effectiveCostPoints?: number | null
  pricingType?: string | null
  isFree?: boolean
  dailyUserFreeQuota?: number | null
  freeQuotaRemaining?: number | null
  discount?: number | null
  metadata?: Record<string, unknown> | null
}

/**
 * 画布节点注册表：拉取节点定义 + 模型列表，派生 groupedNodes / nodeInfoMap。
 * 纯只读元数据子域，无画布状态依赖。
 */
export function useNodeRegistry() {
  const [nodes, setNodes] = useState<NodeInfo[]>([])
  const [groupedNodes, setGroupedNodes] = useState<Record<string, NodeInfo[]>>({})
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const nodesRes = await apiFetch<NodeInfo[]>('/api/canvas-nodes')
        if (nodesRes.success && Array.isArray(nodesRes.data)) {
          const list = nodesRes.data
          setNodes(list)
          // 节点库隐藏通用 audio-generate 兜底（与音乐/配音并列展示易混淆）；
          // nodeInfoMap 仍保留全量定义，老工作流里的 audio-generate 节点照常渲染执行
          const visible = list.filter((n) => n.nodeType !== 'audio-generate')
          const grouped = visible.reduce(
            (acc: Record<string, NodeInfo[]>, n: NodeInfo) => {
              if (!acc[n.category]) acc[n.category] = []
              acc[n.category].push(n)
              return acc
            },
            {} as Record<string, NodeInfo[]>
          )
          setGroupedNodes(grouped)
        }
      } catch { /* 节点注册表拉取失败不影响画布核心交互 */ }

      try {
        const modelsRes = await apiFetch<Array<{
          id: string; name: string; type: string; supportsVision?: boolean; costPoints?: number | null; effectiveCostPoints?: number | null; pricingType?: string | null; isFree?: boolean; discount?: number | null; metadata?: Record<string, unknown> | null
          dailyUserFreeQuota?: number | null; freeQuotaRemaining?: number | null
        }>>('/api/models')
        if (modelsRes.success && Array.isArray(modelsRes.data)) {
          setModelOptions(
            modelsRes.data.map((m) => ({
              id: m.id,
              name: m.name,
              type: m.type,
              supportsVision: !!m.supportsVision,
              think: !!(m.metadata && typeof m.metadata === 'object' && (m.metadata as Record<string, unknown>).think),
              costPoints: typeof m.costPoints === 'number' ? m.costPoints : null,
              effectiveCostPoints: typeof m.effectiveCostPoints === 'number' ? m.effectiveCostPoints : null,
              pricingType: typeof m.pricingType === 'string' ? m.pricingType : null,
              isFree: !!m.isFree,
              discount: typeof m.discount === 'number' ? m.discount : null,
              metadata: m.metadata && typeof m.metadata === 'object' ? m.metadata : null,
              dailyUserFreeQuota: typeof m.dailyUserFreeQuota === 'number' ? m.dailyUserFreeQuota : null,
              freeQuotaRemaining: typeof m.freeQuotaRemaining === 'number' ? m.freeQuotaRemaining : null,
            }))
          )
        }
      } catch { /* 模型拉取失败 */ } finally {
        setModelsLoading(false)
      }
    }
    load()
  }, [])

  const nodeInfoMap = useMemo(() => {
    const map = new Map<string, NodeInfo>()
    nodes.forEach((n) => map.set(n.nodeType, n))
    return map
  }, [nodes])

  return { nodes, groupedNodes, modelOptions, nodeInfoMap, modelsLoading }
}
