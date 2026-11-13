'use client'

import { useState } from 'react'
import { Popover } from 'antd'
import { PictureOutlined, VideoCameraOutlined, SoundOutlined, PlusOutlined } from '@ant-design/icons'
import { SlotControl, type ToolSlot, type ModelOption } from '@/app/(app)/tools/[slug]/slot-controls'
import { toAssetProxyUrl } from '@/lib/media-url'

type MessageApi = { success: (t: string) => void; error: (t: string) => void; warning: (t: string) => void; info: (t: string) => void }

const UPLOAD_ICON: Record<string, React.ReactNode> = {
  image: <PictureOutlined />,
  video: <VideoCameraOutlined />,
  audio: <SoundOutlined />,
}

/** 扇形叠放的参数：偏移、旋转、纵向错位 */
function fanLayout(count: number, index: number) {
  const step = 14
  const x = index * step
  const mid = (count - 1) / 2
  const y = Math.abs(index - mid) * 1.8
  const rotate = (index - mid) * 7
  return { x, y, rotate }
}

/**
 * 素材簇：多张素材叠成一摞小圆卡，悬停展开成一行，点击打开弹层增删。
 *
 * 为什么用圆形叠放而不是方形网格：圆形叠在一起边缘不互相遮挡，
 * 一眼看出「有几张」，且与玻璃 chip 的圆润语言一致。
 */
export function ComposerFan({
  slot,
  value,
  models,
  selectedModelId,
  videoMode,
  message,
  onChangeSlot,
  onUploadActivityChange,
}: {
  slot: ToolSlot
  value: unknown
  models: ModelOption[]
  selectedModelId?: string
  videoMode?: string
  message: MessageApi
  onChangeSlot: (slotId: string, v: unknown) => void
  onUploadActivityChange: (active: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const items = (Array.isArray(value) ? value : value ? [value] : []) as string[]
  const kind = slot.accept?.[0] ?? 'image'
  const shown = items.slice(0, 4)
  const extra = items.length - shown.length

  const spread = (el: HTMLElement | null) => {
    if (!el) return
    Array.from(el.children).forEach((child, idx) => {
      const node = child as HTMLElement
      if (node.dataset.extra) {
        node.style.transform = `translate(${idx * 30}px, 0px)`
        return
      }
      const layout = fanLayout(shown.length, idx)
      node.style.transform = `translate(${layout.x}px, ${layout.y}px) rotate(${layout.rotate}deg)`
    })
  }

  const fanOut = (el: HTMLElement | null) => {
    if (!el) return
    Array.from(el.children).forEach((child, idx) => {
      const node = child as HTMLElement
      if (node.dataset.extra) {
        node.style.transform = `translate(${idx * 30}px, 0px)`
        return
      }
      node.style.transform = `translate(${idx * 30}px, 0px) rotate(${idx % 2 === 0 ? -5 : 5}deg) scale(1.06)`
    })
  }

  return (
    <Popover
      classNames={{ root: 'composer-popup backdrop-blur-2xl backdrop-saturate-150' }}
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="topLeft"
      content={
        <div className="composer-popup w-64 p-1">
          <SlotControl
            slot={slot}
            value={value}
            models={models}
            selectedModelId={selectedModelId}
            videoMode={videoMode}
            message={message}
            onChange={(v) => onChangeSlot(slot.id, v)}
            onUploadActivityChange={onUploadActivityChange}
          />
        </div>
      }
    >
      <button
        type="button"
        title={`${slot.label}${items.length > 0 ? `（已传 ${items.length}）` : ''}`}
        className="composer-attach"
      >
        {items.length === 0 ? (
          <span className="grid size-6 place-items-center rounded-full bg-white/80 text-[13px] text-accent shadow-[inset_0_-1px_2px_rgba(0,0,0,0.08)]">
            {UPLOAD_ICON[kind] ?? <PlusOutlined />}
          </span>
        ) : (
          <span
            className="composer-fan"
            style={{ width: 30 + Math.max(0, shown.length - 1) * 14 }}
            onMouseEnter={(e) => fanOut(e.currentTarget)}
            onMouseLeave={(e) => spread(e.currentTarget)}
          >
            {shown.map((url, i) => {
              const layout = fanLayout(shown.length, i)
              return (
                <span
                  key={url + i}
                  className="composer-fan-item"
                  style={{ transform: `translate(${layout.x}px, ${layout.y}px) rotate(${layout.rotate}deg)`, zIndex: shown.length - i }}
                >
                  {kind === 'image' ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={toAssetProxyUrl(url)} alt="" className="size-full object-cover" />
                  ) : (
                    <span className="grid size-full place-items-center text-[11px] text-accent">{UPLOAD_ICON[kind]}</span>
                  )}
                </span>
              )
            })}
            {extra > 0 ? (
              <span
                data-extra="1"
                className="absolute left-0 top-0 grid size-6 place-items-center rounded-full bg-white/90 text-[10px] font-medium text-accent shadow-[0_3px_10px_rgba(74,46,150,0.18)]"
                style={{ transform: `translate(${shown.length * 14}px, 0)`, zIndex: 0 }}
              >
                +{extra}
              </span>
            ) : null}
          </span>
        )}
        <span className="max-w-24 truncate">{slot.label}</span>
      </button>
    </Popover>
  )
}
