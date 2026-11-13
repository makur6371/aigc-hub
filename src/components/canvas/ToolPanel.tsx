'use client'

// 工具面板内容（无壳版）：与画布工作流配套的「一键输入 / 一键运行 / 一键输出」。
// 由 CopilotPanel 在「工具」模式下渲染其内容（玻璃壳由 CopilotPanel 提供）。
// 也可独立使用（ToolPanel = 带壳版，向后兼容）。

import { useEffect, useState } from 'react'
import { Button, Input, Select, Tooltip, message } from 'antd'
import {
  PlayCircleOutlined,
  CloseOutlined,
  DownloadOutlined,
  CopyOutlined,
  CheckOutlined,
} from '@ant-design/icons'
import { decodeSize, findImageSize, getImageCapabilities } from '@/lib/image-sizes'
import { modelTypesForCategory } from '@/lib/media-kinds'
import type { WorkflowTool, ToolInputBinding } from '@/app/(app)/canvas/tool-types'

const { TextArea } = Input

export interface ToolNodeView {
  type: string
  category: string
  inputs: Record<string, unknown>
  label?: string
}

export interface ToolPanelContentProps {
  tool: WorkflowTool
  nodeIds: string[]
  getNode: (canvasId: string) => ToolNodeView | undefined
  modelOptions: { id: string; name: string; type: string; metadata?: Record<string, unknown> | null }[]
  modelsLoading?: boolean
  outputs: Record<string, Record<string, unknown>>
  running: boolean
  onRun: (values: { nodeId: string; port: string; value: unknown }[]) => void
}

const FALLBACK_RATIOS: Record<string, [number, number]> = {
  '1:1': [1024, 1024],
  '4:3': [1152, 864],
  '3:4': [864, 1152],
  '16:9': [1280, 720],
  '9:16': [720, 1280],
  '3:2': [1152, 768],
  '2:3': [768, 1152],
}

function CopyButton({ text }: { text: string }) {
  const [ok, setOk] = useState(false)
  return (
    <Button
      size="small"
      type="text"
      icon={ok ? <CheckOutlined /> : <CopyOutlined />}
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setOk(true)
          setTimeout(() => setOk(false), 1500)
        })
      }}
    />
  )
}

