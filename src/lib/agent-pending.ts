import type { AgentDeliverable } from '@/lib/agent-plan'
import type { AgentExecuteMode } from '@/lib/agent-preferences'

/**
 * 待确认队列：confirm 模式下，模型想花钱执行的动作先记在这里，不真跑。
 *
 * ===== 为什么需要它（设计要点）=====
 * 现在的 agent 是「边想边做」：模型一轮吐出 generate_image，当场就执行出图。
 * 要加「执行前确认」，直觉写法是 planning 后挂起等用户点确认 —— 但那是**补丁**：
 * 整个任务跑在一个 HTTP 请求的 async 函数里，挂起就等于把它挂在内存里等几分钟，
 * 用户刷新 / 容器重启 / nginx 超时，确认就永远丢了，任务卡死在 PAUSED。
 *
 * 正确形状是**两阶段、可落库**：
 *   1) confirm 模式下 runDeliverable 不执行，改为往队列里记一条「待确认执行」
 *      并回填一个合成结果给模型（让它以为已排队、继续收尾）
 *   2) 任务正常结束、状态置 PAUSED，队列**落进 GenerationTask.payload** 后请求结束
 *   3) 用户点确认 → 读库 → 真跑 → 回写
 * 全程不挂内存，重启/刷新都不丢。
 */
export interface PendingAction {
  /** 前端渲染与去重用的稳定键（taskId 内唯一） */
  id: string
  /**
   * 要执行的动作类型。当前 confirm 闸门只拦「花钱的执行类动作」
   * （generate_image / generate_video / generate_audio）；ask_user / finish 不拦。
   */
  kind: 'image' | 'video' | 'audio' | 'text'
  /** 交付物标题（用户在确认卡上看到的"这一步做什么"） */
  title: string
  /** 模型解析后的 id（可能为空 = 交给执行期按类型兜底） */
  modelId?: string
  /** **完整提示词**：确认卡的核心，用户要能看清它到底打算写什么 */
  prompt: string
  /** 张数（图片/多条文本） */
  count: number
  /** 图片比例（3:4 / 16:9 …） */
  ratio?: string
  /** 图片档位（1K/2K/4K） */
  quality?: string
  /** 视频清晰度档（480P/768P/1080P） */
  resolution?: string
  /** 视频时长（秒） */
  seconds?: number
  /** 音色 */
  voice?: string
  /** 依赖的前置 action id */
  dependencies?: string[]
  /** 引用的素材/上传图编号（assetIds） */
  assetIds?: string[]
  /**
   * 预估花费。**必须标成"预估"**：真实扣费在执行期（免费额度/折扣/按秒）
   * 才算得准，确认卡上给的是量级，不是承诺值。
   */
  estimate?: { points: number | null; beans: number | null }
}

/**
 * 把一封"待确认执行"写成回填给模型的合成 tool 结果。
 *
 * 为什么必须回填：模型是在多轮循环里推进的，它发出 generate_image 后
 * 期待一个 tool 返回。如果我们不回结果，下一轮它会以为动作失败而重试 ——
 * 用户就会在确认卡上看到同一个动作被排队十几次。
 */
export function queuedToolText(p: PendingAction): string {
  const unit = p.kind === 'text' ? '段' : '个'
  return `已加入待确认队列（用户尚未确认，暂未生成）：「${p.title}」${p.count > 1 ? ` × ${p.count}${unit}` : ''}。` +
    `请不要再重复提交同一动作，直接调用 finish 收尾并简要说明方案即可；用户确认后系统会实际执行。`
}

/** 从交付物类型映射到待确认动作的类型 */
export function actionKindOf(type: string): PendingAction['kind'] {
  if (type === 'image') return 'image'
  if (type === 'video') return 'video'
  if (type === 'audio') return 'audio'
  return 'text'
}

/**
 * confirm 模式判定：只有显式 'confirm' 才拦。
 *
 * 为什么要归一化而不是直接比较：这个值来自用户偏好（可被历史脏数据影响），
 * 「不认识」必须等同「全自动」—— 宁可少拦一次，也不能因为一条脏值
 * 把用户的任务莫名其妙卡在等待确认。
 */
export function shouldGateActions(mode: AgentExecuteMode | string | null | undefined): boolean {
  return mode === 'confirm'
}

/** 把 AgentDeliverable 转成待确认条目（两者字段几乎一一对应，这里集中映射避免漂移） */
export function toPendingAction(
  d: AgentDeliverable,
  index: number,
  estimate?: PendingAction['estimate'],
): PendingAction {
  return {
    id: d.id && String(d.id).trim() ? String(d.id) : `pending-${index}`,
    kind: actionKindOf(d.type),
    title: d.title || `第 ${index + 1} 步`,
    modelId: d.model,
    prompt: d.prompt || '',
    count: d.count && d.count >= 1 ? Math.min(d.count, 8) : 1,
    ratio: d.ratio,
    quality: d.quality,
    resolution: d.resolution,
    seconds: d.seconds,
    voice: d.voice,
    dependencies: d.dependencies,
    assetIds: d.assetIds,
    estimate,
  }
}
