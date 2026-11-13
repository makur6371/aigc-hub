'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'

/**
 * 顶部导航进度条（YouTube 风格细条）。
 * 客户端路由跳转时立刻出现并缓慢推进，路由切换完成（pathname 变化）后快速跑满并淡出。
 * 解决「点击导航后前几百毫秒没有任何反馈，以为没点上」的问题。
 *
 * 触发方式有两种：
 * 1. 捕获 <a href> 的 pointerdown（Link / 普通链接，覆盖面最广）
 * 2. 监听 NAV_START_EVENT 自定义事件（NavRail 等用 router.push 的按钮主动派发）
 */
export const NAV_START_EVENT = 'aigc-hub:nav-start'

export function NavProgressBar() {
  const pathname = usePathname()
  const [visible, setVisible] = useState(false)
  const [progress, setProgress] = useState(0)
  const timersRef = useRef<number[]>([])
  const firstRenderRef = useRef(true)

  const clearTimers = () => {
    timersRef.current.forEach((t) => window.clearTimeout(t))
    timersRef.current = []
  }

  const start = useCallback(() => {
    clearTimers()
    setVisible(true)
    setProgress(8)
    // 缓慢逼近 90%，给用户「正在加载」的持续反馈
    const steps = [30, 55, 72, 85, 90]
    steps.forEach((p, i) => {
      timersRef.current.push(window.setTimeout(() => setProgress(p), 120 * (i + 1)))
    })
  }, [])

  // 捕获全局链接点击（含 router.push 之外的 <a>/<Link>），点击瞬间即开始推进
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!anchor) return
      const href = anchor.getAttribute('href') || ''
      if (!href || href.startsWith('http') || href.startsWith('#') || anchor.target === '_blank') return
      if (href === pathname) return
      start()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    // router.push 场景（button 而非 <a>）：由调用方派发自定义事件
    const onNavStart = () => start()
    window.addEventListener(NAV_START_EVENT, onNavStart)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener(NAV_START_EVENT, onNavStart)
    }
  }, [pathname, start])

  // 路由切换完成：跑满并淡出
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false
      return
    }
    clearTimers()
    setVisible(true)
    setProgress(100)
    timersRef.current.push(window.setTimeout(() => setVisible(false), 220))
    timersRef.current.push(window.setTimeout(() => setProgress(0), 420))
  }, [pathname])

  useEffect(() => () => clearTimers(), [])

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-[3px]"
      style={{ opacity: visible ? 1 : 0, transition: 'opacity 200ms ease' }}
    >
      <div
        className="h-full rounded-r-full"
        style={{
          width: `${progress}%`,
          background: 'linear-gradient(90deg, #7D50E0 0%, #A97BF0 60%, #C4AEF9 100%)',
          boxShadow: '0 0 8px rgba(125,80,224,0.55)',
          transition: 'width 200ms ease',
        }}
      />
    </div>
  )
}
