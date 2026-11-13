'use client'

import { useState } from 'react'
import { App, Button, Modal, Segmented, Slider } from 'antd'
import { apiFetch } from '@/lib/api-client'
import type { ResultItem } from '@/stores/useToolRunStore'

/**
 * GIF 调速：只拿原始宫格大图重新切帧编码，不重新生图、不扣积分。
 * 合成参数（宫格/选帧/裁切）沿用第一次生成时的快照，保证画面一致。
 */
export function GifSpeedModal({
  item,
  onClose,
  onReplaced,
}: {
  item: ResultItem
  onClose: () => void
  onReplaced: (newUrl: string, delayMs: number, mode: 'normal' | 'pingpong') => void
}) {
  const { message } = App.useApp()
  const src = item.gifSource
  // 弹窗由父层按 item 重新挂载（key=url），这里用初始化值即可，不需要 effect 同步
  const [delay, setDelay] = useState(src?.delayMs ?? 150)
  const [mode, setMode] = useState<'normal' | 'pingpong'>(
    ['pingpong', 'ping-pong', '往返乒乓', '乒乓', '往返'].includes(String(src?.mode ?? '').toLowerCase())
      ? 'pingpong'
      : 'normal',
  )
  const [applying, setApplying] = useState(false)

  if (!src) return null

  const apply = async () => {
    setApplying(true)
    try {
      const res = await apiFetch<{ gifUrl: string }>('/api/gif/respeed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrl: item.gifSource!.imageUrl,
          grid: item.gifSource!.grid,
          frames: item.gifSource!.frames,
          mode,
          delayMs: delay,
          trimPercent: item.gifSource!.trimPercent,
          maxSize: item.gifSource!.maxSize,
          background: item.gifSource!.background,
        }),
      })
      if (!res.success || !res.data?.gifUrl) throw new Error(res.message || '调速失败')
      onReplaced(res.data.gifUrl, delay, mode)
      message.success(`已按 ${delay}ms 重新合成 GIF`)
      onClose()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '调速失败')
    } finally {
      setApplying(false)
    }
  }

  const fps = delay > 0 ? (1000 / delay).toFixed(1) : '—'

  return (
    <Modal
      open
      onCancel={onClose}
      title="调整 GIF 速度"
      okText="重新合成"
      cancelText="取消"
      confirmLoading={applying}
      onOk={() => void apply()}
      destroyOnHidden
      width={460}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-center rounded-xl border border-black/6 bg-black/[0.03] p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={item.url} alt="当前 GIF" className="max-h-56 max-w-full rounded-lg object-contain" />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-[13px]">
            <span className="font-medium">每帧停留</span>
            <span className="tabular-nums text-accent">{delay}ms · {fps} FPS</span>
          </div>
          <Slider
            min={40}
            max={600}
            step={10}
            value={delay}
            onChange={(v) => setDelay(v)}
            tooltip={{ formatter: (v) => `${v}ms` }}
          />
          <div className="flex justify-between text-[11px] text-black/40">
            <span>快 40ms</span><span>适中 150ms</span><span>慢 600ms</span>
          </div>
        </div>
        <div>
          <div className="mb-1 text-[13px] font-medium">播放模式</div>
          <Segmented
            block
            value={mode}
            onChange={(v) => setMode(v as 'normal' | 'pingpong')}
            options={[
              { value: 'normal', label: '正序循环' },
              { value: 'pingpong', label: '往返乒乓' },
            ]}
          />
        </div>
        <p className="text-[11px] leading-relaxed text-black/45">
          只重新切帧合成，不重新生图、不扣积分；宫格规格、选帧与裁格线沿用刚才的设置。
        </p>
      </div>
    </Modal>
  )
}
