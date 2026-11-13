'use client'

/**
 * 工具页右侧「智能体（Agent）模式」面板
 * - 多轮对话（SSE 流式）+ 计划卡片 + 子任务状态
 * - Skills 多选（代码内置清单，注入 planner prompt）
 * - 图片上传走 ensureServerUrl 统一通道
 * - 生成产物由后端 media 事件直接写入左侧成果区（useToolRunStore）
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { App as AntApp, Button, Input, Spin, Popover } from 'antd'
import {
  PaperClipOutlined, ThunderboltFilled, CloseOutlined,
  RobotOutlined, CheckCircleFilled, CloseCircleFilled, LoadingOutlined,
  PlusOutlined, HistoryOutlined, AppstoreOutlined, SettingOutlined, EditOutlined, DeleteOutlined,
  StopOutlined, ZoomInOutlined, ClockCircleOutlined, ReloadOutlined,
} from '@ant-design/icons'
import { Markdown } from '@/components/ui/Markdown'
import { ImageLightbox } from '@/components/ui/ImageLightbox'
import { AGENT_SKILLS, AGENT_SKILL_GROUPS, skillForToolSlug } from '@/lib/agent-skills'
import { consumeSseStream } from '@/lib/sse'
import { createAgentStreamHandler } from '@/components/tools/agent-stream-handler'
import { apiFetch } from '@/lib/api-client'
import { notify, requestNotifyPermission } from '@/lib/browser-notify'
import { useToolRunStore } from '@/stores/useToolRunStore'
import { ensureServerUrl } from '@/lib/ensure-server-url'
import AgentPrefsDrawer from '@/components/tools/AgentPrefsDrawer'
import { CreateModePicker, type CreateMode } from './CreateModePicker'
import { friendlyLlmError } from '@/lib/friendly-llm-error'

// 消息形状与归一化统一放在 @/lib/agent-message —— 实时 SSE 与历史回显
// 必须共用同一套映射，否则两边会继续漂移（历史丢 decisions/plan 就是这么来的）。
import {
  messageFromHistoryRecord,
  resolveVideoPlanSteps,
  normalizeAskQuestions,
  composeAnswerMessage,
  normalizeDecisions,
  normalizePendingActions,
  type AgentMessage,
} from '@/lib/agent-message'

/**
 * 剥掉 reply 里「问题 + 选项」那段，只留引导语。
 *
 * 用于「已有结构化选项卡片」的场景 —— 否则同一份问题会被渲染两遍。
 * 兼容历史数据：修复前存下的 reply 已经带着拼好的问题文字，改不了库，
 * 只能渲染时裁掉。
 */
function stripAskQuestionBody(reply: string): string {
  if (!reply) return ''
  // 引导语之后就是问题列表；没有引导语时整段都是问题描述，返回空
  const m = reply.split('需要确认几点，麻烦回复一下：')
  if (m.length > 1) return m[0] + '需要确认几点，麻烦回复一下：'
  return ''
}

/** 空状态快捷起手的技能（其余仍走「技能」选择器） */
const QUICK_SKILL_IDS = ['ru-market', 'pdd-suite', 'ecom-main', 'ecom-scene', 'ecom-showcase-video', 'handraw', 'upscale']

/**
 * toolSlug 用于推断默认技能（见 skillForToolSlug）：
 * 从某个工具页切到智能体，默认带上该领域技能，用户仍可自行增删。
 *
 * initialPrompt：首页「Agent」入口 / 导航「Agent」深链带来的想法（?prompt=xxx），
 * 预填进输入框（不自动发送 —— 让用户确认后再发，避免误触直接扣费）。
 */
type Props = { toolSlug: string; initialPrompt?: string; createMode?: CreateMode; onCreateModeChange?: (mode: CreateMode) => void }

