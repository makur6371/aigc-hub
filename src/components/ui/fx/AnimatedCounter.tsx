'use client'

// ===== 数字滚动（odometer 风格）=====
//
// 灵感来自 rareui 的 Animated counter，但**零依赖、纯 CSS transform**实现，
// 适配本站微紫液态玻璃风格。数字变化时逐位上下滚动，而不是生硬跳变。
//
// 用途：积分/豆余额、运营统计、调用次数等「会变化的数字」。

import { useSyncExternalStore } from 'react'

/** 订阅 prefers-reduced-motion（SSR 安全：服务端恒为 false） */
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    () => false,
  )
}

interface AnimatedCounterProps {
  value: number
  /** 小数位（默认 0）；余额类常带 2 位 */
  decimals?: number
  /** 前缀（如 ¥ / 无） */
  prefix?: string
  /** 后缀（如 豆 / 积分） */
  suffix?: string
  className?: string
  /** 滚动时长 ms */
  duration?: number
}

/** 单个数字位：0-9 竖排，靠 translateY 滚到目标位 */
function Digit({ char, duration }: { char: string; duration: number }) {
  if (!/\d/.test(char)) {
    return <span className="inline-block">{char}</span>
  }
  const d = Number(char)
  return (
    <span className="relative inline-block overflow-hidden" style={{ height: '1em', lineHeight: 1 }}>
      <span
        className="flex flex-col"
        style={{
          transform: `translateY(-${d}em)`,
          transition: `transform ${duration}ms cubic-bezier(0.22, 1, 0.36, 1)`,
        }}
      >
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} style={{ height: '1em', lineHeight: 1 }}>{i}</span>
        ))}
      </span>
    </span>
  )
}

export function AnimatedCounter({ value, decimals = 0, prefix, suffix, className = '', duration = 500 }: AnimatedCounterProps) {
  const text = value.toFixed(decimals)
  // 尊重「减少动态效果」偏好：直接显示最终值，不做滚动
  const reduce = useReducedMotion()

  return (
    <span className={`inline-flex items-baseline tabular-nums ${className}`} aria-label={`${prefix ?? ''}${text}${suffix ?? ''}`}>
      {prefix && <span className="mr-0.5">{prefix}</span>}
      <span className="inline-flex" role="text">
        {text.split('').map((c, i) =>
          reduce
            ? <span key={i} className="inline-block">{c}</span>
            : <Digit key={i} char={c} duration={duration} />,
        )}
      </span>
      {suffix && <span className="ml-0.5 text-[0.7em] opacity-70">{suffix}</span>}
    </span>
  )
}
