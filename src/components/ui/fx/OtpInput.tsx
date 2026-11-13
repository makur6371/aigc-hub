'use client'

// ===== 验证码输入（逐格 + 插入动画）=====
//
// 灵感来自 rareui 的 OTP Input；本站登录/注册目前是普通 Input 填 6 位码，
// 换成逐格输入体验更清晰（也更像现代 App）。零依赖。

import { useRef } from 'react'

interface OtpInputProps {
  value: string
  onChange: (v: string) => void
  length?: number
  disabled?: boolean
  /** 全部填满时回调（便于自动提交） */
  onComplete?: (v: string) => void
  autoFocus?: boolean
}

export function OtpInput({ value, onChange, length = 6, disabled, onComplete, autoFocus }: OtpInputProps) {
  const refs = useRef<Array<HTMLInputElement | null>>([])
  const chars = value.padEnd(length, ' ').slice(0, length).split('')

  const setAt = (i: number, c: string) => {
    const arr = chars.map((x) => (x === ' ' ? '' : x))
    arr[i] = c
    const next = arr.join('')
    onChange(next)
    if (next.length === length && !next.includes(' ')) onComplete?.(next)
  }

  return (
    <div className="flex items-center gap-2">
      {Array.from({ length }, (_, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el }}
          value={chars[i] === ' ' ? '' : chars[i]}
          disabled={disabled}
          autoFocus={autoFocus && i === 0}
          inputMode="numeric"
          maxLength={1}
          className="size-11 rounded-xl border border-black/10 bg-white text-center text-lg font-medium tabular-nums text-foreground outline-none transition focus:border-accent focus:bg-accent-soft focus:ring-2 focus:ring-accent-ring disabled:opacity-50"
          onChange={(e) => {
            const c = e.target.value.replace(/\D/g, '').slice(-1)
            setAt(i, c)
            if (c && i < length - 1) refs.current[i + 1]?.focus()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace') {
              e.preventDefault()
              if (chars[i] !== ' ') {
                setAt(i, '')
              } else if (i > 0) {
                setAt(i - 1, '')
                refs.current[i - 1]?.focus()
              }
            } else if (e.key === 'ArrowLeft' && i > 0) {
              refs.current[i - 1]?.focus()
            } else if (e.key === 'ArrowRight' && i < length - 1) {
              refs.current[i + 1]?.focus()
            }
          }}
          onPaste={(e) => {
            e.preventDefault()
            const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length)
            if (pasted) {
              onChange(pasted)
              if (pasted.length === length) onComplete?.(pasted)
              refs.current[Math.min(pasted.length, length - 1)]?.focus()
            }
          }}
        />
      ))}
    </div>
  )
}
