'use client'

import { useState } from 'react'
import { Select } from 'antd'
import { readLocalText, removeLocalKey, writeLocalText } from '@/lib/local-store'
import { getVideoCapabilities, isSelectableVideoModel, VIDEO_MODE_LABELS, videoBeansLabel } from '@/lib/video-capabilities'
import { AUTO_LLM_MODEL_ID, AUTO_LLM_MODEL_NAME } from '@/lib/auto-llm'
import {
  RobotOutlined,
  CheckOutlined,
  PushpinOutlined,
} from '@ant-design/icons'

/**
 * 生图/视频模型选择器 —— 平台**唯一一份**实现。
 *
 * ===== 为什么抽出来（2026-10-25 用户严厉指出）=====
 * 之前这段逻辑内联在 `tools/[slug]/slot-controls.tsx` 的 `slot.type === 'model'` 分支里。
 * 后来新增的电商 Agent 面板**又手写了一个 `<Select>`** —— 于是：
 *   · 电商 Agent 的下拉只有模型名，没有价格三列、没有「免费剩 N 次」、没有折扣标签；
 *   · 用户看不出免费额度，也就不可能用到它（这正是用户报的「根本没用上免费额度」）；
 *   · 「收起态 + 更改」「设为默认/取消默认」这些平台已有交互也全丢了。
 * 每加一个工具就重写一遍、然后再补一遍 —— 这是本项目反复犯的错。
 *
 * 现在把内联那段**原样搬**到这里，两个入口共用：
 *   · `SlotControl` 的 model 槽位（参数形式不变）
 *   · 电商 Agent 面板（直接调组件）
 * 以后新增工具一律调这个组件，不要再手写 `<Select>`。
 *
 * ===== 保留的全部平台能力 =====
 * 1. 三列价格：模型名 / 原价（划线）/ 现价（免费、折扣、豆价高亮）
 * 2. 免费额度：`每日免费 N 次` + 「免费剩 N 次」实时剩余
 * 3. 豆计价模型（VIDEO）单独走豆口径，不显示成「0 积分」
 * 4. 收起态：选中后收成一行摘要 + 「更改」，避免每次生成看一长串下拉
 * 5. 设为默认 / 取消默认：本地记忆，下次自动选中并收起
 */

export type ModelPickerModel = {
  id: string
  name: string
  type: string
  pricingType?: string
  isFree?: boolean
  videoCost?: number | null
  discount?: number | null
  metadata?: Record<string, unknown> | null
  dailyUserFreeQuota?: number | null
  freeQuotaRemaining?: number | null
  /** 套餐赠送期内：该生图模型免费（不依赖每日额度） */
  promoFreeImage?: boolean
  listPoints?: number | null
  effectivePoints?: number | null
  effectiveCostPoints?: number | null
}

/** 模型「设为默认」的本地存储 key 前缀（按 工具+槽位 记忆，互不串味） */
const MODEL_DEFAULT_LS_PREFIX = 'toolhub:model-default:'

export function readDefaultModelId(persistKey?: string): string {
  if (!persistKey || typeof window === 'undefined') return ''
  return readLocalText(MODEL_DEFAULT_LS_PREFIX + persistKey) || ''
}

export function writeDefaultModelId(persistKey: string | undefined, id: string) {
  if (!persistKey || typeof window === 'undefined') return
  // 走规范层（Q-D55）：隐私模式写不了时静默忽略 —— 这条约定由规范层统一保证
  if (id) writeLocalText(MODEL_DEFAULT_LS_PREFIX + persistKey, id)
  else removeLocalKey(MODEL_DEFAULT_LS_PREFIX + persistKey)
}

/**
 * 模型类型过滤 —— 口径与原来的 slot-controls 内联版**完全一致**：
 * TEXT 槽可用 VISION 模型（VISION 具备完整文本能力），不是单向的 VISION→TEXT。
 */
export const MODEL_TYPE_FILTER: Record<string, string[]> = {
  TEXT: ['TEXT', 'VISION'],
  VISION: ['VISION'],
  IMAGE: ['IMAGE'],
  VIDEO: ['VIDEO'],
  AUDIO: ['AUDIO'],
}

