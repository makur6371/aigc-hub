'use client'

// 工具执行页：/tools/[slug]
// 三段式骨架（成果区 · 工作台 · 操作面板）全在 ToolStudio 里，
// 这里只负责「把路径里的 slug 传进去 + 声明身份是工具」。
import { useParams } from 'next/navigation'
import ToolStudio from '@/components/tools/ToolStudio'

export default function ToolRunPage() {
  const params = useParams<{ slug: string }>()
  return <ToolStudio mode="tool" toolSlug={params?.slug ?? ''} />
}