export default function ToolAgentPanel({ toolSlug, initialPrompt, createMode, onCreateModeChange }: Props) {
  const resultStates = useToolRunStore((state) => state.results)
  const { message } = AntApp.useApp()
  const [input, setInput] = useState(initialPrompt || '')
  // 深链带来的想法只在「本次挂载」预填一次：后续用户清空/改写不被 URL 拉回去。
  const promptConsumedRef = useRef(false)
  useEffect(() => {
    if (promptConsumedRef.current) return
    promptConsumedRef.current = true
    if (initialPrompt) setInput((cur) => (cur ? cur : initialPrompt))
  }, [initialPrompt])
  // 初值 = 当前工具的默认技能；用户后续的增删都以 state 为准
  const [selectedSkills, setSelectedSkills] = useState<string[]>(() => {
    const d = skillForToolSlug(toolSlug)
    return d ? [d] : []
  })
  const [images, setImages] = useState<string[]>([])
  // 图片放大灯箱（用户上传图 / 助手回复里的图共用）
  const [lightbox, setLightbox] = useState<{ open: boolean; urls: string[]; index: number }>({ open: false, urls: [], index: 0 })
  const [uploadingCount, setUploadingCount] = useState(0)
  const [sending, setSending] = useState(false)
  /** 每条消息的修订输入框内容 / 提交中状态（按消息 id 隔离） */
  const [reviseText, setReviseText] = useState<Record<string, string>>({})
  const [reviseBusy, setReviseBusy] = useState<Record<string, boolean>>({})
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [showSkillPicker, setShowSkillPicker] = useState(false)
  const [showPrefs, setShowPrefs] = useState(false)
  // 已作答的问题：key = 消息id + 问题下标，值是用户选的文案。
  // 用于把选项块切成"已选择"只读态，避免用户重复点、也保留他的选择痕迹。
  const [answered, setAnswered] = useState<Record<string, string>>({})
  // 该消息的选项是否已提交过：多题模式下「选完一起发」，提交后整块锁定，避免重复发
  const [sentAsk, setSentAsk] = useState<Record<string, boolean>>({})
  const [historyList, setHistoryList] = useState<{ id: string; title: string; preview: string; updatedAt: string }[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const activeTaskIdRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<React.ComponentRef<typeof Input.TextArea>>(null)
  // 上一次的工具 slug：用于判断用户是否手动改过技能（切工具时决定要不要重置）
  const prevToolSlugRef = useRef<string | null>(toolSlug)

  // 当前工具对应的默认技能：从「俄区套图」工具进来就自动带上俄区套图技能，
  // 省掉"在工具页说了一遍、到 Agent 又要再选一次"的重复表达。
  // 用惰性初始值而不是 effect setState：effect 里 setState 会多渲染一轮，
  // 且 eslint 的 set-state-in-effect 直接报错。
  const defaultSkillId = skillForToolSlug(toolSlug)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])


  // 切换工具：技能与默认值跟着换（同页切工具时 lazy init 不会重跑，必须显式同步）
  useEffect(() => {
    setSelectedSkills((prev) => {
      const prevDefault = skillForToolSlug(prevToolSlugRef.current)
      // 用户手动改过（当前选择 ≠ 上个工具的默认值）→ 完全尊重用户，不重置
      const untouched = prev.length === 0 || (prevDefault !== null && prev.length === 1 && prev[0] === prevDefault)
      if (!untouched) return prev
      return defaultSkillId ? [defaultSkillId] : []
    })
    prevToolSlugRef.current = toolSlug
  }, [toolSlug, defaultSkillId])

  // 技能按分组归类：选择器按组展示（同组连续、组名可见），不再是一条无结构长列表
  const skillGroups = AGENT_SKILL_GROUPS.map((g) => ({
    group: g,
    items: AGENT_SKILLS.filter((s) => s.group === g),
  })).filter((g) => g.items.length > 0)
  // 已选技能对象：输入区常驻 chips，避免"选了但看不见"
  const selectedSkillObjs = AGENT_SKILLS.filter((s) => selectedSkills.includes(s.id))
  // 空状态快捷起手：只放最常用的几个，全量仍在「技能」弹层里
  const quickSkills = AGENT_SKILLS.filter((s) => QUICK_SKILL_IDS.includes(s.id))

  // ---- 上传：三种入口（按钮/粘贴/拖拽）统一走共用实现 ----
  // 底层与工具面板、批量处理同一份 ensureServerUrl，不各写一套。
  const handleUpload = useCallback(async (file: File) => {
    setUploadingCount((c) => c + 1)
    try {
      const blobUrl = URL.createObjectURL(file)
      const serverUrl = await ensureServerUrl(blobUrl)
      URL.revokeObjectURL(blobUrl)
      setImages((prev) => [...prev, serverUrl])
    } catch (err) {
      message.error(err instanceof Error ? err.message : '图片上传失败')
    } finally {
      setUploadingCount((c) => Math.max(0, c - 1))
    }
    return false
  }, [message])


  const toggleSkill = (id: string) => {
    setSelectedSkills((prev) => prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id])
  }

  // ---- 发送 ----
  const send = useCallback(async (extraText?: string) => {
    const typed = input.trim()
    // 点选项作答时，输入框可能是空的 —— 把选项文本作为额外内容拼进来
    const prompt = [typed, extraText?.trim()].filter(Boolean).join('\n')
    if (!prompt || sending) return
    if (uploadingCount > 0) { message.warning('图片正在上传，请稍候'); return }

    setSending(true)
    const userMsgId = `u-${Date.now()}`
    const assistantMsgId = `a-${Date.now()}`
    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: 'user', content: prompt, status: 'done', images: images.length > 0 ? [...images] : undefined },
      { id: assistantMsgId, role: 'assistant', content: '', status: 'pending' },
    ])
    setInput('')
    const sentImages = [...images]
    setImages([])

    // 在「用户点了发送」这个手势里请求通知权限 —— 浏览器对非手势调用不信任，
    // 放在这里成功率最高（用户拒绝过则内部直接返回 false，不再骚扰）。
    void requestNotifyPermission()

    const controller = new AbortController()
    abortRef.current = controller
    activeTaskIdRef.current = null

    // --- SSE 事件 → 气泡 / 成果区 ---
    const patchAssistant = (patch: Partial<AgentMessage>) => {
      setMessages((prev) => prev.map((m) => (m.id === assistantMsgId ? { ...m, ...patch } : m)))
    }
    // 事件处理与 confirm 路径**共用同一份实现**（见 agent-stream-handler.ts）。
    // 内联一份、confirm 再抄一份，必然漂移 —— 本项目已经反复吃过这个亏。
    const { handleEvent, isDone } = createAgentStreamHandler({
      assistantMsgId,
      patchAssistant,
      setSessionId,
      setTaskId: (id) => {
        activeTaskIdRef.current = id
        patchAssistant({ taskId: id })
      },
    })

    try {
      const res = await fetch('/api/agent/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        signal: controller.signal,
        body: JSON.stringify({
          mode: 'smart',
          prompt,
          images: sentImages.length > 0 ? sentImages : undefined,
          skillIds: selectedSkills.length > 0 ? selectedSkills : undefined,
          sessionId: sessionId || undefined,
        }),
      })
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null)
        throw new Error(j?.message || `请求失败 (${res.status})`)
      }
      await consumeSseStream(res.body, handleEvent, { signal: controller.signal })
      if (!isDone()) patchAssistant({ status: 'done' })
    } catch (err) {
      if (controller.signal.aborted) {
        patchAssistant({ status: 'done', content: '（已取消）' })
      } else {
        patchAssistant({ status: 'failed', error: friendlyLlmError(err instanceof Error ? err.message : '请求失败') })
      }
    } finally {
      setSending(false)
      abortRef.current = null
      activeTaskIdRef.current = null
    }
  }, [input, sending, uploadingCount, images, selectedSkills, sessionId, message])

  const stop = useCallback(async () => {
    const taskId = activeTaskIdRef.current
    if (taskId) {
      try {
        const res = await apiFetch(`/api/agent/tasks/${taskId}/cancel`, { method: 'POST' })
        if (!res.success) message.warning(res.message || '服务端取消请求未成功，正在断开连接')
      } catch {
        message.warning('服务端取消请求失败，正在断开连接')
      }
    }
    abortRef.current?.abort()
    setSending(false)
  }, [message])

  /**
   * 用户点了某个选项：把「问题 + 选择」拼成一条自然语言回复直接发出。
   *
   * 为什么拼文字而不是回传结构化选择：
   *   下游是同一个 Agent（走 LLM 理解），把选择写成「问题：X \n 我的选择：Y」
   *   它既知道回答的是哪个问题、也能从这句话继续规划，不需要另开一条"选择题协议"。
   *   多题一起答时按题拼接，一次发完（与 ask_user 的"一次问完"对齐）。
   */
  const answerQuestion = useCallback((msgId: string, qIndex: number, text: string) => {
    if (sending || sentAsk[msgId]) return
    const msg = messages.find((m) => m.id === msgId)
    const q = msg?.askQuestions?.[qIndex]
    if (!q) return
    setAnswered((prev) => ({ ...prev, [`${msgId}:${qIndex}`]: text }))
    // 单题：点上即作答，保留一步到位的手感；多题：只记录，等「发送回答」统一提交
    if (msg?.askQuestions?.length === 1) {
      setSentAsk((prev) => ({ ...prev, [msgId]: true }))
      void send(composeAnswerMessage([q], { 0: text }))
    }
  }, [messages, sending, sentAsk, send])

  // 多题模式：把所有已作答的选项按题拼成一条消息，一次发完（与 ask_user「一次问完」对齐）
  const submitAnswers = useCallback((msgId: string) => {
    if (sending || sentAsk[msgId]) return
    const msg = messages.find((m) => m.id === msgId)
    const qs = msg?.askQuestions
    if (!msg || !qs || qs.length === 0) return
    const pickedMap: Record<number, string | undefined> = {}
    qs.forEach((_q, i) => { pickedMap[i] = answered[`${msgId}:${i}`] })
    const composed = composeAnswerMessage(qs, pickedMap)
    if (!composed) return
    setSentAsk((prev) => ({ ...prev, [msgId]: true }))
    void send(composed)
  }, [messages, sending, sentAsk, answered, send])

  // ---- confirm 模式：确认执行 / 放弃 ----
  //
  // 为什么不是「点确认后在本页重发一次」：后端在有待确认项时把任务置 PAUSED
  // 并把计划落了库（刷新/重启都不丢），确认只是让那条**已存在的**任务继续跑。
  // 重发会重新规划、再花一次规划费，且可能规划出不一样的东西 ——
  // 用户确认的必须是它看到的那份计划。
  const resolvePending = useCallback(async (msgId: string, taskId: string, action: 'confirm' | 'cancel') => {
    if (!taskId) return
    // 立刻收起确认卡，避免重复点击
    setMessages((prev) => prev.map((x) => (x.id === msgId ? { ...x, pendingActions: undefined } : x)))

    // ---- 放弃：一个普通 POST 就够（不执行任何东西）----
    if (action === 'cancel') {
      try {
        const res = await apiFetch(`/api/agent/tasks/${taskId}/confirm`, {
          method: 'POST',
          body: JSON.stringify({ action }),
        })
        if (res.success) {
          setMessages((prev) => prev.map((x) => (x.id === msgId ? { ...x, content: '已取消，未产生任何花费。' } : x)))
        } else {
          message.error(res.message || '操作失败')
        }
      } catch { message.error('操作失败，请重试') }
      return
    }

    // ---- 确认执行：消费 SSE 流 ----
    //
    // 为什么必须走流：执行期要实时把「排队占位 / 等待派发 / 生成中 / 出图」
    // 推给成果区。用一次性 JSON 的话用户只能等全部生成完才看到东西
    // （这正是之前报的 bug）。事件处理复用 send() 那份共享实现。
    setSending(true)
    const controller = new AbortController()
    abortRef.current = controller
    activeTaskIdRef.current = taskId
    const patchAssistant = (patch: Partial<AgentMessage>) => {
      setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, ...patch } : m)))
    }
    const { handleEvent, isDone } = createAgentStreamHandler({
      assistantMsgId: msgId,
      patchAssistant,
      setSessionId,
      setTaskId: (id) => {
        activeTaskIdRef.current = id
        patchAssistant({ taskId: id })
      },
    })

    try {
      const res = await fetch(`/api/agent/tasks/${taskId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        signal: controller.signal,
        body: JSON.stringify({ action: 'confirm' }),
      })
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null)
        throw new Error(j?.message || `执行失败 (${res.status})`)
      }
      await consumeSseStream(res.body, handleEvent, { signal: controller.signal })
      if (!isDone()) patchAssistant({ status: 'done' })
    } catch (err) {
      if (controller.signal.aborted) {
        patchAssistant({ status: 'done', content: '（已取消）' })
      } else {
        patchAssistant({ status: 'failed', error: friendlyLlmError(err instanceof Error ? err.message : '执行失败') })
      }
    } finally {
      setSending(false)
      abortRef.current = null
      activeTaskIdRef.current = null
    }
  }, [message])

  // ---- 从检查点继续 ----
  //
  // 失败任务已经有持久化 checkpoint 时，不重发用户需求、不重新规划已完成轮次。
  // 服务端沿用原 taskId 和素材编号继续执行，避免用户为同一件事重复等待。
  const resumeTask = useCallback(async (msgId: string, taskId: string) => {
    if (!taskId || sending) return
    setSending(true)
    const controller = new AbortController()
    abortRef.current = controller
    activeTaskIdRef.current = taskId
    const patchAssistant = (patch: Partial<AgentMessage>) => {
      setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, ...patch } : m)))
    }
    patchAssistant({ status: 'pending', error: undefined, taskId })
    const { handleEvent, isDone } = createAgentStreamHandler({
      assistantMsgId: msgId,
      patchAssistant,
      setSessionId,
      setTaskId: (id) => {
        activeTaskIdRef.current = id
        patchAssistant({ taskId: id })
      },
    })

    try {
      const res = await fetch(`/api/agent/tasks/${taskId}/resume`, {
        method: 'POST',
        credentials: 'include',
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null)
        throw new Error(j?.message || `继续执行失败 (${res.status})`)
      }
      await consumeSseStream(res.body, handleEvent, { signal: controller.signal })
      if (!isDone()) patchAssistant({ status: 'done' })
    } catch (err) {
      if (controller.signal.aborted) {
        patchAssistant({ status: 'done', content: '（已取消）' })
      } else {
        patchAssistant({ status: 'failed', error: friendlyLlmError(err instanceof Error ? err.message : '继续执行失败') })
      }
    } finally {
      setSending(false)
      abortRef.current = null
      activeTaskIdRef.current = null
    }
  }, [sending])

  // ---- confirm 模式：让 Agent 按用户意见重新规划 ----
  //
  // 用户不该自己编辑提示词（不懂 prompt 工程，改出来往往更差）。
  // 正确的抽象是：他说大白话要改什么，模型拿着「上一版 + 这条意见」重排。
  const revisePending = useCallback(async (msgId: string, taskId: string, note: string) => {
    const text = note.trim()
    if (!taskId || !text) return
    setReviseBusy((prev) => ({ ...prev, [msgId]: true }))
    try {
      const res = await apiFetch(`/api/agent/tasks/${taskId}/revise`, {
        method: 'POST',
        body: JSON.stringify({ note: text }),
      })
      if (res.success && res.data) {
        const data = res.data as { pendingActions?: unknown; revisionRound?: number }
        const next = normalizePendingActions(data.pendingActions)
        setMessages((prev) => prev.map((x) => (x.id === msgId
          ? { ...x, pendingActions: next.length > 0 ? next : x.pendingActions, revisionRound: data.revisionRound ?? x.revisionRound }
          : x)))
      } else {
        message.error(res.message || '修改失败')
      }
    } catch {
      message.error('修改失败，请重试')
    } finally {
      setReviseBusy((prev) => ({ ...prev, [msgId]: false }))
    }
  }, [message])

  // ---- 新建对话：清空会话上下文与界面 ----
  const startNewSession = useCallback(() => {
    setSessionId(null)
    setMessages([])
    setShowHistory(false)
  }, [])

  // ---- 历史列表加载 ----
  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/agent/sessions', { credentials: 'include' })
      const j = await res.json().catch(() => null)
      if (j?.success) setHistoryList(j.data || [])
    } catch { /* */ }
  }, [])

  // ---- 重命名会话 ----
  const renameSession = useCallback(async (id: string, current: string) => {
    const title = window.prompt('重命名对话', current)?.trim()
    if (!title || title === current) return
    try {
      const res = await fetch(`/api/agent/sessions/${id}`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      })
      const j = await res.json().catch(() => null)
      if (j?.success) setHistoryList((prev) => prev.map((h) => (h.id === id ? { ...h, title } : h)))
      else message.error(j?.message || '重命名失败')
    } catch { message.error('重命名失败') }
  }, [message])

  // ---- 删除会话 ----
  const deleteSession = useCallback(async (id: string) => {
    if (!window.confirm('删除这个对话？此操作不可恢复。')) return
    try {
      const res = await fetch(`/api/agent/sessions/${id}`, { method: 'DELETE', credentials: 'include' })
      const j = await res.json().catch(() => null)
      if (j?.success) {
        setHistoryList((prev) => prev.filter((h) => h.id !== id))
        if (sessionId === id) { setSessionId(null); setMessages([]) }
      } else message.error(j?.message || '删除失败')
    } catch { message.error('删除失败') }
  }, [message, sessionId])

  // ---- 点击历史会话：加载消息回显 ----
  const openHistorySession = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/agent/sessions/${id}/messages`, { credentials: 'include' })
      const j = await res.json().catch(() => null)
      if (j?.success && j.data) {
        setSessionId(id)
        // 与实时 SSE 走**同一个**归一化函数（@/lib/agent-message）。
        // 之前这里手写了一份，漏掉 decisions / plan / error —— 刚聊完有卡片，
        // 重开历史就只剩一行字。收敛后两边不可能再不一致。
        setMessages((j.data.messages || []).map(messageFromHistoryRecord))
      }
      setShowHistory(false)
    } catch { /* */ }
  }, [])

  return (
    <div className="flex h-full flex-col gap-3">
      {/* 会话流 */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-0.5 max-lg:min-h-[220px]">
        {messages.length === 0 && (
          // 空状态用 **content-start + pt** 而不是 justify-center：
          // 全高容器里垂直居中会让大块留白压在上下两头、内容挤在中间偏下（用户截图反馈）。
          // 顶部留 12vh 视觉重心更稳，也把技能胶囊推离输入框，两组信息不打架。
          <div className="flex h-full flex-col items-center px-4 pt-[12vh] text-center">
            <div className="brand-gradient-bg mb-3 grid size-12 place-items-center rounded-2xl shadow-sm">
              <RobotOutlined className="text-[20px] text-white" />
            </div>
            <div className="text-[14px] font-medium text-black/75">说说你想做什么</div>
            <div className="mt-1 text-[12px] leading-relaxed text-black/45">
              我来规划并出图，支持多轮追问；也可先上传产品图
            </div>
            {/* 空状态快捷起手：点一下即选中技能并聚焦输入框，不比让用户先学会"点技能按钮"。
                一行放不下就**横向滚动**而不是折行 —— 5 个胶囊折成 3+2 视觉很散（用户截图反馈），
                横滑在移动端也是标准手势。 */}
            <div className="aigc-hub-scrollbar mt-5 flex max-w-full justify-start gap-1.5 overflow-x-auto pb-1 sm:justify-center [&>*]:shrink-0">
              {quickSkills.map((sk) => (
                <button
                  key={sk.id}
                  type="button"
                  onClick={() => { toggleSkill(sk.id); inputRef.current?.focus() }}
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[12px] transition-colors ${
                    selectedSkills.includes(sk.id)
                      ? 'border-accent-border bg-accent-soft text-accent'
                      : 'border-black/8 bg-white text-black/60 hover:border-accent-ring hover:text-accent'
                  }`}
                >
                  <span className="leading-none">{sk.icon}</span>
                  {sk.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id}>
            {m.role === 'user' ? (
              <div className="flex justify-end">
                <div className="max-w-[86%] space-y-2 rounded-2xl rounded-br-md bg-accent px-3.5 py-2.5 text-[13px] leading-relaxed text-white shadow-sm">
                  {m.images && m.images.length > 0 && (
                    <div className={`grid gap-1.5 ${m.images.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
                      {m.images.map((u, ii) => (
                        // 用户上传的图同样要能放大看（用户诉求：发送的图与生成的图一视同仁）
                        <span key={u} className="group/up relative block">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={u} alt="参考图" className="max-h-28 w-full rounded-lg bg-white/10 object-cover" />
                          <button
                            type="button"
                            onClick={() => setLightbox({ open: true, urls: m.images || [], index: ii })}
                            title="点击放大查看"
                            aria-label="放大查看"
                            className="absolute right-1.5 bottom-1.5 flex items-center gap-1 rounded-lg bg-black/55 px-2 py-0.5 text-[11px] text-white opacity-0 backdrop-blur transition-opacity group-hover/up:opacity-100 focus:opacity-100"
                          >
                            <ZoomInOutlined /> 查看
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  {m.content && <div className="whitespace-pre-wrap">{m.content}</div>}
                </div>
              </div>
            ) : (
              <div className="flex gap-2.5">
                {/* 助手侧统一用「标记 + 内容」而不是气泡：Agent 的回复往往是长文 + 计划 + 状态，套气泡会挤 */}
                <div className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg bg-accent-soft">
                  <RobotOutlined className="text-[12px] text-accent" />
                </div>
                <div className="min-w-0 flex-1 space-y-2.5 pt-0.5">
                  {m.status === 'pending' && !m.thinking && !m.content && (
                    <span className="flex items-center gap-1.5 text-[12px] text-black/45">
                      <LoadingOutlined spin /> 正在理解需求…
                    </span>
                  )}
                  {m.thinking && (
                    <details open={m.status === 'pending'} className="group rounded-xl border border-black/[0.06] bg-black/[0.02] px-2.5 py-2 text-[11px] leading-relaxed">
                      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-black/50">
                        {m.status === 'pending'
                          ? <><LoadingOutlined spin className="text-accent" /> 正在思考…</>
                          : <><CheckCircleFilled className="text-green-500" /> 思考过程</>}
                        <span className="ml-auto text-[10px] text-black/30 transition-transform group-open:rotate-180">▾</span>
                      </summary>
                      <div className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-black/55">
                        {m.thinking.length > 1200 ? `…${m.thinking.slice(-1200)}` : m.thinking}
                      </div>
                    </details>
                  )}
                  {/* Agent 反问：渲染成可点选项，点一下即作答并继续（不必手打） */}
                  {m.askQuestions && m.askQuestions.length > 0 && m.status !== 'pending' && (
                    <div className="space-y-3 rounded-xl border border-accent-border bg-accent-soft/60 px-3 py-3">
                      {m.askQuestions.map((q, qi) => {
                        const picked = answered[`${m.id}:${qi}`]
                        return (
                          <div key={qi}>
                            <div className="mb-1.5 text-[12px] font-medium leading-relaxed text-black/75">
                              {q.question}
                            </div>
                            {q.options.length > 0 ? (
                              <div className="flex flex-col gap-1">
                                {q.options.map((opt) => {
                                  const isPicked = picked === opt
                                  // 已答过：全部置灰，只高亮用户选的那条（保留选择痕迹，且防止改答案造成歧义）
                                  const doneState = !!picked || !!sentAsk[m.id]
                                  return (
                                    <button
                                      key={opt}
                                      type="button"
                                      disabled={doneState || sending}
                                      onClick={() => answerQuestion(m.id, qi, opt)}
                                      className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                                        isPicked
                                          ? 'border-accent bg-accent text-white'
                                          : doneState
                                            ? 'cursor-default border-black/8 bg-white/50 text-black/35'
                                            : 'border-black/8 bg-white text-black/70 hover:border-accent-ring hover:text-accent'
                                      } ${sending && !doneState ? 'cursor-not-allowed opacity-60' : ''}`}
                                    >
                                      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{opt}</span>
                                      {isPicked && <CheckCircleFilled className="shrink-0 text-[12px]" />}
                                    </button>
                                  )
                                })}
                              </div>
                            ) : (
                              <div className="text-[11px] text-black/40">直接在下方输入框补充即可</div>
                            )}
                          </div>
                        )
                      })}
                      {(() => {
                        const qs2 = m.askQuestions || []
                        const answerable = qs2.filter((q) => q.options.length > 0)
                        const locked = !!sentAsk[m.id]
                        if (answerable.length <= 1) {
                          return (
                            <div className="text-[11px] leading-relaxed text-black/40">
                              也可以直接在下方输入框自由描述
                            </div>
                          )
                        }
                        const doneCount = answerable.filter((q) => !!answered[`${m.id}:${qs2.indexOf(q)}`]).length
                        const allDone = doneCount >= answerable.length
                        return (
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] leading-relaxed text-black/40">
                              {locked ? '已提交回答' : `已选 ${doneCount}/${answerable.length}，全部选完再一起发送`}
                            </span>
                            <button
                              type="button"
                              disabled={!allDone || sending || locked}
                              onClick={() => submitAnswers(m.id)}
                              className={`shrink-0 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors ${
                                !allDone || sending || locked
                                  ? 'cursor-not-allowed bg-black/10 text-black/30'
                                  : 'bg-accent text-white hover:opacity-90'
                              }`}
                            >
                              发送回答
                            </button>
                          </div>
                        )
                      })()}
                    </div>
                  )}
                  {/* 关键决策：模型/比例/档位… —— 后端一直在发（SSE + 落库），
                      但前端从未渲染过，等于白算。这里补上，用户才知道「为什么是这张图」。 */}
                  {m.decisions && m.decisions.length > 0 && (
                    <div className="rounded-xl border border-black/[0.06] bg-white px-3 py-2.5 text-[12px] leading-relaxed shadow-sm">
                      <div className="mb-1.5 text-[11px] font-medium text-black/45">关键决策</div>
                      <div className="space-y-1">
                        {m.decisions.map((d, i) => (
                          <div key={i} className="flex gap-1.5">
                            <span className="shrink-0 text-black/45">{d.label}</span>
                            <span className="min-w-0 font-medium text-black/75">{d.value}</span>
                            {d.reason && (
                              <span className="min-w-0 truncate text-black/35" title={d.reason}>· {d.reason}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* confirm 模式：待确认卡片。
                      必须把「要做什么 / 完整提示词 / 参数 / 预估花费」都列出来 ——
                      用户确认的是这份具体方案，不是一个笼统的"开始"按钮。 */}
                  {m.pendingActions && m.pendingActions.length > 0 && (
                    <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2.5 text-[12px] leading-relaxed shadow-sm">
                      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-amber-700">
                        <ThunderboltFilled /> 待确认 · 共 {m.pendingActions.length} 步（确认后才会生成并扣费）
                        {m.revisionRound ? (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-normal text-amber-700">
                            第 {m.revisionRound + 1} 版
                          </span>
                        ) : null}
                      </div>
                      <div className="space-y-2">
                        {m.pendingActions.map((p, i) => (
                          <div key={p.id || i} className="rounded-lg border border-black/[0.06] bg-white px-2.5 py-2">
                            <div className="mb-1 flex flex-wrap items-center gap-1.5">
                              <span className="font-medium text-black/80">{i + 1}. {p.title}</span>
                              <span className="rounded bg-black/[0.05] px-1.5 py-0.5 text-[10px] text-black/50">
                                {p.kind === 'image' ? '图片' : p.kind === 'video' ? '视频' : p.kind === 'audio' ? '音频' : '文本'}
                                {p.count > 1 ? ` × ${p.count}` : ''}
                              </span>
                            </div>
                            <div className="mb-1 whitespace-pre-wrap break-words text-[11px] text-black/60">{p.prompt}</div>
                            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-black/40">
                              {p.ratio && <span>比例 {p.ratio}</span>}
                              {p.quality && <span>档位 {p.quality}</span>}
                              {p.resolution && <span>清晰度 {p.resolution}</span>}
                              {p.seconds != null && <span>{p.seconds} 秒</span>}
                              {p.voice && <span>音色 {p.voice}</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                      {/* 改方案：用户说人话，Agent 重排。不让用户自己编辑提示词 ——
                          他们不懂 prompt 工程，改出来往往更差。 */}
                      <div className="mt-2 border-t border-black/[0.06] pt-2">
                        <div className="mb-1 text-[10px] text-black/45">想改哪里？直接说，Agent 重新排一版</div>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={reviseText[m.id] || ''}
                            onChange={(e) => setReviseText((prev) => ({ ...prev, [m.id]: e.target.value }))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault()
                                if (m.pendingTaskId) void revisePending(m.id, m.pendingTaskId, reviseText[m.id] || '')
                              }
                            }}
                            disabled={reviseBusy[m.id]}
                            maxLength={500}
                            placeholder="例：第二张换成暖色调；只要 2 张；文案改成俄语"
                            className="min-w-0 flex-1 rounded-lg border border-black/10 px-2.5 py-1 text-[12px] outline-none focus:border-accent-ring disabled:opacity-50"
                          />
                          <button
                            type="button"
                            disabled={reviseBusy[m.id] || !(reviseText[m.id] || '').trim()}
                            onClick={() => m.pendingTaskId && void revisePending(m.id, m.pendingTaskId, reviseText[m.id] || '')}
                            className="shrink-0 rounded-lg border border-accent-ring bg-accent-soft px-3 py-1 text-[12px] font-medium text-accent disabled:opacity-50"
                          >
                            {reviseBusy[m.id] ? '修改中…' : '让它改'}
                          </button>
                        </div>
                      </div>
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          disabled={sending}
                          onClick={() => m.pendingTaskId && void resolvePending(m.id, m.pendingTaskId, 'confirm')}
                          className="rounded-lg bg-accent px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
                        >
                          确认执行
                        </button>
                        <button
                          type="button"
                          disabled={sending}
                          onClick={() => m.pendingTaskId && void resolvePending(m.id, m.pendingTaskId, 'cancel')}
                          className="rounded-lg border border-black/10 px-3 py-1 text-[12px] text-black/60 disabled:opacity-50"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  )}
                  {m.plan && m.plan.steps.length > 0 && (                    <div className="rounded-xl border border-black/[0.06] bg-white px-3 py-2.5 text-[12px] leading-relaxed shadow-sm">
                      <div className="mb-1.5 text-[11px] font-medium text-black/45">执行计划</div>
                      <div className="space-y-1">
                        {resolveVideoPlanSteps(m.plan.steps, resultStates).map((st, i) => (
                          <div key={i} className="flex items-center gap-1.5">
                            {st.status === 'running' && <LoadingOutlined spin className="text-accent" />}
                            {st.status === 'success' && <CheckCircleFilled className="text-green-500" />}
                            {st.status === 'failed' && <CloseCircleFilled className="text-red-400" />}
                            {st.status === 'pending' && <ClockCircleOutlined className="text-amber-500" />}
                            <span className={st.status === 'failed' ? 'text-red-500' : st.status === 'pending' ? 'text-black/45' : 'text-black/70'}>
                              {st.label}{st.status === 'pending' ? '（待确认）' : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {(() => {
                    // 有可点选项卡片时，正文里的「问题 + A./B. 选项」属于重复内容：
                    // 卡片已经承担了展示，正文只留引导语那一行。
                    const hasCards = !!(m.askQuestions && m.askQuestions.length > 0)
                    const text = hasCards ? stripAskQuestionBody(m.content) : m.content
                    if (!text) return null
                    return <Markdown>{text}</Markdown>
                  })()}
                  {m.status === 'failed' && (
                    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-red-50 px-3 py-2 text-[12px] leading-relaxed text-red-600">
                      <span className="min-w-0 flex-1">{m.error || '生成失败，请重试'}</span>
                      {m.taskId && (
                        <Button
                          size="small"
                          icon={<ReloadOutlined />}
                          loading={sending}
                          onClick={() => void resumeTask(m.id, m.taskId!)}
                        >
                          从断点继续
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ===== 输入区（composer）：附件 / 已选技能 / 文本 / 工具条 收进一个整体容器 ===== */}
      <div data-guide="agent-input" className="rounded-2xl border border-black/8 bg-white shadow-[0_1px_3px_rgba(2,6,23,0.05)] transition-colors focus-within:border-accent-ring">
        {(images.length > 0 || selectedSkillObjs.length > 0 || uploadingCount > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-black/[0.05] px-2.5 pb-2 pt-2.5">
            {images.map((u) => (
              <div key={u} className="group relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={u} alt="待发送" className="size-11 rounded-lg border border-black/10 object-cover" />
                <button
                  type="button"
                  aria-label="移除图片"
                  onClick={() => setImages((prev) => prev.filter((x) => x !== u))}
                  className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <CloseOutlined className="text-[8px]" />
                </button>
              </div>
            ))}
            {/* 上传占位：先出骨架再出图，避免"点了没反应"被当成没点上 */}
            {Array.from({ length: uploadingCount }).map((_, i) => (
              <div
                key={`up-${i}`}
                className="grid size-11 place-items-center rounded-lg border border-dashed border-accent-ring bg-accent-soft text-accent"
              >
                <Spin size="small" />
              </div>
            ))}
            {selectedSkillObjs.map((sk) => (
              <span
                key={sk.id}
                title={sk.description}
                className="flex items-center gap-1 rounded-lg bg-accent/10 py-1 pl-2 pr-1 text-[11px] text-accent"
              >
                <span className="leading-none">{sk.icon}</span>
                <span className="max-w-[9rem] truncate">{sk.name}</span>
                <button
                  type="button"
                  aria-label={`移除技能 ${sk.name}`}
                  onClick={() => toggleSkill(sk.id)}
                  className="flex size-4 items-center justify-center rounded-full transition-colors hover:bg-accent/15"
                >
                  <CloseOutlined className="text-[8px]" />
                </button>
              </span>
            ))}
          </div>
        )}

        <Input.TextArea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); send() } }}
          onPaste={(e) => {
            // 粘贴图片：与附件按钮走同一 handleUpload，保证三条入口行为一致
            const files = Array.from(e.clipboardData?.files || []).filter((f) => f.type.startsWith('image/'))
            if (files.length > 0) {
              e.preventDefault()
              for (const f of files) void handleUpload(f)
            }
          }}
          onDrop={(e) => {
            // 拖拽图片：同上
            const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'))
            if (files.length > 0) {
              e.preventDefault()
              for (const f of files) void handleUpload(f)
            }
          }}
          onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault() }}
          variant="borderless"
          placeholder="描述你想生成什么，可多轮追问…"
          autoSize={{ minRows: 2, maxRows: 6 }}
          className="!px-3 !pt-3"
          disabled={sending}
        />

        <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
          {createMode && onCreateModeChange && <CreateModePicker value={createMode} onChange={onCreateModeChange} />}
          {/* 附件 */}
          <label
            data-guide="agent-attach"
            title="上传图片（也可直接粘贴 / 拖入输入框）"
            className="flex h-9 cursor-pointer items-center gap-1 rounded-xl px-2.5 text-[12px] text-black/50 transition-colors hover:bg-black/5 hover:text-accent"
          >
            <PaperClipOutlined className="text-[14px]" />
            <span className="max-lg:hidden">图片</span>
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={async (e) => {
                const files = Array.from(e.target.files || [])
                for (const f of files) await handleUpload(f)
                e.target.value = ''
              }}
            />
          </label>

          {/* 技能选择器：分组 + 说明 + 已选可退；弹层交给 antd Popover（自动翻转/贴边，移动端不溢出） */}
          <Popover
            open={showSkillPicker}
            onOpenChange={(v) => { setShowSkillPicker(v); if (v) setShowHistory(false) }}
            trigger="click"
            placement="topLeft"
            arrow={false}
            styles={{ content: { padding: 0 } }}
            content={
              <div className="w-[302px] max-w-[86vw]">
                <div className="flex items-center justify-between border-b border-black/[0.06] px-3 py-2">
                  <span className="text-[12px] font-medium text-black/70">技能</span>
                  {selectedSkills.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedSkills([])}
                      className="rounded-md px-1.5 py-0.5 text-[11px] text-black/45 transition-colors hover:bg-black/5 hover:text-black/70"
                    >
                      清空
                    </button>
                  )}
                </div>
                <div className="max-h-[46vh] overflow-y-auto p-1.5">
                  {skillGroups.map((g) => (
                    <div key={g.group} className="mb-1 last:mb-0">
                      <div className="px-2 pb-1 pt-1.5 text-[10px] font-medium tracking-wide text-black/35">
                        {g.group}
                      </div>
                      {g.items.map((sk) => {
                        const on = selectedSkills.includes(sk.id)
                        return (
                          <button
                            key={sk.id}
                            type="button"
                            onClick={() => toggleSkill(sk.id)}
                            aria-pressed={on}
                            className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${on ? 'bg-accent/10' : 'hover:bg-black/5'}`}
                          >
                            <span className="mt-0.5 text-[14px] leading-none">{sk.icon}</span>
                            <span className="min-w-0 flex-1">
                              <span className={`block truncate text-[12px] ${on ? 'font-medium text-accent' : 'text-black/75'}`}>{sk.name}</span>
                              <span className="mt-0.5 block truncate text-[11px] text-black/40">{sk.description}</span>
                            </span>
                            {on && <CheckCircleFilled className="mt-0.5 shrink-0 text-[12px] text-accent" />}
                          </button>
                        )
                      })}
                    </div>
                  ))}
                </div>
              </div>
            }
          >
            <button
              type="button"
              data-guide="agent-skill"
              title="选择技能"
              className={`flex h-9 items-center gap-1 rounded-xl px-2.5 text-[12px] transition-colors ${
                selectedSkills.length > 0
                  ? 'bg-accent/10 text-accent'
                  : 'text-black/50 hover:bg-black/5 hover:text-accent'
              }`}
            >
              <AppstoreOutlined className="text-[14px]" />
              <span>技能{selectedSkills.length > 0 ? ` · ${selectedSkills.length}` : ''}</span>
            </button>
          </Popover>

          {/* 历史 / 新建：同样交给 Popover（与技能选择器统一，弹层不溢出屏幕） */}
          <Popover
            open={showHistory}
            onOpenChange={(v) => { setShowHistory(v); if (v) { void loadHistory(); setShowSkillPicker(false) } }}
            trigger="click"
            placement="topLeft"
            arrow={false}
            styles={{ content: { padding: 0 } }}
            content={
              <div className="w-[300px] max-w-[86vw]">
                <button
                  type="button"
                  onClick={startNewSession}
                  className="flex w-full items-center gap-2 border-b border-black/[0.06] px-3 py-2.5 text-left text-[12px] font-medium text-accent transition-colors hover:bg-accent/5"
                >
                  <PlusOutlined /> 新建对话
                </button>
                {/* 用法引导：会话开太久会上下文变长、参考图过期。
                    与其等用户踩坑（实测常见：一批做完接着下一批，最后素材全失效），
                    不如在这里把使用习惯讲清楚。 */}
                <div className="border-b border-black/[0.06] bg-accent-soft/30 px-3 py-2 text-[11px] leading-relaxed text-black/50">
                  一批任务做完，建议<b className="font-medium text-black/65">新建对话</b>再做下一批：
                  上下文更干净，参考图也不容易过期。
                </div>
                <div className="max-h-[46vh] overflow-y-auto p-1.5">
                  {historyList.length === 0 && (
                    <div className="px-2 py-6 text-center text-[11px] text-black/40">暂无历史会话</div>
                  )}
                  {historyList.map((h) => (
                    <div
                      key={h.id}
                      className={`group flex items-start gap-1 rounded-lg px-2 py-1.5 transition-colors ${
                        h.id === sessionId ? 'bg-accent/10' : 'hover:bg-black/5'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => void openHistorySession(h.id)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="truncate text-[12px] font-medium text-black/75">{h.title}</div>
                        <div className="truncate text-[11px] text-black/40">{h.preview || '…'}</div>
                      </button>
                      <button
                        type="button"
                        title="重命名"
                        onClick={() => void renameSession(h.id, h.title)}
                        className="mt-0.5 hidden size-5 shrink-0 items-center justify-center rounded text-black/40 hover:bg-black/10 hover:text-black/70 group-hover:flex"
                      >
                        <EditOutlined className="text-[11px]" />
                      </button>
                      <button
                        type="button"
                        title="删除"
                        onClick={() => void deleteSession(h.id)}
                        className="mt-0.5 hidden size-5 shrink-0 items-center justify-center rounded text-black/40 hover:bg-red-50 hover:text-red-500 group-hover:flex"
                      >
                        <DeleteOutlined className="text-[11px]" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            }
          >
            <button
              type="button"
              title="历史对话"
              className="flex h-9 items-center gap-1 rounded-xl px-2.5 text-[12px] text-black/50 transition-colors hover:bg-black/5 hover:text-accent"
            >
              <HistoryOutlined className="text-[14px]" />
              <span className="max-lg:hidden">历史</span>
            </button>
          </Popover>

          {/* 偏好设定 */}
          <button
            type="button"
            title="模型偏好（全局生效）"
            onClick={() => { setShowPrefs(true); setShowSkillPicker(false); setShowHistory(false) }}
            className="flex h-9 items-center gap-1 rounded-xl px-2.5 text-[12px] text-black/50 transition-colors hover:bg-black/5 hover:text-accent"
          >
            <SettingOutlined className="text-[14px]" />
            <span className="max-lg:hidden">偏好</span>
          </button>

          <div className="ml-auto flex items-center gap-2">
            {uploadingCount > 0 && <span className="text-[11px] text-black/40">上传中…</span>}
            {/* 生成中：主按钮变「停止」，只留一个动作；原先「取消」+ 转圈发送并存，语义重复 */}
            {sending ? (
              <Button
                danger
                size="small"
                className="!rounded-xl !px-4"
                icon={<StopOutlined />}
                onClick={stop}
              >
                停止
              </Button>
            ) : (
              <Button
                // 空态时**弱化**为描边小按钮：灰底大按钮比输入框还抢眼（用户截图反馈），
                // 用户打了字它才升格为主色 —— 这也是「现在可以发了」的状态暗示。
                type={input.trim() && uploadingCount === 0 ? 'primary' : 'default'}
                size="small"
                className={input.trim() && uploadingCount === 0 ? '!rounded-xl !px-4' : '!rounded-xl !px-4 !text-black/45'}
                icon={<ThunderboltFilled />}
                disabled={uploadingCount > 0 || !input.trim()}
                onClick={() => void send()}
              >
                发送
              </Button>
            )}
          </div>
        </div>
      </div>

      <AgentPrefsDrawer open={showPrefs} onClose={() => setShowPrefs(false)} />

      {/* 图片放大：用户上传图 / 助手回复里的图共用同一个灯箱 */}
      <ImageLightbox
        open={lightbox.open}
        urls={lightbox.urls}
        startIndex={lightbox.index}
        onClose={() => setLightbox((b) => ({ ...b, open: false }))}
      />
    </div>
  )
}
