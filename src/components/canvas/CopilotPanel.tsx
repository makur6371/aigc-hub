'use client'

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { notify } from '@/lib/browser-notify'
import { readLocalJson, readLocalText, writeLocalJson, writeLocalText } from '@/lib/local-store'
import { GUIDE_OPEN_COPILOT_EVENT } from '@/lib/agent-context-window'
import { consumeSseStream } from '@/lib/sse'

/**
 * /api/canvas/copilot 吐出的事件形状。
 *
 * 显式声明而不是继续用 any：解析收敛到 lib/sse 后事件字段是 unknown，
 * 这个联合类型让「后端改了事件字段名」在编译期就能发现，
 * 而不是运行时静默变成 undefined（Copilot 的 done/partial 分支曾经就是这样）。
 */
/** done / partial 事件里携带的完整结果（也是 doneData 的形状） */
type CopilotDoneData = {
  reply: string
  actions: Action[]
  thought?: string
  status?: string
  clarify?: { question: string; options?: string[] } | null
}

type CopilotSseEvent =
  | { type: 'reasoning'; content: string }
  | { type: 'text'; content: string }
  | {
      type: 'done' | 'partial'
      reply: string
      actions?: Action[]
      thought?: string
      status?: string
      clarify?: { question: string; options?: string[] } | null
      error?: string
    }
  | { type: 'error'; message?: string }
import { Input, Button, Typography, Space, App, Select, Segmented, Popover, Dropdown } from 'antd'
import { CloseOutlined, CheckOutlined, SettingOutlined, UndoOutlined, MessageOutlined, FileTextOutlined, EyeOutlined, ThunderboltOutlined, QuestionCircleOutlined, LoadingOutlined, DownOutlined, ArrowUpOutlined, PauseOutlined, PlayCircleOutlined, ToolOutlined } from '@ant-design/icons'
import { AnimatedLogo } from '@/components/ui/AnimatedLogo'
import { Markdown } from '@/components/ui/Markdown'
import { Tooltip } from 'antd'
import type { Action } from '@/lib/copilot-actions'
import { onWorkflowExecuted } from './copilot-events'
import { ToolPanelContent, type ToolNodeView } from './ToolPanel'
import type { WorkflowTool } from '@/app/(app)/canvas/tool-types'

const { Text } = Typography

export interface CanvasOps {
  createNode: (nodeType: string, x?: number, y?: number) => string
  deleteNode: (id: string) => void
  connectNodes: (sourceId: string, sourcePort: string, targetId: string, targetPort: string) => void
  deleteConnection: (id: string) => void
  deleteConnectionByPorts?: (sourceId: string, sourcePort: string, targetId: string, targetPort: string) => void
  updateNodeInput: (nodeId: string, key: string, value: unknown) => void
  runWorkflow: () => void
  selectNode: (id: string) => void
  clearCanvas: () => void
  getCanvasState: () => { nodes: unknown[]; connections: unknown[] }
  restoreSnapshot?: (nodes: unknown[], connections: unknown[]) => void
  getExecutionLogs?: () => Array<{ nodeId: string; status: string; output?: Record<string, unknown>; error?: string }>
  autoLayout?: (nodeIds: string[]) => void
  getCanvasHealthCheck?: () => string
  highlightNodes?: (ids: string[]) => void
  setGhost?: (g: { nodes: { id: string; nodeType: string }[]; connections: { sourceId: string; sourcePort: string; targetId: string; targetPort: string }[] } | null) => void
}

type ChatMsg = { role: 'user' | 'assistant' | 'system'; content: string }

// 交互模式:对话(只答不改) / 计划(只出计划,批准后不执行) / 逐步(批准后逐步执行) / 自动(批准后自动执行)
type CopilotMode = 'chat' | 'plan' | 'step' | 'auto'
// PAEVC 阶段(对齐 Agent State Indicator)
type Stage = 'idle' | 'thinking' | 'awaiting' | 'verifying' | 'done' | 'stopped' | 'error'

type SnapShot = { nodes: unknown[]; connections: unknown[] }
type TimelineItem = { id: string; icon: string; text: string; ok?: boolean; anchor?: number }

const MODE_LABELS: Record<CopilotMode, string> = { chat: '对话', plan: '计划', step: '逐步', auto: '自动' }

// 收起胶囊的轮播提示语：操作 / 界面 / 创作技巧（纯文字，不用表情符号）
const TIPS = [
  '胶囊可拖到顺手位置',
  '右上角可切换半屏/全屏',
  '一句话让 Agent 搭工作流',
  '报错了？让 Agent 检查画布',
  '让 Agent 解释当前工作流',
  '参考图端口可连多张图',
]
// 完整提示语（胶囊 hover 时展示，避免精简版截断丢信息）
const TIPS_FULL = [
  '按住胶囊左右拖动，放到你顺手的位置',
  '展开后可切换半屏或全屏，右上角一键切换',
  '一句话让 Agent 自动搭建并运行工作流',
  '画布有报错？让 Agent「检查画布」自动修复',
  '让 Agent 解释当前工作流，快速看懂结构',
  '上传参考图连到「参考图片」端口后，提示词里用「第一张图/第二张图」描述即可指代',
]
const STAGE_LABELS: Record<Stage, string> = {
  idle: '待命', thinking: '思考中…', awaiting: '待确认', verifying: '验证中…',
  done: '完成', stopped: '已停止', error: '出错',
}

type LoopState = {
  task: string
  round: number
  observation: string
  history: { role: string; content: string }[]
  approved?: boolean
  planBatch?: Action[]
}

// 单行思考流水框：文字从左侧流入，视口始终跟随最新内容（不换行、不撑高）
function ThoughtLine({ text }: { text: string }) {
  const trackRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (trackRef.current) trackRef.current.scrollLeft = trackRef.current.scrollWidth
  }, [text])
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-black/[0.04] px-2 py-1 text-[11px] text-text-muted overflow-hidden">
      <span className="shrink-0 rounded bg-accent/10 px-1.5 py-px text-[10px] font-medium text-accent">思考</span>
      <div ref={trackRef} className="flex-1 overflow-hidden aigc-hub-scrollbar">
        {text ? (
          <span className="whitespace-nowrap">{text}</span>
        ) : (
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            思考中
            <span className="w-1.5 h-1.5 rounded-full bg-accent copilot-thinking-dot" />
            <span className="w-1.5 h-1.5 rounded-full bg-accent copilot-thinking-dot" style={{ animationDelay: '150ms' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-accent copilot-thinking-dot" style={{ animationDelay: '300ms' }} />
          </span>
        )}
      </div>
    </div>
  )
}

// 去掉消息里的装饰符号（✓ ✗ ❓ ✅ ⚠ 📋 🔴 🟡 🟢 等），界面统一用组件图标表达状态
const DECOR_RE = /[✓✗❓✅⚠📋💭▶🔴🟡🟢]️?/g
function stripDecor(s: string): string {
  return s.replace(DECOR_RE, '').replace(/^[ \t]+/gm, '')
}

// 把原子操作渲染成人类可读文本(计划卡/证据时间线复用)
function describeAction(a: Action, alias?: Record<string, string>): string {
  const nm = (id: string) => alias?.[id] || id
  switch (a.op) {
    case 'createNode': return `创建 ${nodeTypeLabel(a.nodeType)}${a.model ? `(${a.model.slice(0, 12)})` : ''}`
    case 'deleteNode': return `删除节点${a.nodeId ? ` ${nm(a.nodeId)}` : ''}`
    case 'connectNodes': return `连线 ${nm(a.sourceNodeId)}.${a.sourcePort} → ${nm(a.targetNodeId)}.${a.targetPort}`
    case 'deleteConnection': return '删除连线'
    case 'updateNodeInput': return `设置参数 ${nm(a.nodeId)} 的 ${a.key}`
    case 'runWorkflow': return '运行工作流'
    case 'selectNode': return '选中节点'
    case 'clearCanvas': return '清空画布'
    case 'requestLogs': return '查看执行日志'
    case 'autoLayout': return '整理画布布局'
  }
}

// 从流式 JSON 前缀里增量提取指定字符串字段的已完成部分（Copilot 后端 SSE text 块是 LLM JSON 的流式片段）
function extractFieldFromStream(s: string, field: string): string {
  const re = new RegExp(`"${field}"\\s*:\\s*"`)
  const m = re.exec(s)
  if (!m) return ''
  let out = ''
  let i = m.index + m[0].length
  while (i < s.length) {
    const ch = s[i]
    if (ch === '\\') {
      const next = s[i + 1]
      if (next === 'n') out += '\n'
      else if (next === 't') out += '\t'
      else if (next === '"') out += '"'
      else if (next === '\\') out += '\\'
      else if (next) { out += ch + next }
      i += 2
      continue
    }
    if (ch === '"') break
    out += ch
    i++
  }
  return out
}
const NODE_TYPE_LABELS: Record<string, string> = {
  'text-input': '文本输入', 'text-preview': '文本预览', 'text-concat': '文本拼接', 'llm-chat': 'LLM 对话',
  'image-upload': '图片上传', 'image-upload-batch': '图片批量上传', 'image-generate': '图片生成', 'nine-grid-loop': '九宫格循环帧', 'grid9-to-gif': '九宫格转GIF', 'image-preview': '图片预览',
  'image-crop': '图片裁切',
  'json-parser': 'JSON 解析', 'json-prompt-batch': '批量提示词', 'number-input': '数值输入', 'field-extractor': '字段提取',
  'condition-check': '条件判断',
  'sfx-generate': '音效生成', 'voice-isolate': '人声分离', 'audio-upload': '语音上传',
}
function nodeTypeLabel(t: string): string {
  return NODE_TYPE_LABELS[t] || t
}

