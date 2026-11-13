'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Tooltip } from 'antd'

export interface PromptEditorProps {
  value: string
  onChange: (v: string) => void
  /** 已连接参考图缩略图列表（仅供展示提示，不参与文本内联） */
  references: { src: string }[]
  placeholder?: string
  minHeight?: string
  className?: string
  /** 填充模式：无边框无底色，直接铺满外层玻璃面板（浮动填写面板用） */
  fill?: boolean
}

// 纯文本编辑器：参考图通过 referenceImage 端口连线按序传入，提示词用「第一张图/第二张图…」自然语言指代，
// 不做任何 @图N 特殊语法（各生图模型对参考图指代支持不一，内联解析维护成本高且容易误导模型）。
export function PromptEditor({ value, onChange, placeholder, minHeight, className, fill }: PromptEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const lastSerializedRef = useRef<string>(value)
  // 光标是否在编辑器内（用 selection 实时判断，不做受控渲染）
  const focusedRef = useRef(false)

  // value 文本 → DOM 纯文本（无芯片）
  const renderFromValue = useCallback((text: string) => {
    const el = editorRef.current
    if (!el) return
    // 仅当 DOM 文本与 value 不一致才重建，避免输入过程中被覆盖
    if (el.innerText.replace(/\n$/, '') === text && lastSerializedRef.current === text) return
    el.innerHTML = ''
    el.appendChild(document.createTextNode(text))
    lastSerializedRef.current = text
  }, [])

  useEffect(() => {
    renderFromValue(value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (value !== lastSerializedRef.current) {
      renderFromValue(value)
    }
  }, [value, renderFromValue])

  const emitChange = () => {
    const el = editorRef.current
    if (!el) return
    // contentEditable 的 innerText 末尾可能带换行，trim 掉尾换行保持与 value 一致
    let text = el.innerText ?? ''
    if (text.endsWith('\n')) text = text.replace(/\n$/, '')
    lastSerializedRef.current = text
    onChange(text)
  }

  const handleInput = () => {
    emitChange()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // 允许换行（提示词常多行），不拦截
    }
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault()
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'))
  }

  return (
    <div
      ref={editorRef}
      contentEditable
      suppressContentEditableWarning
      data-placeholder={placeholder}
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onFocus={() => { focusedRef.current = true }}
      onBlur={() => { focusedRef.current = false }}
      style={minHeight ? { minHeight } : undefined}
      className={fill
        ? `prompt-editor max-h-[200px] overflow-y-auto w-full px-2.5 py-2 text-xs leading-relaxed focus:bg-white outline-none whitespace-pre-wrap aigc-hub-scrollbar ${className ?? ''}`
        : `prompt-editor min-h-[160px] max-h-[420px] resize-y overflow-y-auto w-full rounded-[10px] border border-border bg-white px-2.5 py-2 text-xs leading-relaxed focus:border-accent/60 outline-none whitespace-pre-wrap aigc-hub-scrollbar ${className ?? ''}`}
    />
  )
}

// 参考图条缩略图：悬停预览大图，展示连线顺序（第几张图）；不再插入 @ 到提示词
export function RefThumb({ src, index }: { src: string; index: number }) {
  return (
    <Tooltip title={
      <div className="max-w-[220px]">
        <img src={src} alt="" style={{ width: 200, borderRadius: 8, display: 'block' }} />
        <div className="mt-1 text-[11px] text-center">第 {index + 1} 张参考图</div>
      </div>
    }>
      <button
        type="button"
        className="cursor-pointer transition-transform hover:scale-105 active:scale-95 relative"
        title={`第 ${index + 1} 张参考图`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={`第${index + 1}张参考图`} className="size-[45px] shrink-0 rounded-[10px] border border-border object-cover" />
        <span className="absolute bottom-0.5 right-0.5 rounded bg-black/55 px-1 text-[9px] leading-[14px] text-white">{index + 1}</span>
      </button>
    </Tooltip>
  )
}
