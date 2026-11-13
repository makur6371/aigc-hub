import { getPrisma } from '@/lib/prisma'
import { getImageCapabilities, supportsImageSize } from '@/lib/image-sizes'
import {
  getVideoCapabilities,
  normalizeVideoResolution,
  resolveVideoDurations,
} from '@/lib/video-capabilities'

/** 执行权限：auto = 规划完直接执行；confirm = 先列计划等用户确认再执行 */
export type AgentExecuteMode = 'auto' | 'confirm'

/**
 * 执行权限归一化：只认字面量，其它一律回落 auto。
 * 为什么不用 truthy 判断：DB 里可能存进历史脏值，回落 auto 保证「不认识就当全自动」，
 * 绝不因为一条脏数据把用户的任务卡在等待确认。
 */
export function normalizeExecuteMode(raw: unknown): AgentExecuteMode {
  return raw === 'confirm' ? 'confirm' : 'auto'
}

export interface AgentPreferencesShape {
  imageModelId: string | null
  videoModelId: string | null
  audioModelId: string | null
  imageRatio: string | null
  imageTier: string | null
  imageQuality: string | null
  /**
   * 视频偏好（2026-10-26）—— 与图片三项同构：
   * 先选模型，再由该模型 metadata.video.constraints 决定可选值。
   * 为什么单独存而不是塞进 imageRatio：图片与视频的比例集合不同
   * （视频常常只支持 16:9 / 9:16 / 1:1），混用会让 planner 拿到非法组合。
   */
  videoRatio: string | null
  videoResolution: string | null
  /** 时长（秒）。模型可能只支持固定档位。 */
  videoDuration: number | null
  /**
   * 用户手填的长期记忆 / 自我描述（全局生效）。
   *
   * 与上面 6 列的区别：那些是**技术参数**（用哪个模型、什么比例），
   * 这列是**关于用户本人的知识**（做什么业务、卖什么、偏好什么风格）。
   * 每轮注入 Agent 上下文，避免它反复问同样的事。
   */
  memoryText: string | null
  /** 执行权限（auto / confirm） */
  executeMode: AgentExecuteMode
}

interface PreferenceModelLike {
  metadata?: unknown
}

export interface AgentPreferenceSpecInput {
  imageModel?: PreferenceModelLike | null
  videoModel?: PreferenceModelLike | null
  imageRatio?: string | null
  imageTier?: string | null
  videoRatio?: string | null
  videoResolution?: string | null
  videoDuration?: number | null
}

/**
 * 保存偏好时的服务端规格校验。
 *
 * 前端只展示合法项，但接口仍可能收到旧页面、脚本或模型配置变更后的脏值；
 * 这里必须再校验一次，避免把“模型不支持的比例/档位/时长”保存成全局默认。
 */
export function validateAgentPreferenceSpecs(input: AgentPreferenceSpecInput): string | null {
  const imageMeta = (input.imageModel?.metadata ?? {}) as Record<string, unknown>
  if (input.imageModel && (input.imageRatio || input.imageTier)) {
    if (input.imageTier && !input.imageRatio) {
      return '设置图片档位前请先选择画面比例'
    }
    // 空 metadata 会返回 true，不限制旧模型；声明了 sizes 后严格校验组合。
    const supports = supportsImageSize(
      getImageCapabilities({ metadata: imageMeta }),
      input.imageRatio,
      input.imageTier,
    )
    if (!supports) {
      return `生图模型不支持规格 ${input.imageRatio ?? ''}${input.imageTier ? `@${input.imageTier}` : ''}`
    }
  }

  const videoMeta = (input.videoModel?.metadata ?? {}) as Record<string, unknown>
  if (input.videoModel) {
    const cap = getVideoCapabilities({ metadata: videoMeta })
    if (input.videoRatio && cap.ratios.length > 0 && !cap.ratios.includes(input.videoRatio)) {
      return `视频模型不支持比例 ${input.videoRatio}`
    }
    if (input.videoResolution && cap.resolutions.length > 0) {
      const want = normalizeVideoResolution(input.videoResolution)
      const supported = cap.resolutions.some((r) => normalizeVideoResolution(r) === want)
      if (!supported) return `视频模型不支持清晰度 ${input.videoResolution}`
    }
    if (input.videoDuration != null && !resolveVideoDurations(cap).includes(input.videoDuration)) {
      return `视频模型不支持 ${input.videoDuration} 秒`
    }
  }

  return null
}

const DEFAULT_PREFS: AgentPreferencesShape = {
  imageModelId: null, videoModelId: null, audioModelId: null,
  imageRatio: null, imageTier: null, imageQuality: null,
  videoRatio: null, videoResolution: null, videoDuration: null,
  memoryText: null,
  executeMode: 'auto',
}

/** 读取用户 Agent 全局偏好（每次实时读，改动立即生效；量小无需缓存） */
export async function getAgentPreferences(userId: string): Promise<AgentPreferencesShape> {
  const prisma = await getPrisma()
  const record = await prisma.agentPreference.findUnique({ where: { userId } })
  if (!record) return { ...DEFAULT_PREFS }
  return {
    imageModelId: record.imageModelId,
    videoModelId: record.videoModelId,
    audioModelId: record.audioModelId,
    imageRatio: record.imageRatio,
    imageTier: record.imageTier,
    imageQuality: record.imageQuality,
    videoRatio: record.videoRatio,
    videoResolution: record.videoResolution,
    videoDuration: record.videoDuration,
    memoryText: record.memoryText,
    executeMode: normalizeExecuteMode(record.executeMode),
  }
}