export function ToolPanelContent({
  tool,
  nodeIds,
  getNode,
  modelOptions,
  modelsLoading,
  outputs,
  running,
  onRun,
}: ToolPanelContentProps) {
  const [values, setValues] = useState<Record<string, string>>({})

  useEffect(() => {
    // 延后一帧再回填：避免在 effect 同步体内 setState 触发级联渲染
    const timer = window.setTimeout(() => {
      const init: Record<string, string> = {}
      for (const b of tool.inputs) {
        const nid = nodeIds[b.nodeIndex]
        if (!nid) continue
        const node = getNode(nid)
        const cur = node?.inputs[b.port]
        if (cur != null) init[b.key] = String(cur)
      }
      setValues((prev) => ({ ...init, ...prev }))
    }, 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool.id])

  const handleRun = () => {
    const bindings: { nodeId: string; port: string; value: unknown }[] = []
    for (const b of tool.inputs) {
      const nid = nodeIds[b.nodeIndex]
      if (!nid) continue
      if (b.control === 'ratio') {
        const raw = values[b.key] || ''
        const m = raw.match(/^(\d+)x(\d+)$/)
        if (!m) continue
        bindings.push(
          { nodeId: nid, port: 'width', value: Number(m[1]) },
          { nodeId: nid, port: 'height', value: Number(m[2]) },
        )
      } else {
        bindings.push({ nodeId: nid, port: b.port, value: values[b.key] ?? '' })
      }
    }
    if (bindings.length === 0) {
      message.warning('请先填写所需输入')
      return
    }
    onRun(bindings)
  }

  const renderRatio = (b: ToolInputBinding, nid: string) => {
    const node = getNode(nid)
    const modelId = node?.inputs.model as string | undefined
    const model = modelOptions.find((m) => m.id === modelId)
    const imageCap = getImageCapabilities(model)
    const decoded = imageCap.sizes
    const cur = decodeSize(`${Number(node?.inputs.width) || 0}x${Number(node?.inputs.height) || 0}`)
    const ratios = imageCap.declared
      ? imageCap.ratios
      : Object.keys(FALLBACK_RATIOS)
    const selRatio = cur && ratios.includes(cur.ratio) ? cur.ratio : undefined
    const selTier = selRatio && cur?.tier ? cur.tier : undefined
    const tierOptions = decoded.length && selRatio
      ? decoded.filter((d) => d.ratio === selRatio).map((d) => ({ value: d.tier, label: `${d.tier} (${d.width}x${d.height})` }))
      : []
    const setRatio = (r: string) => {
      const hit = findImageSize(imageCap, r)
      if (hit) setValues((prev) => ({ ...prev, [b.key]: `${hit.width}x${hit.height}` }))
      else if (FALLBACK_RATIOS[r]) {
        const [w, h] = FALLBACK_RATIOS[r]
        setValues((prev) => ({ ...prev, [b.key]: `${w}x${h}` }))
      } else setValues((prev) => ({ ...prev, [b.key]: '' }))
    }
    const setTier = (t: string) => {
      const hit = findImageSize(imageCap, selRatio, t)
      if (hit) setValues((prev) => ({ ...prev, [b.key]: `${hit.width}x${hit.height}` }))
    }
    return (
      <div className="flex gap-1.5">
        <Select
          className="flex-1 min-w-0"
          size="small"
          value={selRatio}
          onChange={setRatio}
          placeholder="比例"
          options={ratios.map((r) => ({ value: r, label: r }))}
        />
        <Select
          className="flex-1 min-w-0"
          size="small"
          value={selTier || undefined}
          onChange={setTier}
          placeholder="档位"
          options={tierOptions}
          disabled={!decoded.length || !selRatio}
        />
      </div>
    )
  }

  const renderControl = (b: ToolInputBinding, nid?: string) => {
    const v = values[b.key] ?? ''
    if (b.control === 'model') {
      const node = nid ? getNode(nid) : undefined
      const category = node?.category || ''
      const wantTypes = modelTypesForCategory(category)
      const options = modelOptions
        .filter((m) => wantTypes.includes(m.type))
        .map((m) => ({ value: m.id, label: `${m.name} ${m.type}` }))
      return (
        <Select
          className="w-full"
          size="small"
          showSearch
          value={v || undefined}
          onChange={(val) => setValues((prev) => ({ ...prev, [b.key]: val }))}
          placeholder="搜索并选择模型"
          optionFilterProp="label"
          options={options}
          loading={modelsLoading}
        />
      )
    }
    if (b.control === 'ratio') return nid ? renderRatio(b, nid) : null
    if (b.control === 'number') {
      return <Input size="small" type="number" value={v} onChange={(e) => setValues((prev) => ({ ...prev, [b.key]: e.target.value }))} />
    }
    if (b.control === 'textarea') {
      return <TextArea autoSize={{ minRows: 2, maxRows: 6 }} value={v} placeholder={b.placeholder} onChange={(e) => setValues((prev) => ({ ...prev, [b.key]: e.target.value }))} />
    }
    return <Input size="small" value={v} placeholder={b.placeholder} onChange={(e) => setValues((prev) => ({ ...prev, [b.key]: e.target.value }))} />
  }

  const nodeIdFor = (index: number) => nodeIds[index]

  const renderOutputValue = (nodeId: string, port: string) => {
    const out = outputs[nodeId]
    if (!out) return <div className="text-[11px] text-text-disabled">（运行后显示）</div>
    const raw = out[port]
    if (Array.isArray(raw)) {
      const imgs = raw.filter((x) => typeof x === 'string' && x)
      if (imgs.length) {
        return (
          <div className="grid grid-cols-2 gap-1.5">
            {imgs.map((src, i) => (
              <div key={i} className="relative rounded-lg overflow-hidden border border-border group">
                <img src={String(src)} alt="" className="w-full h-auto object-cover" />
                <a href={String(src)} target="_blank" rel="noreferrer" className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 max-lg:opacity-100 bg-black/40 text-white text-xs transition-opacity" onClick={(e) => e.stopPropagation()}>
                  <DownloadOutlined /> 下载
                </a>
              </div>
            ))}
          </div>
        )
      }
      return <div className="text-[11px] text-text-disabled">（{raw.length} 项）</div>
    }
    if (typeof raw === 'string' && raw) {
      if (raw.startsWith('data:image') || raw.startsWith('http')) {
        return (
          <a href={raw} target="_blank" rel="noreferrer">
            <img src={raw} alt="" className="w-full h-auto rounded-lg border border-border object-cover" />
          </a>
        )
      }
      return (
        <div className="flex items-center gap-1">
          <Tooltip title={raw}><div className="flex-1 text-[11px] truncate text-text-muted">{raw}</div></Tooltip>
          <CopyButton text={raw} />
        </div>
      )
    }
    return <div className="text-[11px] text-text-disabled">（运行后显示）</div>
  }

  const hasInputs = tool.inputs.length > 0
  const hasOutputs = tool.outputs.length > 0

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto aigc-hub-scrollbar px-3 py-3 space-y-4">
        {tool.description && (
          <p className="text-[11px] text-text-secondary leading-relaxed -mt-1">{tool.description}</p>
        )}

        {hasOutputs && (
          <div>
            <div className="text-[11px] font-medium text-text-muted mb-2">结果</div>
            {tool.outputs.map((o) => {
              const nid = nodeIdFor(o.nodeIndex)
              const node = nid ? getNode(nid) : undefined
              return (
                <div key={o.key} className="mb-3">
                  <div className="text-[10px] text-text-disabled mb-1">{o.label}{node?.label ? `（${node.label}）` : ''}</div>
                  {nid ? renderOutputValue(nid, o.port) : <div className="text-[11px] text-text-disabled">（运行后显示）</div>}
                </div>
              )
            })}
          </div>
        )}

        {hasInputs && (
          <div>
            <div className="text-[11px] font-medium text-text-muted mb-2">输入</div>
            <div className="space-y-3">
              {tool.inputs.map((b) => (
                <div key={b.key} className="flex flex-col gap-1">
                  <label className="text-xs text-foreground">{b.label}</label>
                  {renderControl(b, nodeIdFor(b.nodeIndex))}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="px-3 py-2.5 border-t border-white/30 bg-white/30">
        <Button type="primary" block icon={<PlayCircleOutlined />} loading={running} disabled={!hasInputs} onClick={handleRun}>
          {running ? '运行中…' : '一键运行'}
        </Button>
        {!hasInputs && <div className="text-center text-[10px] text-text-disabled mt-1.5">该工具无可配置输入，请在画布中操作</div>}
      </div>
    </div>
  )
}

// 带壳版（向后兼容，独立使用时用）
interface ToolPanelProps extends ToolPanelContentProps {
  onClose: () => void
}

export default function ToolPanel({ onClose, ...content }: ToolPanelProps) {
  return (
    <div className="absolute right-4 top-16 bottom-4 z-30 w-72 rounded-2xl border border-white/50 backdrop-blur-xl bg-gradient-to-b from-white/85 to-white/65 shadow-[0_8px_32px_rgba(2,6,23,0.12),0_2px_8px_rgba(2,6,23,0.08)] flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/40 bg-gradient-to-r from-accent/10 via-white/30 to-transparent">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground truncate">{content.tool.name}</div>
          <div className="text-[10px] text-text-secondary truncate">{content.tool.category} · 工作流工具</div>
        </div>
        <Button size="small" type="text" icon={<CloseOutlined />} onClick={onClose} />
      </div>
      <ToolPanelContent {...content} />
    </div>
  )
}
