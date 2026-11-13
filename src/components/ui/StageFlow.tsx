'use client'

/**
 * 任务阶段流程条 —— 「优化提示词中 ≫ 排队中 ≫ 创作中 ≫」
 *
 * 用在哪：成果区运行中的卡片、Agent 气泡。让用户看到「现在走到哪一步了」，
 * 而不是只有一句「准备中」然后干等。
 *
 * 为什么要做成**动态段数**：
 *   并不是每个任务都走完整链路。有 LLM 节点才有「优化提示词」，
 *   纯生图就直接「排队中 → 创作中」；生视频则末段是「生成视频」。
 *   所以段列表由调用方按实际工作流传进来，组件只负责渲染。
 *
 * 视觉：已完成段用强调色（走过了）、当前段高亮 + 流动箭头、未来段灰（还没到）。
 * 箭头用 CSS 动画（stage-flow-chevron）做明暗波动，表示「正在往下推进」。
 * 刻意不做成进度百分比 —— 这些阶段没有可靠的分母，假装精确反而误导。
 */

export type StageState = 'done' | 'active' | 'pending' | 'failed'

export type StageItem = {
  /** 阶段短名，如「优化提示词中」「排队中」「创作中」 */
  label: string
  state: StageState
}

export function StageFlow({ stages, className = '' }: { stages: StageItem[]; className?: string }) {
  if (stages.length === 0) return null

  return (
    <div className={`flex flex-wrap items-center gap-x-1.5 gap-y-1 ${className}`}>
      {stages.map((st, i) => {
        const color =
          st.state === 'failed' ? 'text-red-500'
          : st.state === 'active' ? 'text-accent'
          : st.state === 'done' ? 'text-black/55'
          : 'text-black/25'
        return (
          <span key={`${st.label}-${i}`} className="flex items-center gap-1.5">
            <span className={`text-[11px] leading-none transition-colors ${color} ${st.state === 'active' ? 'font-medium' : ''}`}>
              {st.label}
            </span>
            {/* 段间箭头：非末段才画。active 段后面的箭头做波动动画，表示这一跳正在进行 */}
            {i < stages.length - 1 && (
              <span
                aria-hidden
                className={`text-[10px] leading-none tracking-tighter ${
                  st.state === 'active' ? 'stage-flow-chevron text-accent'
                  : st.state === 'done' ? 'text-black/35'
                  : 'text-black/15'
                }`}
              >
                {'❯'.repeat(4)}
              </span>
            )}
          </span>
        )
      })}
    </div>
  )
}

/**
 * 把「已知的相位 / 状态」翻译成阶段列表。
 *
 * 刻意只认后端真给得出的信号，不自己编阶段：
 *   - llmStage → 这条路是否经过 LLM（Agent 有规划模型；纯生图工具没有）
 *   - phase=queued → 闸门排队；running → 已发出
 *   - status=done/error → 完成 / 失败
 *
 * llmStage 用 'running' | 'done' 而不是布尔：
 *   「正在优化提示词」和「已经理解完需求」是两个不同的展示态，
 *   用布尔会逼调用方在组件里再猜一次，不如让调用方按事实传。
 */
export function buildImageStages(opts: {
  /** 有 LLM 阶段才传；不传则整条流程条不含「提示词」那一段 */
  llmStage?: 'running' | 'done'
  /** LLM 阶段文案（不同工具语义不同：AI 写分镜 / 优化提示词） */
  llmStageLabel?: { running: string; done: string }
  phase?: 'queued' | 'running'
  status: 'running' | 'done' | 'error'
}): StageItem[] {
  const { llmStage, llmStageLabel, phase, status } = opts
  const stages: StageItem[] = []

  // LLM 还在跑时，后面生图/排队的阶段都还没发生 —— 只显示当前这一段，
  // 否则会出现「优化提示词中 + 创作中」两个 active 同时亮的误导。
  if (llmStage === 'running') {
    return [{
      label: llmStageLabel?.running ?? '优化提示词中',
      state: 'active',
    }]
  }
  if (llmStage === 'done') {
    stages.push({
      label: llmStageLabel?.done ?? '已理解需求',
      state: 'done',
    })
  }

  if (status === 'error') {
    stages.push({ label: '生成失败', state: 'failed' })
    return stages
  }
  if (status === 'done') {
    stages.push({ label: '排队中', state: 'done' })
    stages.push({ label: '创作完成', state: 'done' })
    return stages
  }

  // running：phase=running 表示已发出、等上游返回
  if (phase === 'running') {
    stages.push({ label: '排队中', state: 'done' })
    stages.push({ label: '创作中', state: 'active' })
  } else {
    // queued 或还没拿到相位（刚建占位）→ 「排队中」做当前段，不留空白
    stages.push({ label: '排队中', state: 'active' })
  }
  return stages
}
