'use client'

import { useState } from 'react'
import { Typography, Button, Tooltip } from 'antd'
import { CopyOutlined, CheckOutlined } from '@ant-design/icons'

const { Text, Paragraph } = Typography

interface CodeTemplateBlockProps {
  title: string
  code: string
  description?: string
  /** 代码块最大高度，默认 240 */
  maxHeight?: number
}

/**
 * 代码模板展示块：标题 + 规范说明 + 只读代码 + 一键复制。
 * 用于 Adapter / 智能体 / 画布节点的代码块导入区，
 * 方便把模板复制给其他 AI 编写，写完再粘贴回导入框。
 */
export function CodeTemplateBlock({ title, code, description, maxHeight = 240 }: CodeTemplateBlockProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板不可用时静默失败
    }
  }

  return (
    <div className="mb-4 rounded-lg border border-border bg-surface overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-white">
        <Text strong className="text-sm">{title}</Text>
        <Tooltip title={copied ? '已复制' : '复制模板'}>
          <Button
            type="text"
            size="small"
            icon={copied ? <CheckOutlined className="text-success" /> : <CopyOutlined />}
            onClick={handleCopy}
          >
            <span className="text-xs">{copied ? '已复制' : '复制模板'}</span>
          </Button>
        </Tooltip>
      </div>
      {description && (
        <div className="px-3 py-2 border-b border-border">
          <Paragraph className="!mb-0 text-xs text-text-secondary leading-relaxed whitespace-pre-line">
            {description}
          </Paragraph>
        </div>
      )}
      <pre
        className="font-mono text-xs leading-relaxed text-foreground p-3 overflow-auto aigc-hub-scrollbar m-0"
        style={{ maxHeight }}
      >
        {code}
      </pre>
    </div>
  )
}
