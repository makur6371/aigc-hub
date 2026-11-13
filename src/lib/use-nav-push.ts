'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { NAV_START_EVENT } from '@/components/layout/NavProgressBar'

/**
 * 带「即时反馈」的路由跳转。
 *
 * 问题：`router.push` 在按钮（非 <a href>）上使用时，顶部进度条捕获不到点击，
 * 用户点击后到新页面渲染出来之间完全没有视觉反馈，感觉「没点上」。
 *
 * 用法：把 `router.push(x)` 换成 `navigate(x)` 即可（组件内 `const navigate = useNavPush()`）。
 * 会先派发 NAV_START_EVENT 让进度条立刻出现并推进，再执行跳转。
 */
export function useNavPush() {
  const router = useRouter()
  return useCallback((href: string) => {
    // 派发进度条开始事件（NavProgressBar 监听），给用户即时反馈
    window.dispatchEvent(new Event(NAV_START_EVENT))
    router.push(href)
  }, [router])
}
