'use client'

// ===== 首次使用引导（锚点式）=====
//
// 设计目标：不要「翻页读说明书」，要**一步一步指到 UI 上**——
//   高亮那个控件、在旁边说明、点「下一步」自动跳到下一个控件。
//
// 定位准确性（v5，用户反馈「位置偏差」后的修正）：
//   旧版用 `scrollIntoView({behavior:'smooth'})` + 固定等 320ms 再测量。
//   平滑滚动经常超过 320ms，量到的是**滚动途中的位置** → 高亮框偏移。
//   v5 改为：
//     1) `behavior:'instant'` —— 不做滚动动画，位置立即到位；
//     2) 测量改为 **rAF 轮询直到稳定**（连续 2 帧位置一致才采信），
//        覆盖「字体加载/图片占位撑开布局」等导致的晚到偏移；
//     3) scroll/resize 时同样走 rAF 节流重算。
//
// 找不到锚点（控件未渲染/被隐藏）→ 退化成居中弹卡，不卡死。

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Button, Typography } from 'antd'
import { requestOpenCopilot } from '@/lib/agent-context-window'
import { readLocalText, writeLocalText } from '@/lib/local-store'

const { Text } = Typography

export type GuideStep = {
  title: string
  body: string
  /** 高亮锚点：CSS 选择器。命中则高亮该元素；未命中退化为居中弹卡 */
  anchor?: string
  /** 兼容旧字段（旧版当视觉提示用）；语义等同 anchor */
  hint?: string
  /**
   * 进入这一步时要触发的副作用（如「先展开 Copilot 面板」）。
   *
   * 为什么需要：有些控件**默认不在 DOM 里**（画布 Copilot 收起成胶囊时，
   * 它的输入框/模型下拉都不存在）。不先把它展开，后面几步的锚点必然落空，
   * 引导会静默退化成居中弹卡 —— 用户看到的是一张「没指着任何东西」的卡片。
   *
   * 必须是幂等的：用户可能前后翻步骤，同一个 onEnter 会被调用多次。
   */
  onEnter?: () => void
}

interface Props {
  /** 唯一 key：不同场景各自记一次（如 'tools' / 'copilot' / 'home'） */
  storageKey: string
  steps: GuideStep[]
  /** 是否启用（如未登录时不弹） */
  enabled?: boolean
}

/**
 * 引导版本号（**按场景**）：文案/结构大改时把对应场景 +1，让老用户再看一次新版引导。
 *
 * 为什么不做成全局一个版本号：那样「改了首页引导」会把工具箱/Agent 的引导也一起重弹，
 * 用户被反复打扰；反过来若为了不打扰而不动版本号，改过的引导老用户又永远看不到。
 * 按场景各自记版本，才既能让新版生效、又不误伤没改的场景。
 *
 * 未声明的场景回落到 DEFAULT_GUIDE_VERSION（新场景首次进入本来就没有记录，会正常弹）。
 */
const DEFAULT_GUIDE_VERSION = 5
const GUIDE_VERSIONS: Record<string, number> = {
  tools: 5,
  agent: 5,
  // 2026-10-02 重写：补真实锚点 + 改成「指到具体控件」
  home: 6,
  // 7：Copilot 默认收起成胶囊，原引导前两步锚点根本不在 DOM 里（必然落空）。
  //    改为先指胶囊、再在进入「输入框」那步时展开面板。
  copilot: 7,
  // 本次新增的两个场景
  gallery: 1,
  prompts: 1,
}

/** 取某个场景当前的引导版本号（供 FirstUseGuide 与页面的 precheck 共用） */
export function guideVersionOf(storageKey: string): number {
  return GUIDE_VERSIONS[storageKey] ?? DEFAULT_GUIDE_VERSION
}

const SPOTLIGHT_PAD = 8
const CARD_W = 340

type Rect = { top: number; left: number; width: number; height: number }