// 模型选项标签：名称 + 积分消耗（免费标注）
function modelLabel(m: { name: string; costPoints?: number | null; isFree?: boolean }): string {
  if (m.isFree) return `${m.name}（免费）`
  if (typeof m.costPoints === 'number' && m.costPoints > 0) return `${m.name}（${m.costPoints} 积分/次）`
  return m.name
}

export function CopilotPanel({ ops, modelOptions, containerRef, externalPrompt, autoRun, toolState, toolModelOptions, toolModelsLoading, toolOutputs, onToolRun, onToolClose }: {
  ops: CanvasOps
  modelOptions: { id: string; name: string; type: string; costPoints?: number | null; isFree?: boolean }[]
  containerRef?: React.RefObject<HTMLElement | null>
  externalPrompt?: string | null
  autoRun?: boolean
  // 工具模式：当前打开的工作流工具（null = 不显示工具模式）
  toolState?: { tool: WorkflowTool; nodeIds: string[] } | null
  toolModelOptions?: { id: string; name: string; type: string; metadata?: Record<string, unknown> | null }[]
  toolModelsLoading?: boolean
  toolOutputs?: Record<string, Record<string, unknown>>
  onToolRun?: (values: { nodeId: string; port: string; value: unknown }[]) => void
  onToolClose?: () => void
}) {
  const { message } = App.useApp()
  // 流式回复：SSE 流中实时渲染 reply（打字机），done 后固化为消息（声明放组件体前部供各回调引用）
  const [streamingReply, setStreamingReply] = useState('')
  // 思考过程：每轮一条「单行流水框」，按时间顺序穿插在对应回答之前
  const [thoughtRows, setThoughtRows] = useState<{ id: number; text: string; anchor: number }[]>([])
  const activeThoughtRowRef = useRef<number | null>(null)
  const streamedThisRoundRef = useRef(false)
  // 流式节流：SSE 一次 read() 批量到达多个 text 块，React 批量合并 setState 导致"最后才显示"；
  // 用 rAF 每帧渲染一次最新流式值，实现"流水"效果
  const streamValRef = useRef({ thought: '', reply: '' })
  const streamRafRef = useRef<number | null>(null)
  const scheduleStreamRender = useCallback(() => {
    if (streamRafRef.current != null) return
    streamRafRef.current = requestAnimationFrame(() => {
      streamRafRef.current = null
      setStreamingReply(streamValRef.current.reply)
      const rid = activeThoughtRowRef.current
      if (rid != null && streamValRef.current.thought) {
        setThoughtRows((prev) => prev.map((r) => (r.id === rid ? { ...r, text: streamValRef.current.thought } : r)))
      }
    })
  }, [])
  useEffect(() => () => { if (streamRafRef.current != null) cancelAnimationFrame(streamRafRef.current) }, [])
  const [mode, setMode] = useState<CopilotMode>(() => {
    if (typeof window === 'undefined') return 'auto'
    const saved = readLocalText('copilot-mode')
    return (saved === 'chat' || saved === 'plan' || saved === 'step' || saved === 'auto') ? saved as CopilotMode : 'auto'
  })
  const [stage, setStage] = useState<Stage>('idle')
  // 面板模式：copilot（AI 助手）/ tool（工作流工具）—— toolState 有值时自动切到 tool
  const [panelMode, setPanelMode] = useState<'copilot' | 'tool'>('copilot')
  const prevToolStateRef = useRef<null | { tool: WorkflowTool; nodeIds: string[] }>(null)
  useEffect(() => {
    if (toolState && (!prevToolStateRef.current || prevToolStateRef.current.tool.id !== toolState.tool.id)) {
      setPanelMode('tool')
      setCopilotPinned(true)
      setExpandMode((m) => m === 'collapsed' ? 'half' : m)
    }
    prevToolStateRef.current = toolState ?? null
  }, [toolState])
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMsg[]>([
    { role: 'assistant', content: '你好,我是画布 Copilot。告诉我你想做什么,比如"搭一个电商海报工作流"或"解释一下这个工作流"。' },
  ])
  const [copilotModel, setCopilotModel] = useState<string>(() => (typeof window !== 'undefined' ? readLocalText('copilot-model') || '' : ''))
  const [brainModel, setBrainModel] = useState<string>(() => (typeof window !== 'undefined' ? readLocalText('copilot-brain-model') || '' : ''))
  // 分类型模型偏好：识别(VISION)/生图(IMAGE)/视频(VIDEO)，创建对应节点时优先使用
  const [visionModel, setVisionModel] = useState<string>(() => (typeof window !== 'undefined' ? readLocalText('copilot-vision-model') || '' : ''))
  const [imageModel, setImageModel] = useState<string>(() => (typeof window !== 'undefined' ? readLocalText('copilot-image-model') || '' : ''))
  const [videoModel, setVideoModel] = useState<string>(() => (typeof window !== 'undefined' ? readLocalText('copilot-video-model') || '' : ''))
  const scrollRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<ChatMsg[]>(messages)
  messagesRef.current = messages
  const abortRef = useRef<AbortController | null>(null)
  // 待批准的操作批次(第一轮 actions 作为意图预览) + 澄清
  const [planActions, setPlanActions] = useState<Action[] | null>(null)
  const [clarifyState, setClarifyState] = useState<{ question: string; options?: string[] } | null>(null)
  // 证据时间线(替换旧深色日志台)
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  // checkpoint 回退栈
  const [checkpoints, setCheckpoints] = useState<SnapShot[]>([])
  const loopStateRef = useRef<LoopState | null>(null)
  const pendingContinueRef = useRef<LoopState | null>(null)
  const [currentRound, setCurrentRound] = useState(0)
  // 轮次预算(每轮=1次模型调用=积分;可配置 5快/8标准/12深度)
  const [maxRounds, setMaxRounds] = useState<number>(() => {
    if (typeof window === 'undefined') return 8
    const saved = Number(readLocalText('copilot-max-rounds'))
    return (saved === 5 || saved === 8 || saved === 12) ? saved : 8
  })
  useEffect(() => { writeLocalText('copilot-max-rounds', String(maxRounds)) }, [maxRounds])

  useEffect(() => { writeLocalText('copilot-mode', mode) }, [mode])
  useEffect(() => { writeLocalText('copilot-model', copilotModel) }, [copilotModel])
  useEffect(() => { writeLocalText('copilot-brain-model', brainModel) }, [brainModel])

  // 首次进入（localStorage 里还没记录）时，把「大脑模型」预选到平台默认的免费文本模型。
  // 之前留空走「自动选模型」：后端虽会兜底，但面板只显示「自动选模型」，
  // 用户不知道到底用了谁、也没法确认参数。这里显式落一个默认值，和
  // /api/canvas/copilot 的兜底偏好名单（src/lib/model-catalog.ts）保持一致。
  useEffect(() => {
    if (brainModel) return
    if (!modelOptions?.length) return
    const usable = modelOptions.filter((m) => m.type === 'TEXT' || m.type === 'VISION')
    const hit = usable[0]
    if (hit) setBrainModel(hit.id)
  }, [modelOptions, brainModel])
  useEffect(() => { writeLocalText('copilot-vision-model', visionModel) }, [visionModel])
  useEffect(() => { writeLocalText('copilot-image-model', imageModel) }, [imageModel])
  useEffect(() => { writeLocalText('copilot-video-model', videoModel) }, [videoModel])

  // 空态引导 / 首页入口：收到 externalPrompt 时固定展开并预填输入；autoRun 时自动发送执行
  useEffect(() => {
    if (!externalPrompt) return
    setCopilotPinned(true)
    if (autoRun) {
      // 等面板展开动画完成后自动执行（首页胶囊缩小飞入的衔接）
      const t = setTimeout(() => send(externalPrompt), 450)
      return () => clearTimeout(t)
    }
    setInput(externalPrompt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalPrompt, autoRun])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, stage, timeline, streamingReply])

  // 画布工作流执行结果 → 聊天提示
  useEffect(() => {
    const unsub = onWorkflowExecuted((result) => {
      const hasError = result.logs.some((l) => l.status === 'error') || result.error
      const text = hasError
        ? `✗ 工作流执行出错:\n${result.logs.filter((l) => l.status === 'error').map((l) => `• 节点 ${l.nodeId.slice(-6)}: ${l.error || '未知错误'}`).join('\n')}`
        : `✓ 工作流执行完成,${result.logs.length} 个节点全部成功。`
      setMessages((prev) => [...prev, { role: 'system', content: text }])
      notifyRef.current('工作流执行', hasError ? '工作流执行出错' : '工作流执行完成')
    })
    return unsub
  }, [])

  // ---------- 执行器(保留已验证逻辑) ----------
  const runActions = useCallback((actions: Action[]): { ok: number; fail: string | null; details: string[] } => {
    const tempMap = new Map<string, string>()
    const nodes = ops.getCanvasState().nodes as { id: string }[]
    const suffixCount = new Map<string, number>()
    for (const n of nodes) suffixCount.set(n.id.slice(-6), (suffixCount.get(n.id.slice(-6)) || 0) + 1)
    const idAlias = new Map<string, string>()
    for (const n of nodes) {
      idAlias.set(n.id, n.id)
      if (suffixCount.get(n.id.slice(-6)) === 1) idAlias.set(n.id.slice(-6), n.id)
    }
    const resolveId = (id: string): string => {
      if (tempMap.has(id)) return tempMap.get(id)!
      if (idAlias.has(id)) return idAlias.get(id)!
      const cands = nodes.filter((n) => id.length >= 4 && n.id.endsWith(id))
      return cands.length === 1 ? cands[0].id : id
    }
    let ok = 0
    const details: string[] = []
    const createdIds: string[] = []
    const touchedIds: string[] = []
    for (const a of actions) {
      try {
        switch (a.op) {
          case 'createNode': {
            const realId = ops.createNode(a.nodeType, a.x, a.y)
            if (a.tempId) tempMap.set(a.tempId, realId)
            createdIds.push(realId)
            touchedIds.push(realId)
            if (a.model) ops.updateNodeInput(realId, 'model', a.model)
            details.push(`✓ 创建 ${nodeTypeLabel(a.nodeType)}${a.model ? `(${a.model.slice(0, 20)})` : ''}`)
            ok++
            break
          }
          case 'deleteNode': { const rid = resolveId(a.nodeId); ops.deleteNode(rid); touchedIds.push(rid); details.push(`✓ 删除节点`); ok++; break }
          case 'connectNodes': { ops.connectNodes(resolveId(a.sourceNodeId), a.sourcePort, resolveId(a.targetNodeId), a.targetPort); touchedIds.push(resolveId(a.sourceNodeId), resolveId(a.targetNodeId)); details.push(`✓ 连线`); ok++; break }
          case 'deleteConnection': {
            if (a.connectionId) ops.deleteConnection(a.connectionId)
            else if (a.sourceNodeId && a.sourcePort && a.targetNodeId && a.targetPort) ops.deleteConnectionByPorts?.(resolveId(a.sourceNodeId), a.sourcePort, resolveId(a.targetNodeId), a.targetPort)
            details.push(`✓ 删除连线`); ok++
            break
          }
          case 'updateNodeInput': { const rid = resolveId(a.nodeId); ops.updateNodeInput(rid, a.key, a.value); touchedIds.push(rid); details.push(`✓ 设置 ${a.key}`); ok++; break }
          case 'runWorkflow': ops.runWorkflow(); details.push(`▶ 运行工作流`); ok++; break
          case 'selectNode': ops.selectNode(resolveId(a.nodeId)); ok++; break
          case 'clearCanvas': ops.clearCanvas(); details.push(`✓ 清空画布`); ok++; break
          case 'autoLayout': {
            if (ops.autoLayout) {
              const ids = a.nodeIds && a.nodeIds.length > 0 ? a.nodeIds.map(resolveId) : []
              ops.autoLayout(ids)
              details.push(`🪄 整理画布节点布局`)
              ok++
            }
            break
          }
          case 'requestLogs': {
            const logs = ops.getExecutionLogs?.() || []
            const logText = logs.length ? logs.map((l) => `[${l.status}] ${l.nodeId.slice(-6)}${l.error ? ` 错误:${l.error}` : ''}`).join('\n') : '暂无执行日志'
            details.push(`📋 ${logs.length} 条日志`); ok++
            break
          }
        }
      } catch (e) {
        return { ok, fail: e instanceof Error ? e.message : '执行失败', details }
      }
    }
    if (createdIds.length > 1 && ops.autoLayout) setTimeout(() => ops.autoLayout!(createdIds), 100)
    // 高亮被改动的节点
    if (touchedIds.length > 0 && ops.highlightNodes) setTimeout(() => ops.highlightNodes!(touchedIds), 120)
    return { ok, fail: null, details }
  }, [ops])

  // 把 actions 明细灌入时间线（anchor 取当前消息数快照，条目散入聊天流）
  const messagesLenRef = useRef(messages.length)
  messagesLenRef.current = messages.length
  const pushTimeline = useCallback((details: string[], isVerify?: boolean) => {
    const anchor = messagesLenRef.current
    setTimeline((prev) => [
      ...prev,
      ...details.map((d, i) => ({
        id: `t${Date.now()}-${prev.length}-${i}`,
        icon: d.startsWith('✓') ? '✓' : d.startsWith('▶') ? '▶' : d.startsWith('✗') ? '✗' : '·',
        text: d,
        ok: d.startsWith('✓'),
        anchor,
      })),
    ])
  }, [])

  const waitForWorkflowResult = useCallback((timeoutMs = 120000): Promise<string> => {
    return new Promise((resolve) => {
      const startedAt = Date.now()
      const poll = () => {
        const logs = ops.getExecutionLogs?.() || []
        const running = logs.some((l) => l.status === 'running')
        if (logs.length > 0 && !running) {
          resolve(logs.map((l) => `[${l.status}] ${l.nodeId.slice(-6)}${l.error ? ` 错误:${l.error}` : ''}`).join('\n') || '工作流执行完成')
          return
        }
        if (Date.now() - startedAt > timeoutMs) { resolve('工作流仍在执行中(已超时)'); return }
        setTimeout(poll, 600)
      }
      poll()
    })
  }, [ops])

  // checkpoint:执行前入栈,回退时还原
  const pushCheckpoint = useCallback(() => {
    const state = ops.getCanvasState()
    setCheckpoints((prev) => [...prev.slice(-4), { nodes: state.nodes, connections: state.connections }])
  }, [ops])
  const rewind = useCallback(() => {
    setCheckpoints((prev) => {
      if (prev.length === 0) return prev
      const snap = prev[prev.length - 1]
      ops.restoreSnapshot?.(snap.nodes, snap.connections)
      message.success('已回退到上一步')
      return prev.slice(0, -1)
    })
    setPlanActions(null)
    setGhost(null)
    setClarifyState(null)
    setTimeline([])
    loopStateRef.current = null
    setStage('idle')
  }, [ops, message])

  const setGhost = useCallback((g: Parameters<NonNullable<CanvasOps['setGhost']>>[0]) => {
    ops.setGhost?.(g)
  }, [ops])

  // 从待批准的动作批次提取幽灵预览(新节点虚线框 + 新连线虚线)
  const ghostFromActions = useCallback((acts: Action[]) => {
    const gNodes: { id: string; nodeType: string }[] = []
    const gConns: { sourceId: string; sourcePort: string; targetId: string; targetPort: string }[] = []
    const tempToId = new Map<string, string>()
    for (const a of acts) {
      if (a.op === 'createNode') {
        const gid = a.tempId || `g${gNodes.length}`
        if (a.tempId) tempToId.set(a.tempId, gid)
        gNodes.push({ id: gid, nodeType: a.nodeType })
      }
    }
    for (const a of acts) {
      if (a.op === 'connectNodes') {
        gConns.push({ sourceId: tempToId.get(a.sourceNodeId) || a.sourceNodeId, sourcePort: a.sourcePort, targetId: tempToId.get(a.targetNodeId) || a.targetNodeId, targetPort: a.targetPort })
      }
    }
    return { nodes: gNodes, connections: gConns }
  }, [])

  // 执行一轮:请求→SSE→(plan/clarify→暂停) 或 执行→验证→续/停
  const continueLoop = useCallback(async () => {
    const st = loopStateRef.current
    if (!st) { setStage('idle'); return }
    setCurrentRound(st.round)
    setStage(st.approved ? 'thinking' : 'thinking')

    const controller = new AbortController()
    abortRef.current = controller
    const msg = st.approved
      ? `${st.task}\n\n[用户已批准计划。请直接输出执行 actions(status:"continue" 或 "done"),不要再输出 plan。]`
      : (mode === 'chat' ? `${st.task}\n\n（对话模式:请只回答问题,不要修改画布。actions 必须为空,status:"done"。）` : st.task)

    try {
      const res = await fetch('/api/canvas/copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: msg,
          canvasState: ops.getCanvasState(),
          history: st.history,
          modelId: copilotModel || undefined,
          brainModelId: brainModel || undefined,
          visionModelId: visionModel || undefined,
          imageModelId: imageModel || undefined,
          videoModelId: videoModel || undefined,
          iteration: st.round,
          observation: st.round > 1 ? st.observation : undefined,
        }),
        signal: controller.signal,
      })
      if (res.status === 401) { message.error('登录已失效,请重新登录'); window.location.href = '/login'; return }
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `请求失败(${res.status})`) }

      // 解析收敛到 lib/sse（唯一实现）。
      //
      // 这里同时修了两个缺陷：
      //   1) 原来直接 chunk.split('\n')，**没有残行累积** —— 一行 JSON 恰好在
      //      chunk 边界被切断时那一半会被丢掉，表现为「流式输出偶发丢字」。
      //   2) 原来 `type === error` 的 throw 被同层 catch 吞掉（读起来会抛、实际静默），
      //      后端报错时用户只看到转圈然后没反应。现在解析已由 lib/sse 负责，
      //      回调里不再需要 try/catch，抛错能正常传播。
      // 流式累积：reply 由 text 分片实时拼接；done/partial 到达时用 doneData 覆盖
      let accumulatedText = ''
      let doneData: CopilotDoneData | null = null

      if (!res.body) throw new Error('无响应流')
      await consumeSseStream(res.body, (raw) => {
        const event = raw as unknown as CopilotSseEvent
        if (event.type === 'reasoning') {
          // 首个思考块到达时才建本轮思考行（此时用户消息已入列，anchor 顺序正确）
          if (activeThoughtRowRef.current == null) {
            const rid = Date.now()
            streamedThisRoundRef.current = false
            streamValRef.current.thought = ''
            activeThoughtRowRef.current = rid
            setThoughtRows((prev) => [...prev.slice(-6), { id: rid, text: '', anchor: messagesRef.current.length }])
          }
          streamedThisRoundRef.current = true
          streamValRef.current.thought = streamValRef.current.thought + event.content
          scheduleStreamRender()
        }
        else if (event.type === 'text') {
          accumulatedText += event.content
          // reply 从流式 JSON 实时提取；rAF 节流每帧渲染（避免批量合并导致最后才显示）
          streamValRef.current.reply = extractFieldFromStream(accumulatedText, 'reply')
          scheduleStreamRender()
        }
        else if (event.type === 'done' || event.type === 'partial') {
          doneData = { reply: event.reply, actions: event.actions || [], thought: event.thought, status: event.status, clarify: event.clarify }
          if (event.type === 'partial' && event.error) message.warning(`⚠️ ${event.error}`)
        } else if (event.type === 'error') { throw new Error(String(event.message ?? 'Copilot 请求失败')) }
      }, { signal: controller.signal })
      // 断言的原因：doneData 只在 consumeSseStream 的回调里被赋值，
      // 而 TS 的控制流分析不跨函数边界追踪赋值，会把 doneData 收窄成恒为 null。
      const finalData: CopilotDoneData =
        (doneData as CopilotDoneData | null) ??
        { reply: accumulatedText, actions: [], thought: undefined, status: 'done', clarify: null }
      const { reply, actions, thought, status, clarify } = finalData
      // 收尾本轮思考行：有实时流则固化最新流内容；无流但有 JSON thought 则补建一行
      // （必须同步写入：rAF 渲染帧可能晚于此处的清理，直接置空 ref 会丢内容）
      const rid = activeThoughtRowRef.current
      if (rid != null) {
        const finalThought = streamedThisRoundRef.current ? streamValRef.current.thought : (thought || '')
        if (finalThought) {
          setThoughtRows((prev) => prev.map((r) => (r.id === rid ? { ...r, text: finalThought } : r)))
        }
        activeThoughtRowRef.current = null
      } else if (thought) {
        setThoughtRows((prev) => [...prev.slice(-6), { id: Date.now(), text: thought, anchor: messagesRef.current.length }])
      }
      // 流式 reply 结束：清空打字机，后续分支把完整 reply 固化为消息
      setStreamingReply('')

      // ---------- 澄清:反问后暂停 ----------
      if (clarify && clarify.question) {
        setClarifyState(clarify)
        setMessages((prev) => [...prev, { role: 'assistant', content: `❓ ${clarify.question}` }])
        setStage('awaiting')
        return
      }

      // ---------- 意图预览:非对话模式第一轮,先把 actions 展示给用户批准(不执行) ----------
      if (mode !== 'chat' && !st.approved && actions.length > 0) {
        setPlanActions(actions)
        setGhost(ghostFromActions(actions))
        setMessages((prev) => [...prev, { role: 'assistant', content: `${reply || '这是我打算做的操作,请确认后执行。'}` }])
        setStage('awaiting')
        loopStateRef.current = { ...st, planBatch: actions }
        return
      }

      // ---------- 执行 ----------
      setPlanActions(null)
      setGhost(null)
      const allDetails: string[] = []
      if (actions.length > 0) {
        const r = runActions(actions)
        allDetails.push(...r.details)
        pushTimeline(r.details)
      }
      setMessages((prev) => [...prev, { role: 'assistant', content: reply || (allDetails.length ? `已执行 ${allDetails.length} 个操作` : '') }])

      // 验证:等待工作流结果(如运行)+ 确定性健康检查
      setStage('verifying')
      let obsText = allDetails.join('、')
      if (actions.some((a) => a.op === 'runWorkflow')) {
        const logs = await waitForWorkflowResult()
        obsText += (obsText ? '\n' : '') + logs
        pushTimeline(logs.split('\n').map((l) => (l ? `📋 ${l}` : l)).filter(Boolean))
      }
      await new Promise((r) => setTimeout(r, 0))
      const health = ops.getCanvasHealthCheck?.() || ''
      obsText += (obsText ? '\n' : '') + health
      const hasHealthErrors = /\[错误\]/.test(health)
      const healthIcon = hasHealthErrors ? '🔴' : /警告/.test(health) ? '🟡' : '🟢'
      pushTimeline([`${healthIcon} ${health.split('\n')[0]}`])
      const errorNudge = hasHealthErrors ? '\n⚠️ 健康检查仍有错误,必须修复后再 done。' : ''
      const roundStatus = status === 'continue' ? 'continue' : 'done'
      // 护栏:仅当本轮真正执行了动作且画布仍有错误时才强制续轮;
      // 空 actions + done(LLM 空转/放弃)则接受完成并提示,避免空转循环烧光预算
      const effectiveStatus = roundStatus === 'done' && hasHealthErrors && allDetails.length > 0 ? 'continue' : roundStatus

      // 无操作仅对话(或 LLM 空转 done):接受完成;若画布仍有错误则提示未完成
      if (allDetails.length === 0 && actions.length === 0 && effectiveStatus !== 'continue') {
        setStage('done'); loopStateRef.current = null
        if (hasHealthErrors) {
          setMessages((prev) => [...prev, { role: 'system', content: '⚠️ 画布仍有健康检查错误,可能未完全完成。可用「检查画布」查看,或补充描述让 Copilot 继续。' }])
        }
        return
      }

      if (effectiveStatus === 'done' || st.round >= maxRounds) {
        const ok = effectiveStatus === 'done'
        setStage('done'); loopStateRef.current = null
        setMessages((prev) => [...prev, { role: 'system', content: ok ? `✅ 任务完成,共 ${st.round} 轮。` : `⚠️ 已达迭代上限(${maxRounds}轮),任务未完全完成。` }])
        return
      }

      // 接近上限预警:倒数第二轮起提醒 LLM 合并收尾
      const budgetWarn = st.round >= maxRounds - 1 ? `\n⚠️ 还剩 ${maxRounds - st.round} 轮就达到预算上限,请把剩余必要操作合并到本轮完成。` : ''

      // 续下一轮(或逐步模式暂停等确认)
      const nextState: LoopState = {
        task: st.task,
        round: st.round + 1,
        observation: obsText + errorNudge + budgetWarn,
        history: [...st.history, { role: 'assistant', content: reply }],
        approved: st.approved,
      }
      if (mode === 'step') {
        setStage('awaiting')
        setMessages((prev) => [...prev, { role: 'system', content: '本轮已执行。继续下一步?' }])
        pendingContinueRef.current = nextState
        return
      }
      loopStateRef.current = nextState
      setStage('thinking')
      void continueLoop()
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return
      setMessages((prev) => [...prev, { role: 'system', content: `出错了:${err instanceof Error ? err.message : '请重试'}` }])
      setStage('error')
      loopStateRef.current = null
      abortRef.current = null
    }
  }, [mode, maxRounds, brainModel, copilotModel, message, ops, runActions, pushTimeline, waitForWorkflowResult, ghostFromActions, setGhost])

  const resumeStep = useCallback(() => {
    const ns = pendingContinueRef.current
    if (!ns) return
    pendingContinueRef.current = null
    loopStateRef.current = ns
    setStage('thinking')
    void continueLoop()
  }, [continueLoop])

  const send = async (textOverride?: string) => {
    const text = (textOverride ?? input).trim()
    if (!text) return
    setInput('')
    pendingContinueRef.current = null
    setPlanActions(null); setClarifyState(null); setGhost(null); setTimeline([]); setCurrentRound(0)
    setStreamingReply('')
    streamValRef.current = { thought: '', reply: '' }
    const userMsg: ChatMsg = { role: 'user', content: text }
    const history = [...messages, userMsg].filter((m) => m.role !== 'system').slice(-10).map((m) => ({ role: m.role, content: m.content }))
    setMessages((prev) => [...prev, userMsg])
    loopStateRef.current = { task: text, round: 1, observation: '', history }
    setStage('thinking')
    void continueLoop()
  }

  const approvePlan = () => {
    const st = loopStateRef.current
    const batch = st?.planBatch
    if (!st || !batch || batch.length === 0) return
    setPlanActions(null); setGhost(null)
    if (mode === 'plan') {
      // 计划模式只审阅:批准后不执行
      setMessages((prev) => [...prev, { role: 'system', content: '计划已批准(仅审阅),未执行。切到 自动/逐步 模式可执行。' }])
      setStage('done'); loopStateRef.current = null
      return
    }
    pushCheckpoint()
    // 执行本批动作
    const r = runActions(batch)
    pushTimeline(r.details)
    // 确认消息带具体动作明细，用户能核对 Copilot 到底做了什么
    const detailText = r.details.length > 0
      ? r.details.slice(0, 8).map((d) => d.replace(/^✓ /, '')).join('；') + (r.details.length > 8 ? ` 等 ${r.details.length} 项` : '')
      : ''
    setMessages((prev) => [...prev, { role: 'assistant', content: `✓ 已执行 ${r.ok} 个操作${detailText ? `：${detailText}` : '。'}` }])
    // 验证 + 续下一轮
    void (async () => {
      setStage('verifying')
      let obsText = r.details.join('、')
      if (batch.some((a) => a.op === 'runWorkflow')) {
        const logs = await waitForWorkflowResult()
        obsText += (obsText ? '\n' : '') + logs
        pushTimeline(logs.split('\n').filter(Boolean).map((l) => `📋 ${l}`))
      }
      await new Promise((res) => setTimeout(res, 0))
      const health = ops.getCanvasHealthCheck?.() || ''
      obsText += (obsText ? '\n' : '') + health
      pushTimeline([`${/\[错误\]/.test(health) ? '🔴' : /警告/.test(health) ? '🟡' : '🟢'} ${health.split('\n')[0]}`])
      const nextState: LoopState = {
        task: st.task,
        round: st.round + 1,
        observation: obsText,
        history: [...st.history, { role: 'assistant', content: '计划已批准,开始执行。' }],
        approved: true,
      }
      if (mode === 'step') {
        setStage('awaiting')
        setMessages((prev) => [...prev, { role: 'system', content: '本轮已执行。继续下一步?' }])
        pendingContinueRef.current = nextState
        return
      }
      loopStateRef.current = nextState
      setStage('thinking')
      void continueLoop()
    })()
  }
  const cancelPlan = () => {
    setPlanActions(null); setGhost(null); loopStateRef.current = null; setStage('idle')
  }

  const answerClarify = (answer: string) => {
    const st = loopStateRef.current
    if (!st) return
    const q = clarifyState
    setClarifyState(null)
    const nextTask = q ? `${st.task}\n[用户回答: ${answer}]` : st.task
    loopStateRef.current = { ...st, task: nextTask, history: [...st.history, { role: 'user', content: `回答: ${answer}` }] }
    setMessages((prev) => [...prev, { role: 'user', content: answer }])
    setStage('thinking')
    void continueLoop()
  }

  const stopLoop = () => {
    abortRef.current?.abort()
    pendingContinueRef.current = null
    setLoadingFalse()
  }
  const setLoadingFalse = () => { setStage('stopped'); loopStateRef.current = null }

  // 手动检查画布
  const handleManualCheck = () => {
    const health = ops.getCanvasHealthCheck?.()
    if (!health) { message.info('当前画布无可用检查'); return }
    setMessages((prev) => [...prev, { role: 'system', content: health }])
  }

  const loading = stage === 'thinking' || stage === 'verifying'
  const awaiting = stage === 'awaiting'

  // 上下文建议条:空画布出模板、有健康错误出修复、有节点出检查/解释
  const quickActions = useMemo(() => {
    const acts: { label: string; msg: string }[] = []
    const state = ops.getCanvasState()
    if (state.nodes.length === 0) {
      acts.push({ label: '电商产品图', msg: '搭电商产品图工作流：图片批量上传产品原图→视觉LLM分析卖点写5个方向提示词(主图/卖点/场景/品牌故事/对比,文案英文)→批量提示词自动展开→每个生图节点参考产品原图生成' })
      acts.push({ label: '简单生图', msg: '搭一个工作流：图片上传→视觉LLM分析→文本预览' })
      acts.push({ label: '人脸漫改流', msg: '搭一个人脸漫改工作流：图片上传→人脸智能涂鸦提取轮廓→图生图风格化重绘' })
    }
    const health = ops.getCanvasHealthCheck?.()
    if (health && /\[错误\]/.test(health)) {
      acts.push({ label: '修复画布', msg: '检查并修复当前画布的健康检查错误（端口/必填/模型），直到全部通过' })
    }
    if (state.nodes.length > 0) {
      acts.push({ label: '整理布局', msg: '自动整理当前画布的节点布局，让连线和层次更清晰' })
      acts.push({ label: '检查画布', msg: '检查当前画布的健康状态，列出所有问题' })
      acts.push({ label: '解释画布', msg: '解释当前画布的工作流结构和每个节点的作用' })
    }
    return acts
  }, [ops])
  const thinkingLabel = stage === 'verifying' ? '正在验证画布…' : `第${currentRound || 1}轮 思考中…`

  // 计划卡可读性：把 createNode 的 tempId 映射为「节点类型」名，连线和设置参数用它代替冷冰冰的 id
  const planAlias = useMemo(() => {
    const m: Record<string, string> = {}
    for (const a of (planActions || [])) if (a.op === 'createNode' && a.tempId) m[a.tempId] = nodeTypeLabel(a.nodeType)
    return m
  }, [planActions])
  const planCreateCount = (planActions || []).filter((a) => a.op === 'createNode').length
  const planConnCount = (planActions || []).filter((a) => a.op === 'connectNodes').length

  const wrapperRef = useRef<HTMLDivElement>(null)
  // 移动端检测：<768px 用底部抽屉，桌面用右下角可拖拽悬浮。
  // mounted 避免 SSR/hydration 时 useState 初始值与客户端不一致（hydration 首帧固定桌面布局，挂载后按真实宽度重渲染）
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const isMobile = mounted && typeof window !== 'undefined' && (window.matchMedia('(max-width: 767px)').matches || window.innerWidth <= 767)
  // 桌面可拖拽：仅水平移动（锁定在最底部一行内），面板从右下角向上展开；位置记忆到浏览器缓存
  const [pos, setPos] = useState<{ right: number; bottom: number }>({ right: 16, bottom: 16 })
  // 挂载后读取缓存位置（避免 SSR/hydration 初始化时序问题）
  useEffect(() => {
    try {
      const saved = readLocalJson<{ right?: number; bottom?: number }>('copilot-capsule-pos', {})
      if (saved && typeof saved.right === 'number' && typeof saved.bottom === 'number') {
        const cw = containerRef?.current?.clientWidth ?? window.innerWidth
        setPos({ right: Math.max(8, Math.min(saved.right, cw - 120)), bottom: Math.max(8, saved.bottom) })
      }
    } catch { /* */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const dragStateRef = useRef<{ startX: number; right: number } | null>(null)
  const dragMovedRef = useRef(false)
  const onPanelDragStart = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    dragStateRef.current = { startX: e.clientX, right: pos.right }
    dragMovedRef.current = false
    const onMove = (ev: PointerEvent) => {
      const ds = dragStateRef.current
      if (!ds) return
      if (Math.abs(ev.clientX - ds.startX) > 3) dragMovedRef.current = true
      const dx = ev.clientX - ds.startX
      const cw = containerRef?.current?.clientWidth ?? window.innerWidth
      setPos((p) => ({ ...p, right: Math.max(8, Math.min(ds.right - dx, cw - 120)) }))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      dragStateRef.current = null
      // 记忆位置到浏览器缓存
      setPos((p) => {
        writeLocalJson('copilot-capsule-pos', p)
        return p
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [pos, containerRef])
  // 半展开(半高，占右下角) / 全展开(全高，顶到画布顶部) / 收起(成胶囊但聊天记录不丢)
  const [expandMode, setExpandMode] = useState<'half' | 'full' | 'collapsed'>('half')
  // 点击展开、按钮关闭（不做悬停展开）
  const [copilotPinned, setCopilotPinned] = useState(false)
  const open = copilotPinned && expandMode !== 'collapsed'
  const copilotClose = () => setCopilotPinned(false)
  // 叉号=收起：面板变回胶囊，copilotPinned 保持 true，聊天记录与执行状态不丢；点胶囊恢复
  const copilotCollapse = () => {
    if (expandMode === 'collapsed') setExpandMode('half') // 从 collapsed 直接关 → 复位为 half 再收起
    else setExpandMode('collapsed')
  }
  // 胶囊点击恢复展开（回到收起前的形态）
  const copilotRestore = () => {
    setExpandMode((m) => (m === 'collapsed' ? 'half' : m))
    setCopilotPinned(true)
  }
  // 胶囊提示语轮播（每 6s 换一条）
  const [tipIdx, setTipIdx] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTipIdx((i) => (i + 1) % TIPS.length), 6000)
    return () => clearInterval(t)
  }, [])

  // 浏览器通知：面板收起或页面在后台时，任务完成/待批准/出错提醒
  // 收敛到 lib/browser-notify。Copilot 原先多一条「面板收起也通知」的规则 ——
  // 用 force 表达（用户收起面板 = 看不到结果，即使页面可见也值得提醒）。
  const notifyRef = useRef<(title: string, body: string) => void>(() => {})
  useEffect(() => {
    notifyRef.current = (title: string, body: string) => notify(title, body, { force: !open })
  }, [open])
  // 阶段变化触发通知
  const prevStageRef = useRef<Stage>('idle')
  useEffect(() => {
    if (prevStageRef.current === stage) return
    prevStageRef.current = stage
    if (stage === 'done') notifyRef.current('创作助手', '任务已完成')
    else if (stage === 'awaiting') notifyRef.current('创作助手', '等待你确认下一步操作')
    else if (stage === 'error') notifyRef.current('创作助手', '执行出错，请查看面板')
  }, [stage])
  // 外部(首页动画/空态引导)进入视为固定展开
  useEffect(() => { if (externalPrompt) setCopilotPinned(true) }, [externalPrompt])

  // 新手引导专用：引导要指「输入框 / 大脑模型」时，面板必须先展开 ——
  // 否则那两个锚点根本不在 DOM 里（引导会退化成居中弹卡，用户看不到任何东西）。
  //
  // 为什么用 window 事件而不是 props：引导（FirstUseGuide）是页面级通用组件，
  // 为它加一条穿透到 CopilotPanel 的 props，会把「通用引导」和「画布」耦合成一体，
  // 以后别的页面想复用引导就得跟着改 CopilotPanel。
  useEffect(() => {
    const onGuideOpen = () => {
      if (isMobile) { setCopilotPinned(true); return }
      setExpandMode((m) => (m === 'collapsed' ? 'half' : m))
      setCopilotPinned(true)
    }
    window.addEventListener(GUIDE_OPEN_COPILOT_EVENT, onGuideOpen)
    return () => window.removeEventListener(GUIDE_OPEN_COPILOT_EVENT, onGuideOpen)
  }, [isMobile])

  return (
    <div
      ref={wrapperRef}
      className={`z-30 flex flex-col overflow-hidden ${
        isMobile
          ? open
            ? 'copilot-panel-open fixed inset-x-0 bottom-0 z-40 w-full max-h-[72vh] rounded-t-3xl rounded-b-none border-t border-white/50 backdrop-blur-xl bg-gradient-to-b from-white/90 to-white/70 shadow-[0_-8px_32px_rgba(2,6,23,0.15)]'
            : 'nav-mobile-capsule fixed bottom-4 right-4 left-16 z-40 h-14 cursor-pointer rounded-full border border-white/50 bg-white/80 shadow-[0_2px_12px_rgba(2,6,23,0.12)] transition-transform duration-150 hover:bg-white/90 hover:shadow-[0_0_24px_rgba(22,119,255,0.35)]'
          : open
            ? (expandMode === 'full'
              ? 'copilot-panel-open absolute w-[480px] max-w-[calc(100%-32px)] top-4 rounded-2xl border border-white/50 backdrop-blur-xl bg-gradient-to-b from-white/85 to-white/65 shadow-[0_8px_32px_rgba(2,6,23,0.12),0_2px_8px_rgba(2,6,23,0.08)]'
              : 'copilot-panel-open absolute h-[52%] w-[480px] max-w-[calc(100%-32px)] rounded-2xl border border-white/50 backdrop-blur-xl bg-gradient-to-b from-white/85 to-white/65 shadow-[0_8px_32px_rgba(2,6,23,0.12),0_2px_8px_rgba(2,6,23,0.08)]')
            : 'absolute cursor-pointer'
      }`}
      style={!isMobile
        ? { right: pos.right, bottom: pos.bottom, ...(open && expandMode === 'full' ? { top: 16 } : {}) }
        : undefined}
      onClick={() => { if (!open && !dragMovedRef.current) copilotRestore() }}
    >
      {/* 顶部高光线（玻璃质感） */}
      {open && <div className="pointer-events-none absolute top-0 inset-x-0 z-10 h-px bg-gradient-to-r from-transparent via-white/90 to-transparent" />}

      {!open && (
        <div
          data-guide="copilot-capsule"
          className="flex items-center gap-3 h-14 w-[320px] max-w-[calc(100vw-24px)] whitespace-nowrap rounded-full border border-white/60 bg-white/80 backdrop-blur-xl shadow-[0_2px_12px_rgba(2,6,23,0.10)] transition-shadow hover:shadow-[0_4px_20px_rgba(125,80,224,0.22)]"
          onPointerDown={!isMobile ? onPanelDragStart : undefined}
        >
          <AnimatedLogo size={30} className="shrink-0 ml-3" />
          {/* 轮播提示语：拖拽位置 / 半屏全屏 / 创作技巧（精简版一行内完整显示，hover 看原句） */}
          <span key={tipIdx} title={TIPS_FULL[tipIdx]} className="min-w-0 flex-1 truncate text-center text-[13px] text-foreground/80 font-medium" style={{ animation: 'tipFadeIn 0.45s ease' }}>
            {TIPS[tipIdx]}
          </span>
          <span className={`h-2 w-2 shrink-0 rounded-full mr-4 ${
            stage === 'thinking' || stage === 'verifying' ? 'bg-primary shadow-[0_0_6px_var(--primary)] animate-pulse'
            : stage === 'done' ? 'bg-success shadow-[0_0_6px_var(--success)]'
            : stage === 'awaiting' ? 'bg-warning-amber shadow-[0_0_6px_var(--warning-amber)] animate-pulse'
            : stage === 'error' || stage === 'stopped' ? 'bg-danger shadow-[0_0_6px_var(--danger)]'
            : 'bg-black/20'
          }`} title={STAGE_LABELS[stage]} />
        </div>
      )}

      {open && (
        <div className="flex flex-col h-full">
          {/* 移动端抽屉顶部把手（点击收起） */}
          {isMobile && (
            <div className="flex shrink-0 justify-center pt-2 pb-1 cursor-pointer" onClick={() => copilotClose()}>
              <span className="h-1.5 w-10 rounded-full bg-black/15" />
            </div>
          )}
          {/* 头部单行：品牌+状态+居中折叠按钮+关闭 */}
          <div className={`shrink-0 border-b border-white/40 bg-gradient-to-r from-accent/10 via-white/30 to-transparent ${!isMobile ? 'cursor-default' : ''}`}>
            <div className="relative flex items-center justify-between px-3 h-11 gap-2">
              <Space size={6}>
                <span
                  className={`flex h-7 w-7 items-center justify-center ${!isMobile ? 'cursor-grab active:cursor-grabbing touch-none' : ''}`}
                  onPointerDown={!isMobile ? onPanelDragStart : undefined}
                  title="拖拽移动面板"
                >
                  <AnimatedLogo size={24} />
                </span>
                {/* 面板模式切换：助手 / 工具（始终显示；无工具时点「工具」给空态指引） */}
                <div className="flex items-center rounded-full bg-black/[0.06] p-0.5">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setPanelMode('copilot') }}
                    className={`flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${panelMode === 'copilot' ? 'bg-white text-accent shadow-sm' : 'text-text-secondary hover:text-foreground'}`}
                  >
                    <MessageOutlined className="text-[10px]" /> 助手
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setPanelMode('tool') }}
                    className={`flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${panelMode === 'tool' ? 'bg-white text-accent shadow-sm' : 'text-text-secondary hover:text-foreground'}`}
                  >
                    <ToolOutlined className="text-[10px]" /> 工具
                  </button>
                </div>
                {/* 助手大脑模型：面板内唯一入口（⚙️ 设置里不再重复出现），点开即可切换 */}
                <Tooltip title="助手大脑模型：理解你的指令并规划工作流；留空则自动挑选">
                  <Select
                    id="copilot-brain"
                    size="small"
                    variant="borderless"
                    value={brainModel || ''}
                    onChange={(v) => setBrainModel(v || '')}
                    popupMatchSelectWidth={210}
                    suffixIcon={<DownOutlined className="text-[9px]" />}
                    className="!text-[11px] !min-w-[92px] max-w-[150px] !rounded-full bg-black/[0.04] hover:bg-black/[0.08]"
                    options={[
                      { value: '', label: '自动选模型' },
                      ...(modelOptions || []).filter((m) => m.type === 'TEXT' || m.type === 'VISION').map((m) => ({ value: m.id, label: modelLabel(m) })),
                    ]}
                  />
                </Tooltip>
              </Space>
              {/* 居中：折叠形态切换（折线向上=全屏，折线向下=半屏）——绝对定位保证真正居中 */}
              {!isMobile && (
                <Tooltip title={expandMode === 'full' ? '收起为半屏' : '展开为全屏'}>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setExpandMode((m) => (m === 'full' ? 'half' : 'full')) }}
                    className="absolute left-1/2 -translate-x-1/2 grid h-7 w-9 place-items-center rounded-md text-text-secondary hover:bg-black/[0.06] hover:text-accent transition-colors"
                    aria-label={expandMode === 'full' ? '收起为半屏' : '展开为全屏'}
                  >
                    {/* 折线图标：全屏时折角向下，半屏时折角向上 */}
                    <svg width="18" height="10" viewBox="0 0 18 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      {expandMode === 'full' ? (
                        <>
                          <polyline points="2,2 9,8 16,2" />
                          <line x1="1" y1="9.4" x2="17" y2="9.4" opacity="0.45" />
                        </>
                      ) : (
                        <>
                          <polyline points="2,8 9,2 16,8" />
                          <line x1="1" y1="0.6" x2="17" y2="0.6" opacity="0.45" />
                        </>
                      )}
                    </svg>
                  </button>
                </Tooltip>
              )}
              <Space size={2}>
                {/* 状态胶囊 */}
                <span className={`flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border font-medium ${
                  stage === 'done' ? 'text-success border-success/40 bg-success-bg'
                  : stage === 'awaiting' ? 'text-warning-strong border-warning-amber/50 bg-warning-bg animate-pulse'
                  : stage === 'verifying' ? 'text-primary border-primary/40 bg-primary-light'
                  : stage === 'error' || stage === 'stopped' ? 'text-danger border-danger/40 bg-danger/10'
                  : stage === 'thinking' ? 'text-primary border-primary/40 bg-primary-light'
                  : 'text-text-secondary border-text-disabled bg-white/70'
                }`}>
                  {stage === 'thinking' && (
                    <span className="flex gap-0.5">
                      <span className="copilot-thinking-dot" /><span className="copilot-thinking-dot" style={{ animationDelay: '150ms' }} /><span className="copilot-thinking-dot" style={{ animationDelay: '300ms' }} />
                    </span>
                  )}
                  {stage === 'verifying' && <LoadingOutlined className="animate-spin" />}
                  {stage === 'done' && <CheckOutlined />}
                  {(stage === 'error' || stage === 'stopped') && <CloseOutlined />}
                  {stage === 'awaiting' && <QuestionCircleOutlined />}
                  {STAGE_LABELS[stage]}
                </span>
                <Button type="text" size="small" icon={<CloseOutlined />} onClick={(e) => { e.stopPropagation(); copilotCollapse() }} title="收起为胶囊（聊天记录保留）" />
              </Space>
            </div>
          </div>

          {/* 面板模式：工具 → 渲染工具内容（无打开的工具给空态指引）；助手 → 渲染聊天内容 */}
          {panelMode === 'tool' ? (
            toolState && onToolRun ? (
              <ToolPanelContent
                tool={toolState.tool}
                nodeIds={toolState.nodeIds}
                getNode={(cid) => {
                  const ns = ops.getCanvasState().nodes as Array<{ id: string; type: string; category?: string; label?: string; inputs: Record<string, unknown> }> | undefined
                  const n = ns?.find((x) => x.id === cid)
                  return n ? { type: n.type, category: n.category || '', inputs: n.inputs, label: n.label } : undefined
                }}
                modelOptions={toolModelOptions || modelOptions}
                modelsLoading={toolModelsLoading}
                outputs={toolOutputs || {}}
                running={stage === 'thinking' || stage === 'verifying'}
                onRun={onToolRun}
              />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
                <span className="grid place-items-center w-12 h-12 rounded-2xl bg-accent/10 text-accent text-xl"><ToolOutlined /></span>
                <Text className="text-xs font-medium">当前没有打开的工具</Text>
                <Text className="text-[11px] text-text-secondary leading-relaxed">顶部「工具库」选择一个工具使用；<br />工具面板会在这里打开，可一键输入并运行</Text>
              </div>
            )
          ) : (
            <>
          <div ref={scrollRef} className="flex-1 overflow-y-auto aigc-hub-scrollbar p-3 space-y-2.5 min-h-0">
            {/* 按时间顺序渲染：思考单行流水框 + 执行时间线条目穿插在其对应轮次回答之前 */}
            {messages.map((m, i) => (
              <div key={i} className="space-y-2.5">
                {thoughtRows.filter((r) => r.anchor === i).map((r) => <ThoughtLine key={r.id} text={r.text} />)}
                {/* 时间线散入聊天流：anchor 指向本条消息的条目逐条平铺（不再包小框） */}
                {timeline.filter((t) => (t.anchor ?? 0) === i).map((t) => {
                  const raw = t.text
                  const icon = raw.startsWith('✗') ? <CloseOutlined className="text-danger text-[10px] mt-0.5" />
                    : raw.startsWith('✓') ? <CheckOutlined className="text-success text-[10px] mt-0.5" />
                    : raw.startsWith('▶') ? <PlayCircleOutlined className="text-accent text-[10px] mt-0.5" />
                    : raw.startsWith('📋') ? <FileTextOutlined className="text-text-secondary text-[10px] mt-0.5" />
                    : raw.startsWith('🔴') ? <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-danger" />
                    : raw.startsWith('🟡') ? <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-warning-amber" />
                    : raw.startsWith('🟢') ? <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-success" />
                    : <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-text-disabled" />
                  return (
                    <div key={t.id} className="flex items-start gap-1.5 pl-4 text-[11px] leading-relaxed">
                      {icon}
                      <span className="text-text-muted whitespace-pre-wrap">{stripDecor(raw)}</span>
                    </div>
                  )
                })}
                {m.role === 'assistant' ? (
                  <div className="pl-1">
                    <Markdown className="!text-xs">{stripDecor(m.content)}</Markdown>
                  </div>
                ) : (
                  <div className={`text-xs whitespace-pre-wrap leading-relaxed ${
                    m.role === 'user'
                      ? 'text-right text-accent font-medium pr-1'
                      : 'text-text-secondary text-[11px] border-l-2 border-info/40 pl-2 py-0.5'
                  }`}>
                    {stripDecor(m.content)}
                  </div>
                )}
              </div>
            ))}
            {/* 进行中的当前轮思考行 + 时间线条目（anchor 落在消息末尾之后） */}
            {thoughtRows.filter((r) => r.anchor >= messages.length).map((r) => <ThoughtLine key={r.id} text={r.text} />)}
            {timeline.filter((t) => (t.anchor ?? 0) >= messages.length).map((t) => {
              const raw = t.text
              const icon = raw.startsWith('✗') ? <CloseOutlined className="text-danger text-[10px] mt-0.5" />
                : raw.startsWith('✓') ? <CheckOutlined className="text-success text-[10px] mt-0.5" />
                : raw.startsWith('▶') ? <PlayCircleOutlined className="text-accent text-[10px] mt-0.5" />
                : raw.startsWith('📋') ? <FileTextOutlined className="text-text-secondary text-[10px] mt-0.5" />
                : raw.startsWith('🔴') ? <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-danger" />
                : raw.startsWith('🟡') ? <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-warning-amber" />
                : raw.startsWith('🟢') ? <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-success" />
                : <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-text-disabled" />
              return (
                <div key={t.id} className="flex items-start gap-1.5 pl-4 text-[11px] leading-relaxed">
                  {icon}
                  <span className="text-text-muted whitespace-pre-wrap">{stripDecor(raw)}</span>
                </div>
              )
            })}

            {/* 流式回复（实时打字机）：LLM JSON 流中提取 reply 实时渲染 */}
            {streamingReply && (
              <div className="text-xs text-foreground whitespace-pre-wrap leading-relaxed pl-1">
                {streamingReply}
                <span className="inline-block w-0.5 h-3 bg-primary align-middle ml-0.5 animate-pulse" />
              </div>
            )}

            {/* 阶段提示（等待确认等） */}
            {loading && (
              <div className="flex items-center gap-2 text-xs text-text-secondary pl-1">
                <span className="flex gap-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary copilot-thinking-dot" />
                  <span className="w-1.5 h-1.5 rounded-full bg-primary copilot-thinking-dot" style={{ animationDelay: '200ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-primary copilot-thinking-dot" style={{ animationDelay: '400ms' }} />
                </span>
                {thinkingLabel}
              </div>
            )}

            {/* 逐步模式:暂停续跑 */}
            {mode === 'step' && awaiting && !planActions && !clarifyState && (
              <div className="flex justify-center gap-2">
                <Button size="small" type="primary" onClick={resumeStep}>继续下一步</Button>
                <Button size="small" onClick={stopLoop}>停止</Button>
              </div>
            )}
          </div>

          {/* 固定区：计划卡/澄清卡（思考流水已移入消息流，每轮独立一行） */}
          <div className="shrink-0 border-t border-white/30">
            {planActions && planActions.length > 0 && (
              <div className="px-3 pt-2 pb-1">
                <div className="rounded-xl border border-warning-amber/50 bg-gradient-to-br from-warning-bg/90 to-white/60 backdrop-blur-md p-3 space-y-2 shadow-sm">
                  <div className="flex items-center justify-between">
                    <Text className="text-xs font-semibold text-warning-deep"><FileTextOutlined /> 即将执行{planCreateCount > 0 && ` · 新建 ${planCreateCount} 个节点`}{planConnCount > 0 && ` · ${planConnCount} 条连线`}</Text>
                    <Text className="text-[10px] text-text-secondary">批准后生效</Text>
                  </div>
                  <div className="space-y-1">
                    {planActions.map((a, i) => (
                      <div key={i} className="flex items-start gap-1.5 text-xs text-text-muted">
                        <CheckOutlined className="text-success mt-0.5" />
                        <span className="flex-1">{describeAction(a, planAlias)}</span>
                      </div>
                    ))}
                  </div>
                  {awaiting && (
                    <div className="flex gap-2 pt-1">
                      <Button size="small" type="primary" icon={<CheckOutlined />} onClick={approvePlan}>
                        {mode === 'plan' ? '审阅完成' : '批准并执行'}
                      </Button>
                      <Button size="small" onClick={cancelPlan}>取消</Button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {clarifyState && (
              <div className="px-3 pt-2 pb-1">
                <div className="rounded-xl border border-primary/40 bg-gradient-to-br from-primary-light/90 to-white/60 backdrop-blur-md p-3 space-y-2">
                  <Text className="text-xs text-primary"><QuestionCircleOutlined /> {clarifyState.question}</Text>
                  <div className="flex flex-wrap gap-1.5">
                    {clarifyState.options?.map((opt) => (
                      <Button key={opt} size="small" shape="round" onClick={() => answerClarify(opt)}>{opt}</Button>
                    ))}
                  </div>
                </div>
              </div>
            )}

          </div>

          {/* 输入区：输入框为主体；模式/设置/预算收进输入框下方一行。
              移动端展开态铺满底边，而 NavRail 悬浮球固定在左下角 —— 左侧补一段内边距避让，
              否则球会压住这里的输入框与模式按钮（桌面端没有悬浮球，pl 归零）。 */}
          <div className="border-t border-white/30 p-3 shrink-0 max-md:pl-[68px]">
            {!loading && !awaiting && quickActions.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {quickActions.map((a) => (
                  <Button key={a.label} size="small" className="text-[11px] text-accent bg-accent-light/70 border-accent/25 rounded-full" onClick={() => send(a.msg)}>
                    {a.label}
                  </Button>
                ))}
              </div>
            )}
            {/* 输入框：右端一体化发送/暂停按钮（执行中变暂停，不再出现独立停止按钮） */}
            <div className="rounded-xl bg-black/[0.04] ring-1 ring-black/[0.04] px-3 py-1.5 transition-colors focus-within:ring-accent/40">
              <div className="flex items-end gap-2">
                <Input.TextArea
                  id="copilot-input"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); send() } }}
                  placeholder={awaiting ? '等待你确认…' : '描述你想做的事…'}
                  autoSize={{ minRows: 1, maxRows: 4 }}
                  disabled={loading || awaiting}
                  variant="borderless"
                  className="text-xs flex-1 min-w-0"
                />
                {loading ? (
                  <Tooltip title="暂停执行">
                    <Button type="primary" size="small" danger shape="circle" icon={<PauseOutlined />} onClick={stopLoop} className="shrink-0 mb-0.5" />
                  </Tooltip>
                ) : (
                  <Button type="primary" size="small" shape="circle" icon={<ArrowUpOutlined />} onClick={() => send()} disabled={!input.trim() || awaiting} className="shrink-0 mb-0.5" />
                )}
              </div>
            </div>
            {/* 模式/轮次/回退/设置 合并同一行：提高面板利用率，不再单独占一行 */}
            <div className="flex items-center justify-between mt-1.5 px-0.5">
              <div className="flex items-center gap-1.5 min-w-0">
                <Dropdown
                  trigger={['click']}
                  placement="topLeft"
                  menu={{
                    selectedKeys: [mode],
                    items: [
                      { key: 'chat', icon: <MessageOutlined />, label: '对话（只答不改）' },
                      { key: 'plan', icon: <FileTextOutlined />, label: '计划（只出计划审阅）' },
                      { key: 'step', icon: <EyeOutlined />, label: '逐步（批准后逐步执行）' },
                      { key: 'auto', icon: <ThunderboltOutlined />, label: '自动（批准后自动执行）' },
                    ],
                    onClick: ({ key }: { key: string }) => setMode(key as CopilotMode),
                  }}
                >
                  <Button type="text" size="small" className="text-[11px] text-text-secondary !px-2">
                    <span className="flex items-center gap-1">
                      <ThunderboltOutlined className="text-accent" />
                      {MODE_LABELS[mode]}
                      <DownOutlined className="text-[9px] text-text-disabled" />
                    </span>
                  </Button>
                </Dropdown>
                {/* 轮次进度：细条 + 数字，与模式同行 */}
                <Tooltip title={`本轮任务进度：第 ${currentRound || 1} / ${maxRounds} 轮`}>
                  <div className="flex items-center gap-1 shrink-0 cursor-default">
                    <div className="h-0.5 w-6 rounded-full bg-black/10 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${(currentRound || 1) >= maxRounds - 1 ? 'bg-warning-amber' : 'bg-accent'}`}
                        style={{ width: `${Math.min(100, ((currentRound || 1) / maxRounds) * 100)}%` }}
                      />
                    </div>
                    <Text className="text-[9px] text-text-disabled">{currentRound || 1}/{maxRounds}轮</Text>
                  </div>
                </Tooltip>
              </div>
              <Space size={0}>
                {checkpoints.length > 0 && (
                  <Tooltip title="回退到上一步（撤销本次任务对画布的改动）">
                    <Button type="text" size="small" icon={<UndoOutlined />} onClick={rewind} className="text-text-secondary !px-2" />
                  </Tooltip>
                )}
                <Popover
                  trigger="click"
                  placement="topRight"
                  content={(
                    <div className="flex flex-col gap-2 w-64">
                      <Text className="text-xs text-text-secondary">节点默认模型（新建节点时预填，留空自动选）</Text>
                      <Select size="small" value={copilotModel || undefined} onChange={setCopilotModel} showSearch optionFilterProp="label" options={[{ value: '', label: '自动选' }, ...modelOptions.map((m) => ({ value: m.id, label: modelLabel(m) }))]} />
                      <Text className="text-xs text-text-secondary">图像识别模型(视觉理解)</Text>
                      <Select size="small" value={visionModel || undefined} onChange={setVisionModel} showSearch optionFilterProp="label" options={[{ value: '', label: '自动选' }, ...modelOptions.filter((m) => m.type === 'VISION').map((m) => ({ value: m.id, label: modelLabel(m) }))]} />
                      <Text className="text-xs text-text-secondary">生图模型</Text>
                      <Select size="small" value={imageModel || undefined} onChange={setImageModel} showSearch optionFilterProp="label" options={[{ value: '', label: '自动选' }, ...modelOptions.filter((m) => m.type === 'IMAGE').map((m) => ({ value: m.id, label: modelLabel(m) }))]} />
                      <Text className="text-xs text-text-secondary">视频模型</Text>
                      <Select size="small" value={videoModel || undefined} onChange={setVideoModel} showSearch optionFilterProp="label" options={[{ value: '', label: '自动选' }, ...modelOptions.filter((m) => m.type === 'VIDEO').map((m) => ({ value: m.id, label: modelLabel(m) }))]} />
                      <Text className="text-xs text-text-secondary">轮次预算(每轮消耗积分)</Text>
                      <Segmented size="small" value={maxRounds} onChange={(v) => setMaxRounds(Number(v))} options={[{ value: 5, label: '5 快' }, { value: 8, label: '8 标准' }, { value: 12, label: '12 深度' }]} />
                      <Button size="small" onClick={handleManualCheck}>检查画布</Button>
                    </div>
                  )}
                >
                  <Button type="text" size="small" icon={<SettingOutlined />} className="text-text-secondary !px-2" />
                </Popover>
              </Space>
            </div>
          </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
