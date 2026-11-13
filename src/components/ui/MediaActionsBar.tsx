'use client'

import { App, Button } from 'antd'
import { CopyOutlined, DownloadOutlined, CloseOutlined } from '@ant-design/icons'
import { downloadResults } from '@/lib/download-results'
import { copyMediaToClipboard, type MediaKind } from '@/lib/media-clipboard'

/**
 * 图片 / GIF / 视频 / 音频的统一操作条。
 *
 * 为什么要统一：各页面自己写「下载」时容易出现三种问题 ——
 *   1. 只有 hover 才出现（移动端看不到）；
 *   2. 外链直接 <a download> 不生效，只能长按保存；
 *   3. GIF 复制没有首帧兜底。
 * 这里统一走 downloadResults（外链代理 + 正确扩展名）与 copyMediaToClipboard。
 */
export function MediaActionsBar({
  url,
  kind,
  name,
  onClose,
  align = 'end',
  compact = false,
}: {
  url: string | null | undefined
  kind: MediaKind | string
  name?: string
  onClose?: () => void
  align?: 'start' | 'end' | 'center'
  /** 图标模式：放在卡片/缩略图角标上，不占文字宽度 */
  compact?: boolean
}) {
  const { message } = App.useApp()
  if (!url) return null

  const mediaKind: MediaKind = kind === 'video' || kind === 'audio' ? kind : 'image'
  const fallbackName = mediaKind === 'video' ? '视频' : mediaKind === 'audio' ? '音频' : '图片'

  const download = async () => {
    const { ok, failed } = await downloadResults([{
      url,
      kind: mediaKind,
      name: name || fallbackName,
    }])
    if (ok > 0) message.success('已开始下载')
    else if (failed > 0) message.error('下载失败（链接可能已过期）')
  }

  const copy = async () => {
    try {
      const res = await copyMediaToClipboard(url, mediaKind)
      message.success(res.message)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '复制失败')
    }
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 ${align === 'start' ? 'justify-start' : align === 'center' ? 'justify-center' : 'justify-end'}`}>
      <Button
        size="small"
        type={compact ? 'text' : 'default'}
        icon={<DownloadOutlined />}
        title="下载"
        aria-label="下载"
        onClick={() => void download()}
      >
        {compact ? null : '下载'}
      </Button>
      {mediaKind === 'image' && (
        <Button
          size="small"
          type={compact ? 'text' : 'default'}
          icon={<CopyOutlined />}
          title="复制图片/GIF"
          aria-label="复制"
          onClick={() => void copy()}
        >
          {compact ? null : '复制'}
        </Button>
      )}
      {onClose && (
        <Button
          size="small"
          type="text"
          icon={<CloseOutlined />}
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          {compact ? null : '关闭'}
        </Button>
      )}
    </div>
  )
}