/**
 * 模型行（名字 / 原价 / 现价）—— 供下拉与「创作区模型弹层」共用。
 *
 * 为什么抽出来：创作区的模型选择是「chip → 弹层 → 列表」一层到底，
 * 不再套 antd Select（那是经典面板的形态）。两处必须共用同一套价格展示，
 * 否则「显示多少」和「实际扣多少」会再次分叉（视频豆价曾因此显示成免费）。
 */
export function ModelOptionRow({ m }: { m: ModelPickerModel }) {
  const quota = m.dailyUserFreeQuota ?? 0
  const remaining = m.freeQuotaRemaining ?? null
  const hasQuotaLeft = quota > 0 && (remaining ?? 0) > 0
  const free = !!m.isFree || hasQuotaLeft || m.promoFreeImage === true
  const original = m.listPoints ?? m.effectiveCostPoints ?? null
  const now = m.effectivePoints ?? m.effectiveCostPoints ?? null
  const ratio = (!m.isFree && original != null && now != null && now > 0 && now < original)
    ? now / original
    : null
  const perToken = m.pricingType === 'PER_TOKEN'
  const unitText = perToken ? '积分/Token' : '积分'
  const isVideoModel = m.type === 'VIDEO'
  const beanLabel = videoBeansLabel(m.videoCost, m.metadata, m.discount)
  // 视频模型在名字的 title 上补充支持的生成方式（选择前就能判断适不适配）
  const modeHint = isVideoModel
    ? getVideoCapabilities(m).modes.map((x) => VIDEO_MODE_LABELS[x] ?? x).join(' · ')
    : ''
  return (
    <span className="flex w-full items-center gap-2">
      <span className="min-w-[140px] flex-1 truncate" title={modeHint ? `${m.name}（${modeHint}）` : m.name}>{m.name}</span>
      <span className="w-20 shrink-0 text-right text-[11px] tabular-nums text-black/35 line-through">
        {free || ratio == null ? '' : `${original} ${unitText}`}
      </span>
      <span
        className={`${isVideoModel ? 'w-36' : 'w-24'} shrink-0 text-right text-[11px] leading-tight tabular-nums`}
        title={beanLabel ?? undefined}
      >
        {isVideoModel ? (
          <span className="rounded-full bg-amber-50 px-1.5 py-0.5 font-medium text-amber-600">
            {beanLabel ?? '按用量计费'}
          </span>
        ) : free ? (
          <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-600">
            免费使用
          </span>
        ) : ratio != null ? (
          <span className="inline-flex items-center gap-1">
            <span className="rounded-full bg-rose-50 px-1.5 py-0.5 font-medium text-rose-500">
              {(ratio * 10).toFixed(1)}折
            </span>
            <span className="font-medium text-black/70">{now} {unitText}</span>
          </span>
        ) : (
          <span className="text-black/55">{now} {unitText}</span>
        )}
      </span>
    </span>
  )
}

