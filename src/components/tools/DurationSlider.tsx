'use client'

import { useState } from 'react'
import { Slider } from 'antd'
import { MinusOutlined, PlusOutlined } from '@ant-design/icons'

/**
 * 视频时长滑条（2026-11-09）。
 *
 * 为什么抽组件：工具页、创作区规格弹层、Agent 偏好三处都用同一套交互；
 * 手机端拖动条不容易精确停在某一秒，所以滑条下方补「−1 秒 / ＋1 秒」大按钮，
 * 拖动时数值胶囊有一次轻微回弹（key 变化触发 CSS 动画），步进按钮带短震动反馈。
 */
export function DurationSlider({
  min,
  max,
  value,
  onChange,
  label = '时长',
  disabled = false,
  className,
}: {
  min: number
  max: number
  value: number
  onChange: (v: number) => void
  label?: string | null
  disabled?: boolean
  className?: string
}) {
  const current = Math.min(max, Math.max(min, Math.round(value)))
  // 拖动中用本地 draft 跟手：不每一步都写回父级（父级是大面板，逐步重渲染会拖慢手感），
  // 松手 onChangeComplete 再提交一次。
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? current
  const bump = (delta: number) => {
    const next = Math.min(max, Math.max(min, shown + delta))
    if (next === shown) return
    onChange(next)
    // 移动端轻震动；桌面/不支持时静默忽略
    try { navigator.vibrate?.(8) } catch { /* ignore */ }
  }

  return (
    <div
      className={`duration-slider ${className ?? ''}`}
      data-disabled={disabled ? 'true' : undefined}
      data-dragging={draft !== null ? 'true' : undefined}
    >
      <div className="flex items-baseline justify-between">
        {label != null && <span className="text-[12px] text-black/40">{label}</span>}
        <span key={shown} className="duration-value-pill ml-auto">{shown} 秒</span>
      </div>
      <Slider
        min={min}
        max={max}
        step={1}
        value={shown}
        disabled={disabled}
        tooltip={{ formatter: (v) => `${v} 秒` }}
        marks={{ [min]: `${min}s`, [max]: `${max}s` }}
        onChange={(v) => setDraft(v as number)}
        onChangeComplete={(v) => {
          setDraft(null)
          const next = v as number
          if (next !== current) onChange(next)
        }}
        className="duration-slider__input"
      />
      <div className="duration-step-row">
        <button
          type="button"
          className="duration-step"
          disabled={disabled || current <= min}
          onClick={() => bump(-1)}
          aria-label="减少 1 秒"
        >
          <MinusOutlined /> 1 秒
        </button>
        <button
          type="button"
          className="duration-step"
          disabled={disabled || current >= max}
          onClick={() => bump(1)}
          aria-label="增加 1 秒"
        >
          <PlusOutlined /> 1 秒
        </button>
      </div>
    </div>
  )
}