function measure(anchor?: string): Rect | null {
  if (!anchor || typeof document === 'undefined') return null
  const el = document.querySelector(anchor) as HTMLElement | null
  if (!el) return null
  const r = el.getBoundingClientRect()
  // display:none / 未渲染的元素量出来是 0，视为「没找到」
  if (r.width === 0 && r.height === 0) return null
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

const sameRect = (a: Rect | null, b: Rect | null) =>
  !!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height

export function FirstUseGuide({ storageKey, steps, enabled = true }: Props) {
  const [open, setOpen] = useState(false)
  const [i, setI] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)
  const rafRef = useRef<number | null>(null)
  const pollRef = useRef<{ timer: number | null } | null>(null)

  useEffect(() => {
    if (!enabled || steps.length === 0) return
    const key = `guide:seen:${storageKey}:v${guideVersionOf(storageKey)}`
    try {
      if (readLocalText(key) === '1') return
    } catch { return }
    const t = setTimeout(() => setOpen(true), 600)
    return () => clearTimeout(t)
  }, [enabled, storageKey, steps.length])

  const finish = useCallback(() => {
    // 规范层的写入永不抛错 —— 不需要 try/catch
    writeLocalText(`guide:seen:${storageKey}:v${guideVersionOf(storageKey)}`, '1')
    setOpen(false)
    setI(0)
  }, [storageKey])

  const step = steps[i]
  const last = i === steps.length - 1
  const anchorSel = step?.anchor || step?.hint

  // 步骤切换：先跑本步的副作用（如展开目标面板）→ 再滚到锚点 → 轮询测量到稳定
  useEffect(() => {
    if (!open) return

    // onEnter 可能改变布局（如展开 Copilot 面板）。两件事必须处理好：
    //   1) React 的 setState 是异步的 —— 派发事件后**当帧**元素还没挂载，
    //      立刻 measure 会拿到 null（引导退化成居中弹卡，闪一下再恢复）；
    //   2) 展开往往带过渡动画 —— 元素已存在但位置还在动。
    // 所以先等一个短延迟再开始轮询，轮询本身负责「动到停为止」。
    const hasOnEnter = typeof step?.onEnter === 'function'
    if (hasOnEnter) step!.onEnter!()

    if (!anchorSel) { setRect(null); return }

    // 停掉上一步可能还在跑的轮询
    if (pollRef.current?.timer) { clearInterval(pollRef.current.timer); pollRef.current.timer = null }

    let stable = 0
    let prev: Rect | null = null
    const settleMs = hasOnEnter ? 260 : 0   // 给 React 重渲染 + 展开动画一点时间
    const startedAt = Date.now()

    const tick = () => {
      // 首帧还没到 settle 时间 → 先不采信，免得把「展开前的位置」当成稳定值
      if (Date.now() - startedAt < settleMs) {
        pollRef.current = { timer: window.setTimeout(tick, 100) as unknown as number }
        return
      }
      const cur = measure(anchorSel)
      if (cur) {
        const el = document.querySelector(anchorSel) as HTMLElement | null
        // 位置变化时顺手滚到视野中央（元素可能是刚挂载的，之前那次滚不到）
        if (el && !sameRect(cur, prev)) el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior })
      }
      if (sameRect(cur, prev)) stable += 1
      else { stable = 0; prev = cur; setRect(cur) }
      // 连续 2 帧一致 → 认为稳定；超时 1.2s 也停（布局可能永远在动，比如轮播）
      if ((stable >= 2 && cur) || Date.now() - startedAt > 1200) return
      pollRef.current = { timer: window.setTimeout(tick, 100) as unknown as number }
    }
    tick()

    return () => {
      if (pollRef.current?.timer) { clearTimeout(pollRef.current.timer); pollRef.current.timer = null }
    }
  }, [open, i, anchorSel, step])

  // 窗口尺寸/滚动变化时重算（rAF 节流）
  useEffect(() => {
    if (!open || !anchorSel) return
    const recalc = () => {
      if (rafRef.current) return
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        setRect(measure(anchorSel))
      })
    }
    window.addEventListener('resize', recalc)
    window.addEventListener('scroll', recalc, true)
    return () => {
      window.removeEventListener('resize', recalc)
      window.removeEventListener('scroll', recalc, true)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [open, anchorSel])

  if (steps.length === 0) return null

  // 卡片位置：优先锚点下方；下方放不下则上方；左右兜底居中
  const place = (() => {
    if (!rect) return { style: { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' } as CSSProperties }
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
    const below = rect.top + rect.height + SPOTLIGHT_PAD + 12
    const fitsBelow = below + 200 < vh
    const top = fitsBelow ? below : Math.max(16, rect.top - SPOTLIGHT_PAD - 12 - 190)
    const left = Math.min(Math.max(12, rect.left), Math.max(12, vw - CARD_W - 12))
    return { style: { left, top, width: CARD_W } as CSSProperties }
  })()

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-[1200]" role="dialog" aria-modal="true">
          {rect ? (
            <div
              className="pointer-events-none absolute rounded-2xl ring-2 ring-accent transition-none"
              style={{
                top: rect.top - SPOTLIGHT_PAD,
                left: rect.left - SPOTLIGHT_PAD,
                width: rect.width + SPOTLIGHT_PAD * 2,
                height: rect.height + SPOTLIGHT_PAD * 2,
                // 用超大 box-shadow 把其余区域压暗，实现「镂空」高亮
                boxShadow: '0 0 0 9999px rgba(20, 12, 40, 0.55), 0 0 0 4px rgba(150,118,226,0.35)',
              }}
            />
          ) : (
            <div className="absolute inset-0 bg-black/55" />
          )}

          {/* 说明卡 */}
          <div
            className="absolute rounded-2xl bg-white p-5 shadow-[0_12px_40px_rgba(60,30,140,0.28)]"
            style={place.style}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
                新手引导 {i + 1}/{steps.length}
              </span>
              <span className="flex items-center gap-1.5">
                {steps.map((_, idx) => (
                  <span
                    key={idx}
                    className={`h-1.5 rounded-full transition-all ${idx === i ? 'w-4 bg-accent' : 'w-1.5 bg-black/12'}`}
                  />
                ))}
              </span>
            </div>
            <div className="mt-3 text-[15px] font-semibold leading-snug">{step.title}</div>
            <Text className="mt-2 block !text-[13px] !leading-[1.7] text-black/60">{step.body}</Text>
            {!rect && anchorSel && (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-700">
                当前页面没找到这一步对应的控件，可能它还没加载出来或被隐藏。
              </div>
            )}
            <div className="mt-6 flex items-center justify-between gap-2">
              <Button type="text" size="small" className="!text-black/40" onClick={finish}>
                不再提示
              </Button>
              <div className="flex gap-2">
                {i > 0 && (
                  <Button size="small" className="!rounded-full" onClick={() => setI((p) => p - 1)}>
                    上一步
                  </Button>
                )}
                <Button
                  type="primary"
                  size="small"
                  className="!rounded-full !px-4"
                  onClick={() => (last ? finish() : setI((p) => p + 1))}
                >
                  {last ? '开始使用' : '下一步'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/** 各场景的引导文案（集中放这里，方便统一改）。anchor = 高亮锚点选择器。 */
export const GUIDE_STEPS = {
  tools: [
    {
      title: '三栏分工',
      body: '左「成果区」放结果，中「工作台」看图和编辑，右「操作面板」填参数出图。跟着高亮框走。',
      anchor: '[data-guide="panel"]',
    },
    {
      title: '① 选生图模型（必选）',
      body: '点开这个下拉选一个模型。带「免费」标签的有每日免费额度，先用它试最划算。',
      anchor: '[data-guide="model"]',
    },
    {
      title: '② 再选图片规格',
      body: '选完模型，这里才会出现它支持的比例（1:1 / 3:4 / 16:9…）和清晰度（1K / 2K / 4K）。',
      anchor: '[data-guide="ratio"]',
    },
    {
      title: '③ 填内容 / 传素材',
      body: '有输入框就按提示填。要参考图的工具，把图拖进上传区。',
      anchor: '[data-guide="text"]',
    },
    {
      title: '④ 点生成',
      body: '填完点面板底部的生成按钮，任务进左侧成果区排队，完成后自动显示。',
      anchor: '[data-guide="submit"]',
    },
  ],
  agent: [
    {
      title: '三段式：左成果 / 中工作台 / 右对话',
      body: '右侧跟 Agent 说需求，它派发的任务会在左侧「成果区」排队，完成后点成果图到中间「工作台」查看与编辑。',
      anchor: '[data-guide="panel"]',
    },
    {
      title: '先说清楚要什么',
      body: '直接用大白话说：几个方向、几张、什么风格。缺关键信息它会在对话里反问你（点选项即可）。',
      anchor: '[data-guide="agent-input"]',
    },
    {
      title: '可以上传参考图',
      body: '在输入框左侧「+」上传产品图 / 人物图，Agent 会把它作为图生图的参考一起发出去。',
      anchor: '[data-guide="agent-attach"]',
    },
    {
      title: '也可以先选技能',
      body: '点输入框右侧「技能」选一个垂直领域（如俄区套图、电商主图），它会按该领域的规则与约束来做。',
      anchor: '[data-guide="agent-skill"]',
    },
  ],
  copilot: [
    {
      // 第一步只「指出位置」，**不展开** ——
      // 锚点就是胶囊本身，一展开它就卸载了，锚点反而落空。
      title: '先找到「创作助手」胶囊',
      body: 'Copilot 默认收起成右下角这条胶囊（可以拖到顺手的位置）。点它就能展开，下面直接带你走一遍。',
      anchor: '[data-guide="copilot-capsule"]',
    },
    {
      // 这一步要指输入框 —— 它只在面板**展开时**才存在，
      // 所以在进入本步时先展开面板（onEnter 幂等，来回翻步骤重复调用无副作用）。
      title: '一句话，它帮你搭好',
      body: '在大白话描述需求（如「做一张电商主图，白底、产品居中」），Copilot 会自动把节点和连线搭出来。',
      anchor: '#copilot-input',
      onEnter: () => requestOpenCopilot(),
    },
    {
      title: '先确认「大脑模型」',
      body: '这个下拉决定谁理解你的话并编排节点。默认已选带免费额度的模型，先别改。',
      anchor: '#copilot-brain',
      // 同样要展开：用户可能从第 1 步直接跳到这步、或来回翻，面板必须保证是开的
      onEnter: () => requestOpenCopilot(),
    },
    {
      title: '缺节点从「节点库」拖',
      body: '搭出来的流程不完整时，点这里打开节点库，把缺的节点拖到画布上，再连线即可。',
      anchor: '[data-guide="canvas-node-lib"]',
    },
  ],
  home: [
    {
      title: '点这里开始创作',
      body: '输入、模型、生成方式都在创作工作区里。点这个胶囊直接进入。',
      anchor: '[data-guide="home-create-entry"]',
    },
    {
      title: '出图后去哪儿看',
      body: '生成结果会出现在创作区左栏「成果区」；点成果图可在中间工作台放大、裁剪、加文字。',
      anchor: '[data-guide="home-create-entry"]',
    },
    {
      title: '逛逛作品找灵感',
      body: '下方精选作品来自真实用户；看中的可以点开看提示词，一键复用。',
      anchor: '[data-guide="gallery-search"]',
    },
  ],
  gallery: [
    {
      title: '这里是作品广场',
      body: '逛别人做的好图与工作流，看中的可以直接复用 —— 不用从零开始想提示词。',
      anchor: '[data-guide="gallery-search"]',
    },
    {
      title: '换个类型看看',
      body: '顶部切「工作流 / 图片 / 视频」；也可以直接搜索，比如「科技感海报」「温馨插画」。',
      anchor: '[data-guide="gallery-type"]',
    },
    {
      title: '看中了就点开',
      body: '点任意一张卡片打开详情：可以「复制提示词」拿去用，工作流还能「导入到画布」直接跑。',
      anchor: '[data-guide="gallery-search"]',
    },
  ],
  prompts: [
    {
      title: '提示词库 = 现成的写法',
      body: '这里是可以直接用的提示词与模板，省掉「不知道怎么写」这一步。',
      anchor: '[data-guide="prompts-search"]',
    },
    {
      title: '挑一个来源',
      body: '在「我的 / 官方」之间切换：官方是平台精选，我的则是你保存和打磨过的。',
      anchor: '[data-guide="prompts-source"]',
    },
    {
      title: '复制走就能用',
      body: '点卡片上的「复制」，粘到工具箱或 Agent 的输入框里，改成你的内容即可。',
      anchor: '[data-guide="prompts-search"]',
    },
  ],
} as const