export function ModelPicker({
  models,
  value,
  onChange,
  modelType = 'IMAGE',
  required = false,
  persistKey,
  message,
}: {
  /** 全部模型（由 /api/models 提供，含价格与免费额度字段） */
  models: ModelPickerModel[]
  /** 当前选中的模型 id（空串 = 未选） */
  value: string
  onChange: (id: string) => void
  /**
   * 要展示哪类模型。
   *
   * 'ANY' = 不做过滤（调用方已自己筛好）。
   * 为什么需要它：电商 Agent 的「视觉模型」是 VISION + TEXT 混合
   * （LLM 也能做提示词生成），传 'VISION' 会把 TEXT 滤掉，传 'TEXT' 又会把 VISION 滤掉。
   */
  modelType?: string
  required?: boolean
  /** 设为默认的持久化 key（不传 = 不提供「设为默认」） */
  persistKey?: string
  message?: { success: (t: string) => void; info: (t: string) => void }
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const byType = modelType === 'ANY'
    ? models
    : models.filter((m) => (MODEL_TYPE_FILTER[modelType] ?? [modelType]).includes(m.type))
  const autoEligible = modelType === 'TEXT' || modelType === 'VISION' || modelType === 'ANY'
  const withAuto: ModelPickerModel[] = autoEligible
    ? [{ id: AUTO_LLM_MODEL_ID, name: AUTO_LLM_MODEL_NAME, type: 'TEXT' }, ...byType]
    : byType
  // 视频选择器排除「固定专属工具」的模型（数字人对口型 / 动作迁移）。
  // 当前已选中的若恰是这类模型（工具里预设的），仍保留一行 —— 否则收起态会显示成裸 id。
  const filtered = (() => {
    if (modelType !== 'VIDEO' && modelType !== 'ANY') return withAuto
    const visible = withAuto.filter(isSelectableVideoModel)
    const selected = withAuto.find((m) => m.id === value && !isSelectableVideoModel(m))
    return selected ? [selected, ...visible] : visible
  })()
  const currentModel = withAuto.find((m) => m.id === value)
  // 收起/展开只在选了模型之后才提供（没选之前必须展开让用户挑）
  const collapsed = value !== '' && !pickerOpen

  if (collapsed) {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex max-w-[260px] items-center gap-1.5 rounded-xl border border-accent-ring/70 bg-accent-soft/40 px-2.5 py-1.5 text-[12.5px]">
          <RobotOutlined className="text-accent/70" />
          <span className="truncate" title={currentModel?.name || value}>{currentModel?.name || '已选模型'}</span>
        </span>
        <button
          type="button"
          className="rounded-lg border border-black/10 bg-white px-2 py-1 text-[12px] text-black/60 transition hover:border-accent-ring hover:text-accent"
          onClick={() => setPickerOpen(true)}
        >
          更改
        </button>
        {persistKey && readDefaultModelId(persistKey) === value && (
          <span className="inline-flex items-center gap-1 text-[11px] text-accent">
            <CheckOutlined className="text-[10px]" /> 已设为默认
          </span>
        )}
      </div>
    )
  }

  return (
    <>
      <Select
        className="w-full max-w-xs [&>.ant-select-selector]:!rounded-xl"
        classNames={{ popup: { root: 'composer-popup backdrop-blur-2xl backdrop-saturate-150' } }}
        allowClear
        placeholder="请选择模型"
        value={value || undefined}
        onChange={(v) => onChange(v ?? '')}
        status={required && !value ? 'warning' : undefined}
        // 下拉面板独立宽度：三列（名字/原价/现价）需要空间，
        // 跟着选择框的 max-w-xs(320px) 会把模型名挤没（只剩省略号）。
        popupMatchSelectWidth={380}
        listHeight={360}
        options={filtered.map((m) => ({
          value: m.id,
          label: <ModelOptionRow m={m} />,
        }))}
      />
      {value && persistKey && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-black/40">
          {readDefaultModelId(persistKey) === value ? (
            <>
              <span className="inline-flex items-center gap-1 text-accent">
                <CheckOutlined className="text-[10px]" /> 已设为默认
              </span>
              <button
                type="button"
                className="underline decoration-dotted hover:text-accent"
                onClick={() => {
                  writeDefaultModelId(persistKey, '')
                  setPickerOpen(true)
                  message?.info('已取消默认，下次不再自动选择')
                }}
              >
                取消默认
              </button>
            </>
          ) : (
            <button
              type="button"
              className="inline-flex items-center gap-1 underline decoration-dotted hover:text-accent"
              onClick={() => {
                writeDefaultModelId(persistKey, value)
                setPickerOpen(false)
                message?.success('已设为默认，下次自动使用（模型与参数仍在「系统设置」里管理）')
              }}
            >
              <PushpinOutlined className="text-[10px]" /> 设为默认
            </button>
          )}
          <span className="text-black/30">默认模型仅在本地记忆，不改变全局配置</span>
        </div>
      )}
    </>
  )
}
