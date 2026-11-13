'use client'

// 创作工作区（/create）：图像生成 / 视频生成 的沉浸式 composer 试点入口。
//
// 为什么复用 ToolStudio：三段式骨架（成果区·工作台·输入）、运行队列、拖拽、
// 移动端适配全在里面；composer 只是面板渲染层的切换（tools.tags='composer'）。
// 这里只负责「工具切换 chip + 把 slug 传进去」，和 /tools/[slug] 页同一模式。

import { useEffect, useState } from 'react'
import ToolStudio from '@/components/tools/ToolStudio'
import { CREATE_TOOLS } from '@/lib/create-tools'
import { readLocalText, writeLocalText } from '@/lib/local-store'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import type { CreateMode } from '@/components/tools/CreateModePicker'

const LAST_CREATE_LS_KEY = 'aigc-hub:create:last'

function initialSlug(): string {
  try {
    const saved = readLocalText(LAST_CREATE_LS_KEY)
    if (saved && CREATE_TOOLS.some((t) => t.slug === saved)) return saved
  } catch { /* ignore */ }
  return CREATE_TOOLS[0].slug
}

function CreateWorkspace() {
  const searchParams = useSearchParams()
  const requested = CREATE_TOOLS.find((entry) => entry.href === `/create/${searchParams.get('kind')}`)
  const [slug, setSlug] = useState(() => requested?.slug ?? initialSlug())
  const initialMode: CreateMode = searchParams.get('kind') === 'agent' ? 'agent' : requested?.href === '/create/image' ? 'image' : requested?.href === '/create/video' ? 'video' : slug === CREATE_TOOLS.find((entry) => entry.href === '/create/image')?.slug ? 'image' : 'video'
  const [mode, setMode] = useState<CreateMode>(initialMode)
  const [visited, setVisited] = useState<CreateMode[]>([initialMode])

  // 切换工具写回本地（下次进 /create 直达上次用的）
  useEffect(() => {
    writeLocalText(LAST_CREATE_LS_KEY, slug)
  }, [slug])

  const changeMode = (next: CreateMode) => {
    setMode(next)
    setVisited((previous) => previous.includes(next) ? previous : [...previous, next])
    const entry = CREATE_TOOLS.find((item) => item.href === `/create/${next}`)
    if (entry) setSlug(entry.slug)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        {visited.includes('agent') && <div className={mode === 'agent' ? 'h-full motion-safe:animate-[canvasPanelIn_180ms_ease-out]' : 'hidden'}><ToolStudio mode="agent" createMode="agent" onCreateModeChange={changeMode} /></div>}
        {CREATE_TOOLS.map((entry) => {
          const entryMode: CreateMode = entry.href === '/create/image' ? 'image' : 'video'
          return visited.includes(entryMode) && <div key={entry.slug} className={mode === entryMode ? 'h-full motion-safe:animate-[canvasPanelIn_180ms_ease-out]' : 'hidden'}><ToolStudio mode="tool" toolSlug={entry.slug} createMode={entryMode} onCreateModeChange={changeMode} /></div>
        })}
      </div>
    </div>
  )
}

export default function CreatePage() {
  return <Suspense><CreateWorkspace /></Suspense>
}
