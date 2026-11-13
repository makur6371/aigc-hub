'use client'

// ===== 就地确认按钮（无需弹窗）=====
//
// 灵感来自 rareui 的 Delete button：点一下展开「确认/取消」，再点确认才执行，
// 不弹 Modal 打断流程。适配本站紫玻璃风格。
//
// 用途：成果区删除单条、素材库删除、记录清理等「轻量破坏性操作」。

import { useState, useEffect } from 'react'
import { DeleteOutlined, CheckOutlined, CloseOutlined } from '@ant-design/icons'

interface ConfirmButtonProps {
  onConfirm: () => void | Promise<void>
  title?: string
  /** 触发图标（默认垃圾桶） */
  icon?: React.ReactNode
  className?: string
  /** 按钮尺寸 */
  size?: 'sm' | 'md'
  /** 视觉变体：overlay=深色圆底（叠在图片上）；ghost=浅色幽灵（列表行内） */
  variant?: 'overlay' | 'ghost'
  disabled?: boolean
}

export function ConfirmButton({ onConfirm, title = '删除', icon, className = '', size = 'sm', variant = 'overlay', disabled }: ConfirmButtonProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  // Esc 取消
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const box = size === 'sm' ? 'size-7' : 'size-9'
  const iconCls = size === 'sm' ? 'text-xs' : 'text-sm'
  const idleCls = variant === 'ghost'
    ? 'rounded p-1 text-black/25 hover:bg-black/5 hover:text-red-400'
    : `grid ${box} place-items-center rounded-full bg-black/50 text-white backdrop-blur hover:bg-danger`
  const activeCls = variant === 'ghost'
    ? 'flex items-center gap-1 rounded bg-black/5 px-1 py-0.5'
    : `flex items-center gap-1 rounded-full bg-black/70 p-0.5 backdrop-blur`
  const confirmCls = variant === 'ghost'
    ? 'grid size-5 place-items-center rounded text-red-400 hover:bg-red-50'
    : 'grid size-6 place-items-center rounded-full text-white hover:bg-danger'
  const cancelCls = variant === 'ghost'
    ? 'grid size-5 place-items-center rounded text-black/40 hover:bg-black/5'
    : 'grid size-6 place-items-center rounded-full text-white/80 hover:bg-white/20'

  if (!open) {
    return (
      <button
        type="button"
        title={title}
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={`${idleCls} transition-colors ${className}`}
      >
        {icon ?? <DeleteOutlined className={iconCls} />}
      </button>
    )
  }

  return (
    <div className={`${activeCls} ${className}`}>
      <button
        type="button"
        title="确认"
        disabled={busy}
        onClick={async () => { setBusy(true); try { await onConfirm() } finally { setBusy(false); setOpen(false) } }}
        className={confirmCls}
      >
        <CheckOutlined className="text-xs" />
      </button>
      <button
        type="button"
        title="取消"
        disabled={busy}
        onClick={() => setOpen(false)}
        className={cancelCls}
      >
        <CloseOutlined className="text-xs" />
      </button>
    </div>
  )
}
